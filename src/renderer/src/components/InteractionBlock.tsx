import { JSX, useEffect, useRef, useState } from 'react'
import { ApprovalChoice, DiffSummary, PendingInteraction, ToolCall } from '../../../shared/types'

/**
 * The inline prompt the agent blocks on.
 *
 * Two shapes, one place: a permission request with Allow / Allow all / Deny,
 * and a free-form question with a text input. Both sit at the tail of the chat
 * log where the user is already looking, rather than in a modal that covers
 * the conversation they need to read in order to answer.
 */

interface Props {
  interaction: PendingInteraction
  onApprove: (choice: ApprovalChoice) => void
  onAnswer: (text: string) => void
}

function title(call: ToolCall): string {
  switch (call.tool) {
    case 'read_file':
      return 'AI Agent wants to read a file'
    case 'write_file':
      return 'AI Agent wants to write a file'
    case 'run':
      return 'AI Agent wants to run a command'
    case 'ask_user':
      return 'AI Agent asks'
  }
}

function DiffPreview({ diff }: { diff: DiffSummary }): JSX.Element {
  return (
    <div className="diff">
      {diff.preview.map((line, index) => (
        <div key={index} className={`diff__line diff__line--${line.kind}`}>
          <span className="diff__sign">
            {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
          </span>
          <span className="diff__text">{line.text || ' '}</span>
        </div>
      ))}
      {diff.previewTruncated && <div className="diff__more">… preview truncated</div>}
    </div>
  )
}

export default function InteractionBlock({
  interaction,
  onApprove,
  onAnswer
}: Props): JSX.Element {
  const [reply, setReply] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const allowRef = useRef<HTMLButtonElement>(null)

  // The turn is blocked on this, so put the cursor where the answer goes.
  useEffect(() => {
    if (interaction.kind === 'question') inputRef.current?.focus()
    else allowRef.current?.focus()
  }, [interaction])

  if (interaction.kind === 'question') {
    const submit = (): void => {
      const value = reply.trim()
      if (value) onAnswer(value)
    }
    return (
      <div className="interaction interaction--ask">
        <div className="interaction__header">AI Agent asks</div>
        <div className="interaction__question">{interaction.question}</div>
        <textarea
          ref={inputRef}
          className="interaction__input"
          rows={2}
          value={reply}
          placeholder={interaction.placeholder ?? 'Your answer…'}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="interaction__actions">
          <span className="interaction__hint">Enter to send · Shift+Enter for a new line</span>
          <button className="btn btn--sm btn--primary" disabled={!reply.trim()} onClick={submit}>
            Reply
          </button>
        </div>
      </div>
    )
  }

  const { call, diff, reason } = interaction
  return (
    <div className={`interaction${reason ? ' interaction--risky' : ''}`}>
      <div className="interaction__header">{title(call)}</div>

      {call.tool === 'run' ? (
        <>
          <div className="interaction__target mono">{call.command}</div>
          {call.why && <div className="interaction__why">{call.why}</div>}
        </>
      ) : (
        <div className="interaction__target mono">
          {call.tool === 'read_file' || call.tool === 'write_file' ? call.path : ''}
          {diff && (
            <span className="interaction__counts">
              {diff.created ? 'new file · ' : ''}
              <span className="diff__add-count">+{diff.added}</span>{' '}
              <span className="diff__remove-count">−{diff.removed}</span>
            </span>
          )}
        </div>
      )}

      {reason && <div className="interaction__reason">Always asks: {reason}</div>}
      {diff && diff.preview.length > 0 && <DiffPreview diff={diff} />}

      <div className="interaction__actions">
        <span className="pane__spacer" />
        <button className="btn btn--sm" onClick={() => onApprove('deny')}>
          Deny
        </button>
        <button
          className="btn btn--sm"
          title="Run this and everything else the agent asks for during this turn"
          onClick={() => onApprove('allow-all')}
        >
          Allow all this turn
        </button>
        <button
          ref={allowRef}
          className="btn btn--sm btn--primary"
          onClick={() => onApprove('allow')}
        >
          Allow
        </button>
      </div>
    </div>
  )
}
