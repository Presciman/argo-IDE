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
}

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  model: string
  agentId: string
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
