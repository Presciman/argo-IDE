import {
  AgentMode,
  ApprovalChoice,
  DiffSummary,
  Role,
  ToolCall,
  ToolResult,
  TraceStep
} from '../../shared/types'
import { needsApproval } from '../../shared/policy'
import { summarizeDiff } from '../../shared/diff'
import { describeCall, hasCompleteToolCall, parseReply } from './agentTools'

/**
 * Runs one agent turn: stream, act, repeat until the model stops asking for
 * tools.
 *
 * Written as a plain async loop rather than the callback recursion this
 * replaced, because the turn now has to be able to *pause* — on an approval
 * prompt or a question — and resume where it left off. `await` expresses that;
 * a stream callback calling itself cannot.
 */

export type WireMessage = { role: Role; content: string }

/** Stop after this many tool calls in one turn, so a loop cannot run forever. */
const MAX_STEPS = 24

const uid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** Thrown to unwind the loop when the user presses Stop. */
export class Cancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'Cancelled'
  }
}

export interface AgentLoopOptions {
  model: string
  systemPrompt: string
  /** Conversation so far, excluding the placeholder for this reply. */
  history: WireMessage[]
  /** Explorer root. Null disables every filesystem and command tool. */
  projectRoot: string | null
  mode: AgentMode
  /** Streaming prose for the visible assistant bubble. */
  onProse: (text: string) => void
  /** Called with a fresh copy of the trace whenever a step changes. */
  onTrace: (steps: TraceStep[]) => void
  /** Resolve with the user's choice. Reject/throw Cancelled to abort. */
  requestApproval: (call: ToolCall, diff?: DiffSummary, reason?: string) => Promise<ApprovalChoice>
  /** Resolve with the user's typed answer. */
  askUser: (question: string, placeholder?: string) => Promise<string>
}

export interface AgentLoopResult {
  /** Final assistant prose to display. */
  text: string
  trace: TraceStep[]
  durationMs: number
}

export class AgentLoop {
  private cancelled = false
  private activeRequestId: string | null = null
  private activeExecId: string | null = null
  private rejectPending: ((reason: Error) => void) | null = null
  private trace: TraceStep[] = []
  /** Set by "Allow all this turn"; deliberately not persisted anywhere. */
  private turnOverride = false

  constructor(private readonly options: AgentLoopOptions) {}

  /** Abort the turn: the network request, any command, and any open prompt. */
  cancel(): void {
    this.cancelled = true
    if (this.activeRequestId) window.api.chat.cancel(this.activeRequestId)
    if (this.activeExecId) window.api.agent.cancelExec(this.activeExecId)
    this.rejectPending?.(new Cancelled())
    this.rejectPending = null
  }

  // ------------------------------------------------------------------ trace

  private pushStep(step: Omit<TraceStep, 'id' | 'startedAt'>): string {
    const id = uid()
    this.trace.push({ ...step, id, startedAt: Date.now() })
    this.options.onTrace([...this.trace])
    return id
  }

  private updateStep(id: string, patch: Partial<TraceStep>): void {
    this.trace = this.trace.map((s) => (s.id === id ? { ...s, ...patch } : s))
    this.options.onTrace([...this.trace])
  }

