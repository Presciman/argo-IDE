import { JSX, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  voiceMode: boolean
  onVoiceModeChange: (enabled: boolean) => void
}

interface SpeechRecognitionResultLike {
  isFinal: boolean
  0: { transcript: string }
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<SpeechRecognitionResultLike>
}

interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onstart: (() => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const speechWindow = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null
}

export default function Composer(props: Props): JSX.Element {
  const [text, setText] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [listening, setListening] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [menuPosition, setMenuPosition] = useState({ left: 8, bottom: 8 })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const transcriptBaseRef = useRef('')

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
      const target = e.target as Node
      if (
        !menuRef.current?.contains(target) &&
        !menuButtonRef.current?.contains(target)
      ) {
        setMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const positionMenu = useCallback(() => {
    const rect = menuButtonRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(250, window.innerWidth - 16)
    setMenuPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      bottom: Math.max(8, window.innerHeight - rect.top + 6)
    })
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    positionMenu()
    window.addEventListener('resize', positionMenu)
    return () => window.removeEventListener('resize', positionMenu)
  }, [menuOpen, positionMenu])

  useEffect(
    () => () => {
      recognitionRef.current?.abort()
      recognitionRef.current = null
    },
    []
  )

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

  const toggleListening = (): void => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      return
    }

    const Recognition = speechRecognitionConstructor()
    if (!Recognition) {
      setVoiceError('Voice input is not supported by this Electron/Chromium build.')
      return
    }

    const recognition = new Recognition()
    transcriptBaseRef.current = text.trimEnd()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = navigator.language || 'en-US'
    recognition.onstart = () => {
      setVoiceError(null)
      setListening(true)
    }
    recognition.onresult = (event) => {
      let transcript = ''
      for (let i = 0; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript
      }
      const base = transcriptBaseRef.current
      setText(`${base}${base && transcript ? ' ' : ''}${transcript}`)
    }
    recognition.onerror = (event) => {
      setVoiceError(
        event.error === 'not-allowed'
          ? 'Microphone or speech-recognition permission was denied.'
          : `Voice input failed: ${event.error}`
      )
    }
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null
      setListening(false)
      textareaRef.current?.focus()
    }
    recognitionRef.current = recognition

    try {
      recognition.start()
    } catch (err) {
      recognitionRef.current = null
      setListening(false)
      setVoiceError(`Could not start voice input: ${(err as Error).message}`)
    }
  }

  const toggleVoiceMode = (): void => {
    if (!('speechSynthesis' in window)) {
      setVoiceError('Spoken replies are not supported by this Electron/Chromium build.')
      return
    }
    setVoiceError(null)
    props.onVoiceModeChange(!props.voiceMode)
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
        <div>
          <button
            ref={menuButtonRef}
            className={`icon-btn${menuOpen ? ' is-active' : ''}`}
            onClick={() => {
              positionMenu()
              setMenuOpen((v) => !v)
            }}
            title="Add attachment or folder access"
          >
            <PlusIcon size={15} />
          </button>
          {menuOpen &&
            createPortal(
              <div
                ref={menuRef}
                className="modal composer-menu"
                style={{ left: menuPosition.left, bottom: menuPosition.bottom }}
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
              </div>,
              document.body
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

        <button
          className={`icon-btn${listening ? ' voice-active' : ''}`}
          onClick={toggleListening}
          title={listening ? 'Stop voice input' : 'Voice input'}
        >
          <MicIcon size={15} />
        </button>
        <button
          className={`icon-btn${props.voiceMode ? ' is-active' : ''}`}
          onClick={toggleVoiceMode}
          title={props.voiceMode ? 'Stop reading replies aloud' : 'Read replies aloud'}
        >
          <WaveIcon size={15} />
        </button>
      </div>
      {voiceError && <div className="composer__voice-status">{voiceError}</div>}
    </div>
  )
}
