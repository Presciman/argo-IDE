import { WebContents } from 'electron'
import * as pty from 'node-pty'
import { accessSync, constants, statSync } from 'fs'
import { userInfo } from 'os'
import { PtySpawnOptions } from '../shared/types'
import { childEnv } from './settings'

/**
 * Local shell sessions for the bottom terminal panel.
 *
 * Each terminal gets CELS_USERNAME/ARGO_USER exported, so running `argo-shim`
 * or `claude` by hand from here behaves the same as the Connect button.
 */

const sessions = new Map<string, pty.IPty>()

function defaultShell(): string {
  const candidates = [
    process.env.SHELL,
    process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
    '/bin/sh'
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next known system shell.
    }
  }
  return '/bin/sh'
}

function workingDirectory(requested?: string): string {
  const fallback = userInfo().homedir
  if (!requested) return fallback
  try {
    if (statSync(requested).isDirectory()) {
      accessSync(requested, constants.R_OK | constants.X_OK)
      return requested
    }
  } catch {
    // A removed explorer root should not crash the Electron main process.
  }
  return fallback
}

export function spawn(sender: WebContents, opts: PtySpawnOptions): void {
  kill(opts.id)

  let term: pty.IPty
  try {
    term = pty.spawn(defaultShell(), ['-l'], {
      name: 'xterm-256color',
      cols: Math.max(1, opts.cols),
      rows: Math.max(1, opts.rows),
      cwd: workingDirectory(opts.cwd),
      env: childEnv() as { [key: string]: string }
    })
  } catch (err) {
    const message = `Could not start the local terminal: ${(err as Error).message}`
    console.error(message, err)
    if (!sender.isDestroyed()) {
      sender.send(`terminal:data:${opts.id}`, `\r\n\x1b[31m${message}\x1b[0m\r\n`)
      sender.send(`terminal:exit:${opts.id}`, 1)
    }
    return
  }

  term.onData((data) => {
    if (!sender.isDestroyed()) sender.send(`terminal:data:${opts.id}`, data)
  })

  const onSenderDestroyed = (): void => kill(opts.id)

  term.onExit(({ exitCode }) => {
    if (sessions.get(opts.id) === term) sessions.delete(opts.id)
    sender.removeListener('destroyed', onSenderDestroyed)
    if (!sender.isDestroyed()) sender.send(`terminal:exit:${opts.id}`, exitCode)
  })

  // A renderer can disappear without React getting a chance to send
  // terminal:kill (for example when one of several windows is closed).
  sender.once('destroyed', onSenderDestroyed)

  sessions.set(opts.id, term)
}

export function write(id: string, data: string): void {
  sessions.get(id)?.write(data)
}

export function resize(id: string, cols: number, rows: number): void {
  // A PTY rejects zero dimensions, which happens transiently while the pane
  // is being dragged or the window is hidden.
  if (cols > 0 && rows > 0) sessions.get(id)?.resize(cols, rows)
}

export function kill(id: string): void {
  sessions.get(id)?.kill()
  sessions.delete(id)
}

export function killAll(): void {
  for (const term of sessions.values()) term.kill()
  sessions.clear()
}
