import { JSX } from 'react'
import { SessionSummary } from '../../../shared/types'
import { CloseIcon, PlusIcon, TrashIcon } from './Icons'

interface Props {
  sessions: SessionSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onClose: () => void
}

function relativeTime(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

/** Slides over the chat pane; shows saved sessions and starts new ones. */
export default function SessionDrawer(props: Props): JSX.Element {
  return (
    <div className="drawer">
      <div className="drawer__header">
        <span className="pane__title">Sessions</span>
        <span className="pane__spacer" />
        <button className="icon-btn" onClick={props.onNew} title="New session">
          <PlusIcon size={15} />
        </button>
        <button className="icon-btn" onClick={props.onClose} title="Close">
          <CloseIcon size={13} />
        </button>
      </div>

      <div className="drawer__list">
        {props.sessions.length === 0 ? (
          <div className="empty-state">
            <div>No saved sessions yet.</div>
            <button className="btn btn--sm" onClick={props.onNew}>
              New Session
            </button>
          </div>
        ) : (
          props.sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item${s.id === props.activeId ? ' is-active' : ''}`}
              onClick={() => props.onSelect(s.id)}
            >
              <div className="session-item__text">
                <div className="session-item__title">{s.title}</div>
                <div className="session-item__meta">
                  {s.messageCount} message{s.messageCount === 1 ? '' : 's'} ·{' '}
                  {relativeTime(s.updatedAt)}
                </div>
              </div>
              <button
                className="icon-btn"
                title="Delete session"
                onClick={(e) => {
                  // Don't also select the session we're deleting.
                  e.stopPropagation()
                  props.onDelete(s.id)
                }}
              >
                <TrashIcon size={13} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
