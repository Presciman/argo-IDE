import { JSX, useEffect, useRef, useState } from 'react'
import { AgentMode, ProjectContext, TraceStep } from '../../../shared/types'
import { CheckIcon, DotIcon, FolderIcon, WarnIcon } from './Icons'

/**
 * The pinned progress panel.
 *
 * Everything the agent is doing refreshes in place here, above the composer,
 * instead of scrolling past in the chat log. The panel keeps a fixed footprint:
 * the running step is always the visible line, with recent finished steps
 * above it, so the user can see progress without hunting for it.
 */

interface Props {
  steps: TraceStep[]
  running: boolean
  /** Wall-clock start of the current turn, for the elapsed clock. */
  startedAt: number | null
  mode: AgentMode
  projectRoot: string | null
  projectContext: ProjectContext | null
  projectContextError: string | null
  indexing: boolean
}

/** How many finished steps stay visible above the running one. */
const VISIBLE_HISTORY = 4

export function elapsedLabel(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** The headline: whatever is running now, or a neutral label between steps. */
function runningLabel(steps: TraceStep[]): string {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]
    if (step.status === 'running') return step.kind === 'reasoning' ? 'Thinking' : step.label
  }
  return 'Working'
}

function StepIcon({ status }: { status: TraceStep['status'] }): JSX.Element {
  if (status === 'running') return <span className="trace__spinner" aria-hidden="true" />
  if (status === 'done') return <CheckIcon size={11} />
  return <WarnIcon size={11} />
}

/** One line, plus its captured output when it has any. */
export function TraceRow({ step, expanded }: { step: TraceStep; expanded: boolean }): JSX.Element {
  const body = step.body?.trimEnd()
  return (
    <div className={`trace__row trace__row--${step.status}`}>
      <span className="trace__icon">
        <StepIcon status={step.status} />
      </span>
      <span className="trace__label" title={step.label}>
        {step.kind === 'reasoning' ? 'Thinking' : step.label}
      </span>
      {step.detail && <span className="trace__detail">{step.detail}</span>}
      {body && (expanded || step.status === 'running') && (
        <div className="trace__body">{expanded ? body : body.split('\n').slice(-3).join('\n')}</div>
      )}
    </div>
  )
}

export default function AgentTrace({
  steps,
  running,
  startedAt,
  mode,
  projectRoot,
  projectContext,
  projectContextError,
  indexing
}: Props): JSX.Element {
  const [now, setNow] = useState(Date.now())
  const tailRef = useRef<HTMLDivElement>(null)

  // Drive the elapsed clock only while something is actually running.
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [running])

  // Keep the newest step in view within the panel's own fixed height.
  useEffect(() => {
    const el = tailRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [steps])

  const contextLabel = !projectRoot
    ? 'No Explorer folder open'
    : indexing
      ? 'Indexing project…'
      : projectContext
        ? `${projectContext.name} · ${projectContext.fileCount} files${projectContext.truncated ? ' · truncated' : ''}`
        : projectContextError || 'Project unavailable'

  // Idle: collapse to the one-line context strip this panel replaced.
  if (!running && steps.length === 0) {
    return (
      <div className={`trace trace--idle${projectContextError ? ' trace--error' : ''}`}>
        <FolderIcon size={12} />
        <span className="trace__context-label">AI Agent context</span>
        <span className="trace__context-value" title={projectContext?.root ?? contextLabel}>
          {contextLabel}
        </span>
        <span className={`trace__mode trace__mode--${mode}`}>{mode === 'full' ? 'full access' : mode}</span>
      </div>
    )
  }

  const visible = steps.slice(-(VISIBLE_HISTORY + 1))

  return (
    <div className="trace">
      <div className="trace__header">
        <span className="trace__spinner" aria-hidden="true" />
        <span className="trace__title">{runningLabel(steps)}</span>
        <span className="pane__spacer" />
        <span className={`trace__mode trace__mode--${mode}`}>{mode === 'full' ? 'full access' : mode}</span>
        <span className="trace__clock">{elapsedLabel(now - (startedAt ?? now))}</span>
      </div>
      <div className="trace__steps" ref={tailRef}>
        {steps.length > visible.length && (
          <div className="trace__row trace__row--muted">
            <span className="trace__icon">
              <DotIcon size={11} />
            </span>
            <span className="trace__label">
              {steps.length - visible.length} earlier step
              {steps.length - visible.length === 1 ? '' : 's'}
            </span>
          </div>
        )}
        {visible.map((step) => (
          <TraceRow key={step.id} step={step} expanded={false} />
        ))}
      </div>
    </div>
  )
}

/**
 * The collapsed summary attached to a finished message.
 *
 * Same steps, folded to one line so the log stays readable, expandable when
 * the user wants to know how an answer was reached.
 */
export function TraceSummary({
  steps,
  durationMs
}: {
  steps: TraceStep[]
  durationMs?: number
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (steps.length === 0) return null

  const counts = {
    read: steps.filter((s) => s.kind === 'read').length,
    write: steps.filter((s) => s.kind === 'write').length,
    run: steps.filter((s) => s.kind === 'run').length
  }
  const parts: string[] = []
  if (durationMs) parts.push(`Thought for ${Math.max(1, Math.round(durationMs / 1000))}s`)
  if (counts.read) parts.push(`${counts.read} file${counts.read === 1 ? '' : 's'} read`)
  if (counts.write) parts.push(`${counts.write} written`)
  if (counts.run) parts.push(`${counts.run} command${counts.run === 1 ? '' : 's'}`)

  return (
    <div className="trace-summary">
      <button className="trace-summary__toggle" onClick={() => setOpen((v) => !v)}>
        <span className={`trace-summary__caret${open ? ' is-open' : ''}`}>▸</span>
        {parts.join(' · ') || `${steps.length} steps`}
      </button>
      {open && (
        <div className="trace-summary__steps">
          {steps.map((step) => (
            <TraceRow key={step.id} step={step} expanded />
          ))}
        </div>
      )}
    </div>
  )
}