  /**
   * Reasoning arrives as many small deltas. Appending them to one step keeps
   * the panel refreshing in place instead of growing a line per token.
   */
  private appendReasoning(id: string | null, text: string): string {
    if (id === null) {
      return this.pushStep({ kind: 'reasoning', label: 'Thinking', status: 'running', body: text })
    }
    const existing = this.trace.find((s) => s.id === id)
    this.updateStep(id, { body: (existing?.body ?? '') + text })
    return id
  }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new Cancelled()
  }

  // ----------------------------------------------------------------- stream

  /** One completion. Resolves with everything the model said. */
  private streamOnce(messages: WireMessage[]): Promise<string> {
    this.throwIfCancelled()
    const requestId = uid()
    this.activeRequestId = requestId

    return new Promise<string>((resolve, reject) => {
      let accumulated = ''
      let reasoningStep: string | null = null
      let settled = false
      let unsubscribe: (() => void) | null = null

      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        unsubscribe?.()
        this.activeRequestId = null
        this.rejectPending = null
        if (reasoningStep) this.updateStep(reasoningStep, { status: 'done', endedAt: Date.now() })
        fn()
      }

      // Stop() reaches the in-flight request through here.
      this.rejectPending = (err) => done(() => reject(err))

      unsubscribe = window.api.chat.send({ requestId, model: this.options.model, messages }, (event) => {
        if (this.cancelled) {
          done(() => reject(new Cancelled()))
          return
        }

        if (event.type === 'reasoning') {
          reasoningStep = this.appendReasoning(reasoningStep, event.text)
          return
        }
        if (event.type === 'usage') return

        if (event.type === 'delta') {
          accumulated += event.text
          this.options.onProse(accumulated)

          // The model has finished asking for a tool. Anything after the
          // closing fence is unusable, so stop paying for it.
          if (hasCompleteToolCall(accumulated)) {
            window.api.chat.cancel(requestId)
            done(() => resolve(accumulated))
          }
          return
        }

        if (event.type === 'error') {
          done(() => reject(new Error(event.message)))
          return
        }

        done(() => resolve(accumulated))
      })
    })
  }

  // ------------------------------------------------------------------ tools

  /** Read the current contents of a write target, or null when creating. */
  private async previousContent(root: string, path: string): Promise<string | null> {
    try {
      const file = await window.api.fs.readProjectFile(root, path)
      return file.content
    } catch {
      // Missing, binary, or outside the project. The write itself will fail
      // with a precise error if it's the last two; here it just means no diff.
      return null
    }
  }

  private async runTool(call: ToolCall, root: string | null): Promise<ToolResult> {
    this.throwIfCancelled()

    if (call.tool === 'ask_user') {
      const stepId = this.pushStep({ kind: 'ask', label: call.question, status: 'running' })
      const answer = await this.options.askUser(call.question, call.placeholder)
      this.updateStep(stepId, { status: 'done', endedAt: Date.now(), detail: 'answered' })
      return { ok: true, text: `The user answered:\n\n${answer}`, detail: 'answered' }
    }

    if (!root) {
      return {
        ok: false,
        text: 'No project folder is open in the Explorer, so this tool is unavailable. Ask the user to open a folder.',
        detail: 'no project'
      }
    }

    if (call.tool === 'read_file') {
      const stepId = this.pushStep({ kind: 'read', label: `Read ${call.path}`, status: 'running' })
      try {
        const file = await window.api.fs.readProjectFile(root, call.path)
        const detail = `${(file.bytes / 1024).toFixed(1)} KB${file.truncated ? ' (truncated)' : ''}`
        this.updateStep(stepId, { status: 'done', endedAt: Date.now(), detail })
        return {
          ok: true,
          detail,
          text:
            `ArgoIDE read this project file:\n<file path="${file.relativePath}"` +
            `${file.truncated ? ' truncated="true"' : ''}>\n${file.content}\n</file>`
        }
      } catch (err) {
        const message = (err as Error).message
        this.updateStep(stepId, { status: 'failed', endedAt: Date.now(), detail: message })
        return { ok: false, text: `Could not read "${call.path}": ${message}`, detail: message }
      }
    }

    if (call.tool === 'write_file') {
      const stepId = this.pushStep({ kind: 'write', label: `Write ${call.path}`, status: 'running' })
      try {
        const written = await window.api.agent.writeFile(root, call.path, call.content)
        const diff = summarizeDiff(written.previous, call.content)
        const detail = written.created ? `created · +${diff.added}` : `+${diff.added} −${diff.removed}`
        this.updateStep(stepId, { status: 'done', endedAt: Date.now(), detail })
        return {
          ok: true,
          detail,
          text: `ArgoIDE wrote ${written.relativePath} (${detail}). Continue.`
        }
      } catch (err) {
        const message = (err as Error).message
        this.updateStep(stepId, { status: 'failed', endedAt: Date.now(), detail: message })
        return { ok: false, text: `Could not write "${call.path}": ${message}`, detail: message }
      }
    }

    // run
    const execId = uid()
    const stepId = this.pushStep({
      kind: 'run',
      label: call.command,
      status: 'running',
      body: ''
    })
    this.activeExecId = execId

    // Stream stdout into the step body so the panel shows progress rather
    // than freezing on "running" for two minutes.
    let live = ''
    const unsubscribe = window.api.agent.onExecData(execId, (chunk) => {
      live += chunk
      // Keep only the tail: the panel shows a few lines, not a whole build log.
      this.updateStep(stepId, { body: live.slice(-4_000) })
    })

    try {
      const result = await window.api.agent.exec({
        id: execId,
        command: call.command,
        cwd: root,
        userApproved: true
      })
      const detail = result.timedOut
        ? 'timed out after 120s'
        : `exit ${result.exitCode}${result.truncated ? ' · output truncated' : ''}`
      this.updateStep(stepId, {
        status: result.exitCode === 0 && !result.timedOut ? 'done' : 'failed',
        endedAt: Date.now(),
        detail,
        body: result.output.slice(-4_000)
      })
      return {
        ok: result.exitCode === 0,
        detail,
        text:
          `Command: ${call.command}\nExit code: ${result.exitCode}` +
          `${result.timedOut ? ' (killed after the 120s limit)' : ''}` +
          `${result.truncated ? '\nOutput was truncated at 100 KB.' : ''}` +
          `\n\nOutput:\n${result.output || '(no output)'}`
      }
    } catch (err) {
      const message = (err as Error).message
      this.updateStep(stepId, { status: 'failed', endedAt: Date.now(), detail: message })
      return { ok: false, text: `Could not run "${call.command}": ${message}`, detail: message }
    } finally {
      unsubscribe()
      this.activeExecId = null
    }
  }

  // ------------------------------------------------------------------- gate

  /** Show the user the call when the mode or the denylist calls for it. */
  private async approve(call: ToolCall, root: string | null): Promise<ApprovalChoice> {
    const { required, reason } = needsApproval(call, this.options.mode, this.turnOverride)
    if (!required) return 'allow'

    // Writes are the one case where the user needs more than the path to
    // decide, so the prompt carries a diff.
    let diff: DiffSummary | undefined
    if (call.tool === 'write_file' && root) {
      diff = summarizeDiff(await this.previousContent(root, call.path), call.content)
    }

    const choice = await this.options.requestApproval(call, diff, reason)
    if (choice === 'allow-all') this.turnOverride = true
    return choice
  }

  // ------------------------------------------------------------------- loop

  async run(): Promise<AgentLoopResult> {
    const startedAt = Date.now()
    const root = this.options.projectRoot
    const messages: WireMessage[] = [
      { role: 'system', content: this.options.systemPrompt },
      ...this.options.history
    ]

    let lastProse = ''

    for (let step = 0; step < MAX_STEPS; step += 1) {
      const raw = await this.streamOnce(messages)
      const { prose, call, parseError } = parseReply(raw)
      lastProse = prose
      this.options.onProse(prose)

      if (parseError) {
        this.pushStep({
          kind: 'error',
          label: 'Malformed tool call',
          status: 'failed',
          detail: parseError,
          endedAt: Date.now()
        })
        messages.push(
          { role: 'assistant', content: raw },
          {
            role: 'user',
            content: `ArgoIDE could not run that tool call: ${parseError}\nEmit a corrected argo-tool block, or answer without one.`
          }
        )
        continue
      }

      if (!call) {
        return { text: prose, trace: this.trace, durationMs: Date.now() - startedAt }
      }

      const choice = await this.approve(call, root)
      if (choice === 'deny') {
        this.pushStep({
          kind: 'error',
          label: describeCall(call),
          status: 'denied',
          detail: 'denied by user',
          endedAt: Date.now()
        })
        messages.push(
          { role: 'assistant', content: raw },
          {
            role: 'user',
            content:
              'The user denied that action. Do not retry it. Either continue another way, or ' +
              'explain what you need and stop.'
          }
        )
        continue
      }

      const result = await this.runTool(call, root)
      messages.push({ role: 'assistant', content: raw }, { role: 'user', content: result.text })
    }

    // Out of steps. Report honestly rather than pretending the turn finished.
    this.pushStep({
      kind: 'error',
      label: `Stopped after ${MAX_STEPS} tool calls`,
      status: 'failed',
      detail: 'step limit',
      endedAt: Date.now()
    })
    return {
      text:
        lastProse ||
        `Stopped after ${MAX_STEPS} tool calls in one turn without reaching an answer.`,
      trace: this.trace,
      durationMs: Date.now() - startedAt
    }
  }
}
