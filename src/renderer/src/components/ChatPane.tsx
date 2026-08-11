import { JSX, useCallback, useEffect, useRef, useState } from 'react'
import {
  AppSettings,
  ArgoModel,
  Attachment,
  ChatMessage,
  ChatSession,
  FolderGrant,
  SessionSummary,
  ShimStatus
} from '../../../shared/types'
import { AGENT_PRESETS, findAgent } from '../agents'
import Composer from './Composer'
import SessionDrawer from './SessionDrawer'
import { GearIcon, MenuIcon, PlugIcon } from './Icons'

interface Props {
  settings: AppSettings
  status: ShimStatus
  onOpenSettings: () => void
  onOpenConnect: () => void
}

const uid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function emptySession(model: string): ChatSession {
  const now = Date.now()
  return {
    id: uid(),
    title: 'New session',
    createdAt: now,
    updatedAt: now,
    model,
    agentId: AGENT_PRESETS[0].id,
    messages: []
  }
}

/** Render attachments as fenced blocks the model can read alongside the prompt. */
function buildUserContent(text: string, attachments: Attachment[], grants: FolderGrant[]): string {
  const parts: string[] = []

  if (grants.length) {
    parts.push(
      'The user has granted you read access to these directories:\n' +
        grants.map((g) => `- ${g.path}`).join('\n')
    )
  }

  for (const a of attachments) {
    if (a.text !== undefined) {
      parts.push(`Attached file: ${a.path}\n\`\`\`\n${a.text}\n\`\`\``)
    } else {
      parts.push(`Attached file: ${a.path} (not inlined — ${a.skipped})`)
    }
  }

  parts.push(text)
  return parts.join('\n\n')
}

