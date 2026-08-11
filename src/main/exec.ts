import { WebContents } from 'electron'
import * as pty from 'node-pty'
import { realpath } from 'fs/promises'
import { ExecRequest, ExecResult } from '../shared/types'
import { denyReason } from '../shared/policy'
import { childEnv } from './settings'
import { defaultShell, workingDirectory } from './terminal'

/**
 * Commands run by the AI Agent.
 *
 * Each command gets its own short-lived PTY rooted in the folder open in the
 * Explorer. The bottom terminal panel is deliberately untouched: it belongs to
 * the user, it holds their shell state and half-typed lines, and command
 * boundaries there are not observable. A private PTY gives clean capture and
 * makes "the agent cannot type into my terminal" true by construction.
 *
 * A PTY rather than child_process.exec because plenty of tools (git, npm, test
 * runners) only produce their normal output when they believe they are on a
 * terminal.
 */

/** Wall-clock ceiling for one command. */
const TIMEOUT_MS = 120_000
/** Captured output cap. The model gets the head; the tail is dropped. */
const MAX_OUTPUT_BYTES = 100 * 1024

interface Running {
  term: pty.IPty
  /** Cleared on exit so the timeout cannot kill a reused pid. */
  timer: NodeJS.Timeout
}

const running = new Map<string, Running>()

/**
 * Run one command and resolve when it exits.
 *
 * Rejects rather than resolving for setup failures (bad cwd, unrunnable shell)
 * so the caller can distinguish "the command failed" from "we never ran it".
 */
export async function run(sender: WebContents, req: ExecRequest): Promise<ExecResult> {
  const command = req.command.trim()
  if (!command) throw new Error('Empty command.')

  // Second gate. The renderer decides whether to *show* an approval prompt;
  // this decides whether the command may run at all. A renderer bug — or a
  // model talking a confused renderer into skipping the prompt — still cannot
  // get an unapproved sudo past here.
  const risky = denyReason(command)
  if (risky && !req.userApproved) {
    throw new Error(`Refused without explicit approval: ${risky}`)
  }

  // Commands are confined to the folder the user opened. realpath() resolves
  // symlinks so the cwd cannot be a link pointing somewhere else.
  let cwd: string
  try {
    cwd = await realpath(req.cwd)
  } catch {
    throw new Error('The project folder is not available.')
  }
  if (workingDirectory(cwd) !== cwd) {
    throw new Error('The project folder is not a readable directory.')
  }

  kill(req.id)

  const startedAt = Date.now()
  let term: pty.IPty
  try {
    // -l would run the login profile and print the user's MOTD/banner into
    // every capture; -c alone keeps output to just the command.
    term = pty.spawn(defaultShell(), ['-c', command], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env: childEnv() as { [key: string]: string }
    })
  } catch (err) {
    throw new Error(`Could not start the command: ${(err as Error).message}`)
  }

  return new Promise<ExecResult>((resolve) => {
    let output = ''
    let truncated = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      term.kill()
    }, TIMEOUT_MS)

    running.set(req.id, { term, timer })

    term.onData((chunk) => {
      if (!sender.isDestroyed()) sender.send(`agent:exec:data:${req.id}`, chunk)
      if (truncated) return
      if (output.length + chunk.length > MAX_OUTPUT_BYTES) {
        output += chunk.slice(0, MAX_OUTPUT_BYTES - output.length)
        truncated = true
        return
      }
      output += chunk
    })

    term.onExit(({ exitCode, signal }) => {
      clearTimeout(timer)
      if (running.get(req.id)?.term === term) running.delete(req.id)
      resolve({
        // A killed process reports exit 0 with a signal on some platforms;
        // surface that as a failure rather than a silent success.
        exitCode: timedOut ? 124 : signal && exitCode === 0 ? 128 + signal : exitCode,
        output,
        truncated,
        timedOut,
        durationMs: Date.now() - startedAt
      })
    })
  })
}

/** Stop one command, e.g. when the user presses Stop mid-turn. */
export function kill(id: string): void {
  const entry = running.get(id)
  if (!entry) return
  clearTimeout(entry.timer)
  running.delete(id)
  entry.term.kill()
}

/** Don't leave agent commands running past quit. */
export function killAll(): void {
  for (const id of [...running.keys()]) kill(id)
}
