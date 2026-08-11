/** Types shared between the main process, the preload bridge, and the renderer. */

// ---------------------------------------------------------------- settings

export interface AppSettings {
  /** CELS username. Exported as CELS_USERNAME to every argo-shim / terminal child. */
  celsUsername: string
  /**
   * Whether to route Argo traffic through a local argo-shim.
   * Off means "I'm already on the ANL intranet" and requests go straight to
   * `directBaseUrl`. The app never guesses this — the user decides.
   */
  useShim: boolean
  /** Override the shim's username-derived port. 0 means "derive it". */
  shimPort: number
  /** Base URL used when `useShim` is false (intranet, no tunnel needed). */
  directBaseUrl: string
  /** Command used to launch the shim. Usually `argo-shim` or `uvx argo-shim`. */
  shimCommand: string
  /** Extra CLI flags passed to the shim on connect, e.g. `--port 8083`. */
  shimArgs: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  celsUsername: '',
  useShim: true,
  shimPort: 0,
  directBaseUrl: 'https://apps.inside.anl.gov/argoapi',
  shimCommand: 'argo-shim',
  shimArgs: ''
}

// ---------------------------------------------------------------- filesystem

export interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
}

/** A directory the user has explicitly granted the agent access to. */
export interface FolderGrant {
  path: string
  name: string
}

export interface Attachment {
  id: string
  name: string
  path: string
  /** UTF-8 text for text files; omitted when the file is binary or too large. */
  text?: string
  bytes: number
  /** Set when the file could not be inlined, explaining why. */
  skipped?: string
}

/** Recursive snapshot of the folder currently open in the Explorer. */
export interface ProjectContext {
  root: string
  name: string
  tree: string
  fileCount: number
  directoryCount: number
  truncated: boolean
  /** Generated/dependency directories shown but not expanded in the prompt. */
  excludedDirectories: string[]
}

/** A bounded text-file read requested by the AI Agent inside the open project. */
export interface ProjectFile {
  relativePath: string
  content: string
  bytes: number
  truncated: boolean
}

// ---------------------------------------------------------------- chat

export type Role = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: Role
  content: string
  /** Wall-clock ms. Stamped by the renderer when the message is created. */
  createdAt: number
  /** Present on user messages that carried attachments. */
  attachments?: Attachment[]
  /** Set on an assistant message that failed, instead of content. */
  error?: string
  /**
   * What the agent did to produce this reply: reasoning, file reads, writes,
   * and commands. Rendered live in the trace panel, then collapsed onto the
   * finished message. Absent on messages written before traces existed.
   */
  trace?: TraceStep[]
  /** Total wall-clock ms the turn took. Shown in the collapsed summary. */
  durationMs?: number
}

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  model: string
  agentId: string
  /** Absent in sessions saved before agent modes existed; treated as 'manual'. */
  mode?: AgentMode
  messages: ChatMessage[]
}

export interface SessionSummary {
  id: string
  title: string
  updatedAt: number
  messageCount: number
}

export interface ArgoModel {
  id: string
  /** Argo's own internal id — what the API actually wants. */
  internalId?: string
}

/** A local system-prompt preset. Not an Argo concept. */
export interface AgentPreset {
  id: string
  name: string
  description: string
  systemPrompt: string
}

// --------------------------------------------------------------- agent tools

/**
 * How much the agent may do without stopping to ask.
 *
 * The mode is a property of a chat session, not of the app: "full access" in a
 * scratch directory should never silently carry over to tomorrow's work.
 */
export type AgentMode = 'manual' | 'approve' | 'full'

export const AGENT_MODES: { id: AgentMode; name: string; description: string }[] = [
  {
    id: 'manual',
    name: 'Manual',
    description: 'Confirm every file read, file write, and command.'
  },
  {
    id: 'approve',
    name: 'Approve for me',
    description: 'Reads happen automatically. Writes and commands need your approval.'
  },
  {
    id: 'full',
    name: 'Full access',
    description: 'Reads, writes, and commands run unattended. Risky commands still ask.'
  }
]