export default function ChatPane({
  settings,
  status,
  onOpenSettings,
  onOpenConnect
}: Props): JSX.Element {
  const [session, setSession] = useState<ChatSession>(() => emptySession(''))
  const [summaries, setSummaries] = useState<SessionSummary[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [models, setModels] = useState<ArgoModel[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [grants, setGrants] = useState<FolderGrant[]>([])
  const [streaming, setStreaming] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [voiceMode, setVoiceMode] = useState(false)

  const logRef = useRef<HTMLDivElement>(null)
  const activeRequest = useRef<string | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)
  const voiceModeRef = useRef(false)

  /**
   * Mirror of `session` that is always current.
   *
   * Stream callbacks fire many times per second and outlive the render that
   * created them, so they cannot read `session` from their closure. Reading
   * and writing through this ref keeps every state updater pure — React
   * invokes updaters twice under StrictMode, so no updater may write to disk
   * or touch a ref.
   */
  const sessionRef = useRef(session)

  const updateSession = useCallback(
    (fn: (prev: ChatSession) => ChatSession): ChatSession => {
      const next = fn(sessionRef.current)
      sessionRef.current = next
      setSession(next)
      return next
    },
    []
  )

  const refreshSummaries = useCallback(async () => {
    setSummaries(await window.api.sessions.list())
  }, [])

  useEffect(() => {
    void refreshSummaries()
  }, [refreshSummaries])

  // Load the model list once the connection reports healthy, and pick a
  // default. Argo's ids are display names; internalId is what the API wants.
  useEffect(() => {
    if (status.state !== 'connected') return
    let cancelled = false
    window.api.chat
      .models()
      .then((list) => {
        if (cancelled) return
        setModels(list)
        setModelError(null)
        updateSession((s) =>
          s.model || list.length === 0 ? s : { ...s, model: list[0].internalId ?? list[0].id }
        )
      })
      .catch((err: Error) => !cancelled && setModelError(err.message))
    return () => {
      cancelled = true
    }
  }, [status.state, updateSession])

  // Follow the tail of the conversation as tokens stream in.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session.messages])

  // Drop any in-flight stream if the pane unmounts.
  useEffect(
    () => () => {
      unsubscribe.current?.()
      window.speechSynthesis?.cancel()
    },
    []
  )

  const changeVoiceMode = useCallback((enabled: boolean) => {
    voiceModeRef.current = enabled
    setVoiceMode(enabled)
    if (!enabled) window.speechSynthesis?.cancel()
  }, [])

  const persist = useCallback(
    (next: ChatSession) => {
      updateSession(() => next)
      // Don't litter the sidebar with empty sessions the user never used.
      if (next.messages.length > 0) {
        void window.api.sessions.write(next).then(refreshSummaries)
      }
    },
    [refreshSummaries, updateSession]
  )

  const stop = useCallback(() => {
    if (activeRequest.current) window.api.chat.cancel(activeRequest.current)
    unsubscribe.current?.()
    unsubscribe.current = null
    activeRequest.current = null
    setStreaming(false)
    window.speechSynthesis?.cancel()
  }, [])

  const send = useCallback(
    (text: string) => {
      const current = sessionRef.current
      const userMsg: ChatMessage = {
        id: uid(),
        role: 'user',
        content: buildUserContent(text, attachments, grants),
        createdAt: Date.now(),
        attachments: attachments.length ? attachments : undefined
      }
      const assistantMsg: ChatMessage = {
        id: uid(),
        role: 'assistant',
        content: '',
        createdAt: Date.now()
      }

      const withUser = updateSession((s) => ({
        ...s,
        // The first user message names the session.
        title:
          s.messages.length === 0
            ? text.slice(0, 60).replace(/\s+/g, ' ').trim() || 'New session'
            : s.title,
        updatedAt: Date.now(),
        messages: [...s.messages, userMsg, assistantMsg]
      }))
      setAttachments([])

      const requestId = uid()
      activeRequest.current = requestId
      setStreaming(true)

      // The wire history excludes the placeholder we just added for the reply.
      const history = withUser.messages
        .slice(0, -1)
        .map((m) => ({ role: m.role, content: m.content }))

      let accumulated = ''
      const finish = (patch: Partial<ChatMessage>): void => {
        // A cancelled request may still deliver a trailing event; ignore it so
        // a newer request's state isn't clobbered.
        if (activeRequest.current !== requestId) return

        const next = updateSession((prev) => ({
          ...prev,
          updatedAt: Date.now(),
          messages: prev.messages.map((m) => (m.id === assistantMsg.id ? { ...m, ...patch } : m))
        }))
        void window.api.sessions.write(next).then(refreshSummaries)

        unsubscribe.current?.()
        unsubscribe.current = null
        activeRequest.current = null
        setStreaming(false)
      }

      unsubscribe.current = window.api.chat.send(
        {
          requestId,
          model: current.model,
          messages: [
            { role: 'system' as const, content: findAgent(current.agentId).systemPrompt },
            ...history
          ]
        },
        (event) => {
          if (activeRequest.current !== requestId) return
          if (event.type === 'delta') {
            accumulated += event.text
            // Update in place; persistence happens once, in finish().
            updateSession((prev) => ({
              ...prev,
              messages: prev.messages.map((m) =>
                m.id === assistantMsg.id ? { ...m, content: accumulated } : m
              )
            }))
          } else if (event.type === 'done') {
            if (voiceModeRef.current && accumulated.trim()) {
              window.speechSynthesis.cancel()
              window.speechSynthesis.speak(new SpeechSynthesisUtterance(accumulated))
            }
            finish({ content: accumulated })
          } else {
            finish({ content: accumulated, error: event.message })
          }
        }
      )
    },
    [attachments, grants, refreshSummaries, updateSession]
  )

  const attachFiles = useCallback(async (paths: string[]) => {
    const added = await Promise.all(paths.map((p) => window.api.fs.attach(p, uid())))
    // Re-attaching the same file replaces the old copy rather than duplicating.
    setAttachments((prev) => [
      ...prev.filter((a) => !added.some((n) => n.path === a.path)),
      ...added
    ])
  }, [])

  const grantFolder = useCallback(async () => {
    const dir = await window.api.fs.pickFolder()
    if (!dir) return
    setGrants((prev) =>
      prev.some((g) => g.path === dir)
        ? prev
        : [...prev, { path: dir, name: dir.split('/').pop() || dir }]
    )
  }, [])

  const newSession = useCallback(() => {
    stop()
    // Carry the current model into the new session so the picker doesn't reset.
    updateSession((s) => emptySession(s.model || models[0]?.internalId || ''))
    setAttachments([])
    setDrawerOpen(false)
  }, [stop, models, updateSession])

  const openSession = useCallback(
    async (id: string) => {
      stop()
      const loaded = await window.api.sessions.read(id)
      if (loaded) updateSession(() => loaded)
      setDrawerOpen(false)
    },
    [stop, updateSession]
  )

  const deleteSession = useCallback(
    async (id: string) => {
      await window.api.sessions.delete(id)
      await refreshSummaries()
      // Deleting the session on screen leaves the pane on a stale id; reset it.
      if (id === sessionRef.current.id) newSession()
    },
    [refreshSummaries, newSession]
  )

  const connected = status.state === 'connected'

  return (
    <div className="pane" style={{ flex: '1.15 1 0' }}>
      <div className="pane__header">
        <button
          className={`icon-btn${drawerOpen ? ' is-active' : ''}`}
          onClick={() => setDrawerOpen((v) => !v)}
          title="Sessions"
        >
          <MenuIcon size={15} />
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title="Settings">
          <GearIcon size={15} />
        </button>
        <button
          className={`icon-btn${connected ? ' is-active' : ''}`}
          onClick={onOpenConnect}
          title="Connect to argo-shim"
        >
          <PlugIcon size={15} />
        </button>
        <span className="status-line" style={{ marginLeft: 2 }}>
          <span className={`status-dot status-dot--${status.state}`} />
        </span>
        <span className="pane__title" style={{ marginLeft: 4 }}>
          {session.title}
        </span>
        <span className="pane__spacer" />
      </div>

      <div className="pane__body" style={{ overflow: 'hidden' }}>
        {drawerOpen && (
          <SessionDrawer
            sessions={summaries}
            activeId={session.id}
            onSelect={openSession}
            onNew={newSession}
            onDelete={deleteSession}
            onClose={() => setDrawerOpen(false)}
          />
        )}

        <div className="chat">
          <div className="chat__log" ref={logRef}>
            {session.messages.length === 0 && (
              <div className="empty-state">
                {connected ? (
                  <>
                    <div>Ask anything.</div>
                    <div>
                      Attach files with <strong>+</strong>, then pick a model and an agent below.
                    </div>
                  </>
                ) : (
                  <>
                    <div>Not connected to Argo.</div>
                    <div>
                      {settings.celsUsername.trim()
                        ? 'Use the plug icon above to start argo-shim.'
                        : 'Set your CELS username in Settings, then connect.'}
                    </div>
                    <button className="btn btn--sm" onClick={onOpenConnect}>
                      Connect
                    </button>
                  </>
                )}
              </div>
            )}

            {modelError && <div className="banner banner--err">{modelError}</div>}

            {session.messages.map((m) => (
              <div
                key={m.id}
                className={`msg msg--${m.role}${m.error ? ' msg--error' : ''}`}
              >
                <div className="msg__role">{m.role}</div>
                {m.attachments && m.attachments.length > 0 && (
                  <div className="msg__attachments">
                    {m.attachments.map((a) => (
                      <span className="chip" key={a.id} title={a.path}>
                        <span className="chip__name">{a.name}</span>
                      </span>
                    ))}
                  </div>
                )}
                <div className="msg__body">
                  {m.content}
                  {streaming && m.role === 'assistant' && !m.content && (
                    <span className="cursor-blink">&nbsp;</span>
                  )}
                  {m.error && <div style={{ marginTop: 6 }}>{m.error}</div>}
                </div>
              </div>
            ))}
          </div>

          <Composer
            models={models}
            model={session.model}
            onModelChange={(model) => persist({ ...session, model })}
            agents={AGENT_PRESETS}
            agentId={session.agentId}
            onAgentChange={(agentId) => persist({ ...session, agentId })}
            attachments={attachments}
            onAttach={attachFiles}
            onRemoveAttachment={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
            grants={grants}
            onGrantFolder={grantFolder}
            onRevokeGrant={(path) => setGrants((prev) => prev.filter((g) => g.path !== path))}
            onSend={send}
            onStop={stop}
            streaming={streaming}
            disabled={!connected}
            voiceMode={voiceMode}
            onVoiceModeChange={changeVoiceMode}
          />
        </div>
      </div>
    </div>
  )
}
