import { JSX, useCallback, useEffect, useRef, useState } from 'react'
import { AgentPreset, ArgoModel, Attachment, FolderGrant } from '../../../shared/types'
import { CloseIcon, FolderIcon, MicIcon, PlusIcon, SendIcon, StopIcon, WaveIcon } from './Icons'

interface Props {
  models: ArgoModel[]
  model: string
  onModelChange: (m: string) => void
  agents: AgentPreset[]
  agentId: string
  onAgentChange: (id: string) => void
  attachments: Attachment[]
  onAttach: (paths: string[]) => void
  onRemoveAttachment: (id: string) => void
  grants: FolderGrant[]
  onGrantFolder: () => void
  onRevokeGrant: (path: string) => void
  onSend: (text: string) => void
  onStop: () => void
  streaming: boolean
  disabled: boolean
}

export default function Composer(props: Props): JSX.Element {
  const [text, setText] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [voiceMode, setVoiceMode] = useState(false)
  const [listening, setListening] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Grow the textarea with its content, up to the CSS max-height.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 190)}px`
  }, [text])

  // Dismiss the "+" menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const submit = useCallback(() => {
    const value = text.trim()
    if (!value || props.disabled || props.streaming) return
    props.onSend(value)
    setText('')
  }, [text, props])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const pickFiles = async (): Promise<void> => {
    setMenuOpen(false)
    const paths = await window.api.fs.pickFiles()
    if (paths.length) props.onAttach(paths)
  }

  const pickFolder = (): void => {
    setMenuOpen(false)
    props.onGrantFolder()
  }

  return (
    <div className="composer">
      {(props.attachments.length > 0 || props.grants.length > 0) && (
        <div className="composer__attachments">
          {props.grants.map((g) => (
            <span className="chip" key={g.path} title={`Folder access: ${g.path}`}>
              <FolderIcon size={11} />
              <span className="chip__name">{g.name}</span>
              <button className="chip__x" onClick={() => props.onRevokeGrant(g.path)}>
                <CloseIcon size={11} />
              </button>
            </span>
          ))}
          {props.attachments.map((a) => (
            <span
              className={`chip${a.skipped ? ' chip--skipped' : ''}`}
              key={a.id}
              title={a.skipped ? `${a.path} — ${a.skipped}` : a.path}
            >
              <span className="chip__name">{a.name}</span>
              <button className="chip__x" onClick={() => props.onRemoveAttachment(a.id)}>
                <CloseIcon size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer__input-wrap">
        <textarea
          ref={textareaRef}
          className="composer__textarea"
          rows={1}
          value={text}
          placeholder={props.disabled ? 'Connect to Argo to start chatting…' : 'Send a message…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {props.streaming ? (
          <button className="composer__send composer__send--stop" onClick={props.onStop} title="Stop">
            <StopIcon size={12} />
          </button>
        ) : (
          <button
            className="composer__send"
            onClick={submit}
            disabled={!text.trim() || props.disabled}
            title="Send (Enter)"
          >
            <SendIcon size={14} />
          </button>
        )}
      </div>

      <div className="composer__toolbar">
        <div style={{ position: 'relative' }} ref={menuRef}>
          <button
            className={`icon-btn${menuOpen ? ' is-active' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            title="Add attachment or folder access"
          >
            <PlusIcon size={15} />
          </button>
          {menuOpen && (
            <div
              className="modal"
              style={{
                position: 'absolute',
                bottom: 32,
                left: 0,
                width: 250,
                maxWidth: 'none',
                padding: 5,
                zIndex: 30
              }}
            >
              <button className="session-item" style={{ width: '100%' }} onClick={pickFiles}>
                <div className="session-item__text" style={{ textAlign: 'left' }}>
                  <div className="session-item__title">Attach files…</div>
                  <div className="session-item__meta">Inline text files into the prompt</div>
                </div>
              </button>
              <button className="session-item" style={{ width: '100%' }} onClick={pickFolder}>
                <div className="session-item__text" style={{ textAlign: 'left' }}>
                  <div className="session-item__title">Grant folder access…</div>
                  <div className="session-item__meta">Tell the agent it may read a directory</div>
                </div>
              </button>
            </div>
          )}
        </div>

        <select
          className="select select--bare"
          value={props.model}
          onChange={(e) => props.onModelChange(e.target.value)}
          title="Model"
        >
          {props.models.length === 0 && <option value={props.model}>{props.model || 'No models'}</option>}
          {props.models.map((m) => (
            <option key={m.id} value={m.internalId ?? m.id}>
              {m.id}
            </option>
          ))}
        </select>

        <select
          className="select select--bare"
          value={props.agentId}
          onChange={(e) => props.onAgentChange(e.target.value)}
          title="Agent preset (local system prompt)"
        >
          {props.agents.map((a) => (
            <option key={a.id} value={a.id} title={a.description}>
              {a.name}
            </option>
          ))}
        </select>

        <span className="pane__spacer" />

        {/*
          Voice is UI-only in this version: the buttons and their states exist,
          but no speech engine is wired up yet. They stay disabled rather than
          silently doing nothing when clicked.
        */}
        <button
          className={`icon-btn${listening ? ' voice-active' : ''}`}
          onClick={() => setListening((v) => !v)}
          disabled
          title="Voice input — not yet implemented"
        >
          <MicIcon size={15} />
        </button>
        <button
          className={`icon-btn${voiceMode ? ' is-active' : ''}`}
          onClick={() => setVoiceMode((v) => !v)}
          disabled
          title="Voice mode — not yet implemented"
        >
          <WaveIcon size={15} />
        </button>
      </div>
    </div>
  )
}
