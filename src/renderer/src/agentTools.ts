import { AgentMode, ProjectContext, ToolCall } from '../../shared/types'

/**
 * The AI Agent's tool protocol.
 *
 * Tools are requested as a fenced JSON block at the end of a message rather
 * than through OpenAI-style function calling. `chat.ts` deliberately talks to
 * `/v1/chat/completions` because that is the one path argo-shim normalizes
 * across Claude, GPT, and Gemini; whether every one of those models has tool
 * calling wired through Argo is not something we can rely on. A text protocol
 * behaves identically on all of them. Parsing is confined to this file so the
 * transport can be swapped later without touching the agent loop.
 */

export const TOOL_FENCE = 'argo-tool'

/** Emitted by the model to invoke a tool. */
const FENCE_PATTERN = /```argo-tool\s*\n([\s\S]*?)```/gi

export interface ParsedReply {
  /** The message text with the tool block removed, safe to show the user. */
  prose: string
  /** The tool the model wants to run, if the block parsed. */
  call?: ToolCall
  /** Set when a block was present but unusable; fed back to the model. */
  parseError?: string
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** Validate a decoded block into a ToolCall, or explain why it isn't one. */
function toToolCall(raw: unknown): { call?: ToolCall; error?: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { error: 'The argo-tool block must contain a JSON object.' }
  }
  const record = raw as Record<string, unknown>
  const tool = asString(record.tool)

  switch (tool) {
    case 'read_file': {
      const path = asString(record.path)
      return path
        ? { call: { tool: 'read_file', path } }
        : { error: 'read_file requires a non-empty "path".' }
    }
    case 'write_file': {
      const path = asString(record.path)
      // An empty string is a legitimate write (truncating a file), so this
      // checks the type rather than using asString.
      const content = record.content
      if (!path) return { error: 'write_file requires a non-empty "path".' }
      if (typeof content !== 'string') {
        return { error: 'write_file requires "content" as a string.' }
      }
      return { call: { tool: 'write_file', path, content } }
    }
    case 'run': {
      const command = asString(record.command)
      const why = asString(record.why)
      return command
        ? { call: { tool: 'run', command, ...(why ? { why } : {}) } }
        : { error: 'run requires a non-empty "command".' }
    }
    case 'ask_user': {
      const question = asString(record.question)
      const placeholder = asString(record.placeholder)
      return question
        ? { call: { tool: 'ask_user', question, ...(placeholder ? { placeholder } : {}) } }
        : { error: 'ask_user requires a non-empty "question".' }
    }
    default:
      return {
        error: `Unknown tool "${tool ?? '(missing)'}". Use read_file, write_file, run, or ask_user.`
      }
  }
}

/**
 * Pull the tool call out of an assistant message.
 *
 * The last block wins: a model that narrates an example before making its real
 * request should not have the example executed.
 */
export function parseReply(text: string): ParsedReply {
  const matches = [...text.matchAll(FENCE_PATTERN)]
  if (matches.length === 0) return { prose: text.trim() }

  const last = matches[matches.length - 1]
  const prose = text.replace(last[0], '').trim()

  try {
    const { call, error } = toToolCall(JSON.parse(last[1]))
    return error ? { prose, parseError: error } : { prose, call }
  } catch (err) {
    return { prose, parseError: `Malformed JSON in the argo-tool block: ${(err as Error).message}` }
  }
}

/**
 * True once a complete tool block has arrived.
 *
 * The loop uses this to cut the stream short: everything the model writes after
 * closing the fence is unusable, and stopping saves both tokens and the user's
 * time waiting for a reply that has already said what it wants.
 */
export function hasCompleteToolCall(text: string): boolean {
  FENCE_PATTERN.lastIndex = 0
  return FENCE_PATTERN.test(text)
}

/** One-line description of a call, for the trace panel and approval prompts. */
export function describeCall(call: ToolCall): string {
  switch (call.tool) {
    case 'read_file':
      return `Read ${call.path}`
    case 'write_file':
      return `Write ${call.path}`
    case 'run':
      return `Run ${call.command}`
    case 'ask_user':
      return 'Ask you a question'
  }
}

/**
 * The tools section of the system prompt.
 *
 * Only the tools that can actually succeed right now are described. With no
 * folder open there is nothing to write to or run in, and offering tools that
 * always fail just invites the model to waste turns on them.
 */
export function toolInstructions(context: ProjectContext | null, mode: AgentMode): string {
  const lines: string[] = [
    'TOOLS',
    '',
    'You can act on the user\'s machine by ending a message with exactly one fenced block:',
    '',
    '```argo-tool',
    '{"tool": "read_file", "path": "src/main/chat.ts"}',
    '```',
    '',
    'Rules:',
    '- One tool call per message, always the last thing in the message.',
    '- Write a short sentence before the block saying what you are doing and why.',
    '- ArgoIDE runs the tool and sends you the result as the next message.',
    '- Never claim you read, wrote, or ran something until ArgoIDE returns its result.',
    '- When you are done, reply normally with no tool block.',
    ''
  ]

  lines.push('Available tools:')
  if (context) {
    lines.push(
      '- read_file  {"tool":"read_file","path":"relative/path.ts"} — read a text file in the project.',
      '- write_file {"tool":"write_file","path":"relative/path.ts","content":"<full file contents>"} —',
      '  create or overwrite a file. You must supply the ENTIRE file, not a patch or a diff.',
      '  Read the file first unless you are creating it.',
      `- run        {"tool":"run","command":"npm test","why":"check the suite passes"} — run a shell`,
      `  command in ${context.root}. It runs in its own shell, so \`cd\` does not persist between calls.`,
      '  Output is truncated at 100 KB and the command is killed after 120 seconds.'
    )
  } else {
    lines.push(
      '- read_file is unavailable: no project folder is open in the Explorer.',
      '- write_file and run are unavailable until the user opens a folder.'
    )
  }
  lines.push(
    '- ask_user   {"tool":"ask_user","question":"Which port should the shim use?"} — stop and ask the',
    '  user. Use this when a choice is genuinely theirs, not for things you can determine yourself.'
  )

  lines.push('', 'PERMISSIONS', '')
  if (mode === 'manual') {
    lines.push(
      'The user is in Manual mode: every read, write, and command is shown to them for approval',
      'before it runs. Expect some to be denied — if one is, adapt rather than retrying it.'
    )
  } else if (mode === 'approve') {
    lines.push(
      'The user is in Approve mode: reads happen automatically, but each write and command is shown',
      'to them for approval first. Batch your work sensibly rather than making many tiny writes.'
    )
  } else {
    lines.push(
      'The user is in Full access mode: reads, writes, and commands run without interruption.',
      'Commands that are risky or reach outside the project are still shown to them.',
      'Be correspondingly careful — prefer reading before writing, and check your work afterwards.'
    )
  }

  return lines.join('\n')
}
