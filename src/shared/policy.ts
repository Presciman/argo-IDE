import { AgentMode, ToolCall } from './types'

/**
 * What the agent may do without asking.
 *
 * One implementation, used twice: the renderer consults it to decide whether to
 * show an approval prompt, and the main process re-checks it before running a
 * command. The renderer copy is a UI decision; the main-process copy is the
 * enforcement. A renderer that skipped the prompt still cannot run `sudo`.
 */

/**
 * Commands that always prompt, in every mode — including full access.
 *
 * These are the operations whose blast radius reaches outside the project, or
 * that are hard to undo. Full access means "don't interrupt me for ordinary
 * work", not "act without me on anything at all".
 */
export interface DenyReason {
  /** Shown to the user in the approval prompt. */
  reason: string
}

/** Strip quotes so `"sudo"` and `'rm'` tokenize like their bare forms. */
function unquote(token: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(token)
  return quoted ? quoted[2] : token
}

/**
 * Split a shell command into tokens, then into pipeline/list segments.
 *
 * This is not a shell parser and does not try to be: it exists to find risky
 * commands hiding behind `&&`, `;`, and pipes. Anything it cannot confidently
 * read is treated as risky, so failure lands on the side of asking the user.
 */
function segments(command: string): string[][] {
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []
  const out: string[][] = [[]]
  for (const raw of tokens) {
    if (raw === '|' || raw === '||' || raw === '&&' || raw === ';' || raw === '&') {
      out.push([])
      continue
    }
    out[out.length - 1].push(unquote(raw))
  }
  return out.filter((s) => s.length > 0)
}

/** The command word of a segment, ignoring `VAR=value` prefixes and `env`. */
function head(segment: string[]): string {
  let index = 0
  while (index < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index])) index += 1
  if (segment[index] === 'env') {
    index += 1
    while (index < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index])) index += 1
  }
  // `/usr/bin/sudo` and `sudo` are the same thing to us.
  return (segment[index] ?? '').split('/').pop() ?? ''
}

const ESCALATION = new Set(['sudo', 'su', 'doas', 'pkexec'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh'])
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch'])
const SYSTEM = new Set(['shutdown', 'reboot', 'halt', 'poweroff'])

/** Paths that are never safe to recursively delete or write into. */
const SENSITIVE_DIRS = ['~/.ssh', '~/.claude', '~/.aws', '~/.gnupg', '~/.config']

/** True when an `rm -r` target is not clearly confined to the project. */
function dangerousRemoveTarget(target: string): boolean {
  if (target.startsWith('-')) return false
  if (target === '/' || target === '~' || target === '.' || target === '..') return true
  if (target.startsWith('/') || target.startsWith('~')) return true
  if (target.startsWith('..')) return true
  // Globs can expand to anything; we cannot evaluate them here.
  if (target.includes('*') || target.includes('?')) return true
  return false
}

/**
 * Why this command always needs confirmation, or null when it is ordinary.
 *
 * Exported so both the approval prompt and the main-process guard give the
 * user the same explanation.
 */
export function denyReason(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null

  // Command substitution can hide an arbitrary second command inside an
  // otherwise innocent-looking one. We cannot see into it, so we ask.
  if (/\$\(|`/.test(trimmed)) {
    return 'Contains a command substitution, whose contents cannot be checked.'
  }

  const parts = segments(trimmed)

  for (let index = 0; index < parts.length; index += 1) {
    const segment = parts[index]
    const command0 = head(segment)

    if (ESCALATION.has(command0)) {
      return `Runs with elevated privileges (${command0}).`
    }
    if (SYSTEM.has(command0)) {
      return `Affects the whole machine (${command0}).`
    }

    if (command0 === 'rm') {
      const flags = segment.filter((t) => t.startsWith('-')).join('')
      const recursive = /r/i.test(flags)
      const targets = segment.slice(1).filter((t) => !t.startsWith('-'))
      if (recursive && (targets.length === 0 || targets.some(dangerousRemoveTarget))) {
        return 'Recursively deletes a path that may lie outside the project.'
      }
    }

    if (command0 === 'git') {
      const sub = segment.find((t, i) => i > 0 && !t.startsWith('-'))
      if (sub === 'push') return 'Publishes commits to a remote.'
      if (sub === 'clean') return 'Deletes untracked files.'
      if (sub === 'reset' && segment.includes('--hard')) {
        return 'Discards uncommitted work (git reset --hard).'
      }
    }

    if (command0 === 'chmod' && segment.some((t) => /^-?(0?777|a\+rwx)$/.test(t))) {
      return 'Makes a path world-writable.'
    }

    // A downloader feeding a shell is the classic remote-code-execution shape.
    if (DOWNLOADERS.has(command0)) {
      const next = parts[index + 1]
      if (next && SHELLS.has(head(next))) {
        return 'Pipes downloaded content straight into a shell.'
      }
    }

    if (segment.some((t) => SENSITIVE_DIRS.some((dir) => t === dir || t.startsWith(`${dir}/`)))) {
      return 'Touches credentials or configuration outside the project.'
    }

    if (command0 === 'kill' || command0 === 'killall' || command0 === 'pkill') {
      return 'Signals processes outside this app.'
    }
  }

  return null
}

/**
 * Whether this call must be shown to the user before it runs.
 *
 * `turnOverride` is set when the user chose "Allow all this turn"; it raises
 * the effective mode for the rest of that turn only and is never persisted.
 */
export function needsApproval(
  call: ToolCall,
  mode: AgentMode,
  turnOverride = false
): { required: boolean; reason?: string } {
  if (call.tool === 'ask_user') return { required: false }

  if (call.tool === 'run') {
    const reason = denyReason(call.command)
    // The denylist outranks both the mode and the per-turn override.
    if (reason) return { required: true, reason }
  }

  const effective: AgentMode = turnOverride ? 'full' : mode
  if (effective === 'full') return { required: false }
  if (effective === 'approve') return { required: call.tool !== 'read_file' }
  return { required: true }
}
