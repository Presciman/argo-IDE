import { WebContents } from 'electron'
import * as pty from 'node-pty'
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
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
}

export function spawn(sender: WebContents, opts: PtySpawnOptions): void {
  kill(opts.id)

  const term = pty.spawn(defaultShell(), ['-l'], {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd || userInfo().homedir,
    env: childEnv() as { [key: string]: string }
  })

  term.onData((data) => {
    if (!sender.isDestroyed()) sender.send(`terminal:data:${opts.id}`, data)
  })

  term.onExit(({ exitCode }) => {
    sessions.delete(opts.id)
    if (!sender.isDestroyed()) sender.send(`terminal:exit:${opts.id}`, exitCode)
  })

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