/** A tool invocation parsed out of an assistant message. */
export type ToolCall =
  | { tool: 'read_file'; path: string }
  | { tool: 'write_file'; path: string; content: string }
  | { tool: 'run'; command: string; why?: string }
  | { tool: 'ask_user'; question: string; placeholder?: string }

export type ToolName = ToolCall['tool']

/** What a tool produced, in the form fed back to the model. */
export interface ToolResult {
  ok: boolean
  /** Text handed back to the model as the next user turn. */
  text: string
  /** Short human-readable outcome for the trace, e.g. "4.1 KB" or "exit 0". */
  detail?: string
}

/** One line in the live progress panel. */
export interface TraceStep {
  id: string
  kind: 'reasoning' | 'read' | 'write' | 'run' | 'ask' | 'info' | 'error'
  /** Single-line label, e.g. `read src/main/chat.ts`. */
  label: string
  status: 'running' | 'done' | 'failed' | 'denied'
  /** Right-aligned annotation: `4.1 KB`, `+18 −4`, `exit 0`. */
  detail?: string
  /** Long output (command stdout, reasoning text) shown when expanded. */
  body?: string
  startedAt: number
  endedAt?: number
}

/** A blocking question the agent is waiting on, rendered inline in the log. */
export type PendingInteraction =
  | { kind: 'approval'; id: string; call: ToolCall; diff?: DiffSummary; reason?: string }
  | { kind: 'question'; id: string; question: string; placeholder?: string }

export type ApprovalChoice = 'allow' | 'allow-all' | 'deny'

/** Line counts and a bounded preview for a proposed write. */
export interface DiffSummary {
  added: number
  removed: number
  /** True when the target does not exist yet. */
  created: boolean
  preview: DiffLine[]
  previewTruncated: boolean
}

export interface DiffLine {
  kind: 'add' | 'remove' | 'context'
  text: string
}

/** Result of one agent-run command. */
export interface ExecResult {
  exitCode: number
  output: string
  /** Output exceeded the capture cap and was cut short. */
  truncated: boolean
  /** The command hit the wall-clock limit and was killed. */
  timedOut: boolean
  durationMs: number
}

export interface ExecRequest {
  id: string
  command: string
  /** Commands always run in the folder open in the Explorer. */
  cwd: string
  /**
   * Set only after the user approved this exact command. Commands on the
   * always-ask denylist are refused by the main process without it, whatever
   * the renderer believes the current mode to be.
   */
  userApproved: boolean
}

/** Written file, with the counts needed to describe the change afterwards. */
export interface WriteResult {
  relativePath: string
  created: boolean
  bytes: number
}

// ---------------------------------------------------------------- connection

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ShimStatus {
  state: ConnectionState
  /** Resolved base URL currently in use (shim or direct). */
  baseUrl: string
  /** Port the shim is expected on. 0 in direct mode. */
  port: number
  /** True when a token was found in ~/.claude/settings.json. */
  hasToken: boolean
  message: string
  /** True when this app started the shim and holds its PTY. */
  ownsProcess: boolean
}

/** A process currently listening on the shim's port. */
export interface ShimOccupant {
  pid: number
  /** Process name from lsof, e.g. `argo-shim` or `python3.12`. */
  command: string
  /** True when this app started it, rather than an earlier run or a terminal. */
  isOurs: boolean
}

// ---------------------------------------------------------------- streaming

/** Chunks pushed from main -> renderer over a per-request IPC channel. */
export type StreamEvent =
  | { type: 'delta'; text: string }
  /**
   * Chain-of-thought from a reasoning model, when the provider sends it.
   * Best-effort: most models emit none, and the trace then shows only the
   * steps ArgoIDE itself performs. Never synthesized.
   */
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface ChatRequest {
  requestId: string
  model: string
  messages: { role: Role; content: string }[]
}

// ---------------------------------------------------------------- terminal

export interface PtySpawnOptions {
  id: string
  cwd?: string
  cols: number
  rows: number
}
