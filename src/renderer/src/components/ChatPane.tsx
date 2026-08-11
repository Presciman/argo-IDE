import { JSX, useCallback, useEffect, useRef, useState } from 'react'
import {
  AgentMode,
  AppSettings,
  ApprovalChoice,
  ArgoModel,
  Attachment,
  ChatMessage,
  ChatSession,
  FolderGrant,
  PendingInteraction,
  ProjectContext,
  SessionSummary,
  ShimStatus,
  TraceStep
} from '../../../shared/types'
import { AGENT_PRESETS, findAgent } from '../agents'
import { AgentLoop, Cancelled, WireMessage } from '../agentLoop'
import { toolInstructions } from '../agentTools'
import AgentTrace, { TraceSummary } from './AgentTrace'
import Composer from './Composer'
import InteractionBlock from './InteractionBlock'
import SessionDrawer from './SessionDrawer'
import { GearIcon, MenuIcon, PlugIcon } from './Icons'

interface Props {
  settings: AppSettings
  status: ShimStatus
  projectRoot: string | null
  onOpenSettings: () => void
  onOpenConnect: () => void
}

const uid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function projectInstructions(context: ProjectContext | null): string {
  if (!context) {
    return (
      'No project folder is currently open in the Explorer. If the task depends on local files, ' +
      'ask the user to open a folder first.'
    )
  }

  const omitted = context.excludedDirectories.length
    ? `\nGenerated/dependency directories not expanded: ${context.excludedDirectories.join(', ')}`
    : ''
  return `You are the AI Agent inside ArgoIDE. The user explicitly opened this project root:
${context.root}

You can already see its recursive source tree below; do not ask the user to attach files that are listed here.
${context.tree}${omitted}`
}

function emptySession(model: string, mode: AgentMode = 'manual'): ChatSession {
  const now = Date.now()
  return {
    id: uid(),
    title: 'New session',
    createdAt: now,
    updatedAt: now,
    model,
    agentId: AGENT_PRESETS[0].id,
    mode,
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
  projectRoot,
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
  const [projectContext, setProjectContext] = useState<ProjectContext | null>(null)
  const [projectContextError, setProjectContextError] = useState<string | null>(null)
  const [indexingProject, setIndexingProject] = useState(false)

  // Live turn state: the trace panel and any prompt the agent is blocked on.
  const [trace, setTrace] = useState<TraceStep[]>([])
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null)
  const [pending, setPending] = useState<PendingInteraction | null>(null)

  const logRef = useRef<HTMLDivElement>(null)
  const voiceModeRef = useRef(false)
  const loopRef = useRef<AgentLoop | null>(null)
  /** Resolver for the interaction currently on screen. */
  const resolveInteraction = useRef<((value: never) => void) | null>(null)

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

  const loadProjectContext = useCallback(async (): Promise<ProjectContext | null> => {
    if (!projectRoot) return null
    return window.api.fs.projectContext(projectRoot)
  }, [projectRoot])

  // The left Explorer is the authority for the AI Agent's automatic project
  // scope. Index it immediately when the user opens or switches folders.
  useEffect(() => {
    let cancelled = false
    setProjectContext(null)
    setProjectContextError(null)
    if (!projectRoot) {
      setIndexingProject(false)
      return
    }

    setIndexingProject(true)
    void loadProjectContext()
      .then((context) => {
        if (!cancelled) setProjectContext(context)
      })
      .catch((err: Error) => {
        if (!cancelled) setProjectContextError(err.message)
      })
      .finally(() => {
        if (!cancelled) setIndexingProject(false)
      })
    return () => {
      cancelled = true
    }
  }, [loadProjectContext, projectRoot])

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

  // Drop any in-flight turn if the pane unmounts.
  useEffect(
    () => () => {
      loopRef.current?.cancel()
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
    loopRef.current?.cancel()
    loopRef.current = null
    resolveInteraction.current = null
    setPending(null)
    setStreaming(false)
    setTurnStartedAt(null)
    window.speechSynthesis?.cancel()
  }, [])

  /**
   * Show an inline prompt and block the turn until the user answers.
   *
   * The resolver is held in a ref rather than state because the loop awaits it
   * across many renders; `stop()` drops it, which lets the pending promise be
   * rejected and the turn unwind.
   */
  const interact = useCallback(<T,>(interaction: PendingInteraction): Promise<T> => {
    return new Promise<T>((resolve) => {
      resolveInteraction.current = resolve as (value: never) => void
      setPending(interaction)
    })
  }, [])

  const answerInteraction = useCallback((value: ApprovalChoice | string) => {
    const resolve = resolveInteraction.current
    resolveInteraction.current = null
    setPending(null)
    resolve?.(value as never)
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
      setStreaming(true)
      setTrace([])
      setTurnStartedAt(Date.now())

      const patchAssistant = (patch: Partial<ChatMessage>): ChatSession =>
        updateSession((prev) => ({
          ...prev,
          messages: prev.messages.map((m) => (m.id === assistantMsg.id ? { ...m, ...patch } : m))
        }))

      void (async () => {
        // Re-index before the turn: the tree in the system prompt should
        // reflect files the user (or a previous turn) just created.
        let context = projectRoot ? projectContext : null
        if (projectRoot) {
          setIndexingProject(true)
          try {
            context = await loadProjectContext()
            setProjectContext(context)
            setProjectContextError(null)
          } catch (err) {
            setProjectContextError((err as Error).message)
          } finally {
            setIndexingProject(false)
          }
        }

        const mode = current.mode ?? 'manual'
        const history: WireMessage[] = withUser.messages
          .slice(0, -1)
          .map((m) => ({ role: m.role, content: m.content }))

        const loop = new AgentLoop({
          model: current.model,
          systemPrompt: [
            findAgent(current.agentId).systemPrompt,
            projectInstructions(context),
            toolInstructions(context, mode)
          ].join('\n\n'),
          history,
          projectRoot: context?.root ?? null,
          mode,
          onProse: (prose) => patchAssistant({ content: prose, error: undefined }),
          onTrace: setTrace,
          requestApproval: (call, diff, reason) =>
            interact<ApprovalChoice>({ kind: 'approval', id: uid(), call, diff, reason }),
          askUser: (question, placeholder) =>
            interact<string>({ kind: 'question', id: uid(), question, placeholder })
        })
        loopRef.current = loop

        try {
          const result = await loop.run()
          if (loopRef.current !== loop) return
          const next = patchAssistant({
            content: result.text,
            trace: result.trace.length ? result.trace : undefined,
            durationMs: result.durationMs
          })
          void window.api.sessions.write(next).then(refreshSummaries)

          if (voiceModeRef.current && result.text.trim()) {
            window.speechSynthesis.cancel()
            window.speechSynthesis.speak(new SpeechSynthesisUtterance(result.text))
          }
        } catch (err) {
          // A cancelled turn is the user's own doing: keep whatever prose
          // arrived and say nothing about it.
          if (loopRef.current !== loop) return
          if (!(err instanceof Cancelled)) {
            const next = patchAssistant({ error: (err as Error).message })
            void window.api.sessions.write(next).then(refreshSummaries)
          }
        } finally {
          if (loopRef.current === loop) {
            loopRef.current = null
            setStreaming(false)
            setTurnStartedAt(null)
            setPending(null)
            resolveInteraction.current = null
          }
        }
      })()
    },
    [
      attachments,
      grants,
      interact,
      loadProjectContext,
      projectContext,
      projectRoot,
      refreshSummaries,
      updateSession
    ]
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
    setTrace([])
    // Carry the model into the new session so the picker doesn't reset. The
    // mode deliberately resets to manual: a new task earns its own trust.
    updateSession((s) => emptySession(s.model || models[0]?.internalId || ''))
    setAttachments([])
    setDrawerOpen(false)
  }, [stop, models, updateSession])

  const openSession = useCallback(
    async (id: string) => {
      stop()
      setTrace([])
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
                    <div>Ask the AI Agent anything.</div>
                    <div>
                      The open Explorer folder is indexed automatically. The AI Agent can inspect
                      its files when needed.
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
                <div className="msg__role">
                  {m.role === 'assistant' ? 'AI Agent' : m.role === 'user' ? 'You' : m.role}
                </div>
                {m.attachments && m.attachments.length > 0 && (
                  <div className="msg__attachments">
                    {m.attachments.map((a) => (
                      <span className="chip" key={a.id} title={a.path}>
                        <span className="chip__name">{a.name}</span>
                      </span>
                    ))}
                  </div>
                )}
                {m.role === 'assistant' && m.trace && m.trace.length > 0 && (
                  <TraceSummary steps={m.trace} durationMs={m.durationMs} />
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

            {pending && (
              <InteractionBlock
                interaction={pending}
                onApprove={answerInteraction}
                onAnswer={answerInteraction}
              />
            )}
          </div>

          <AgentTrace
            steps={trace}
            running={streaming}
            startedAt={turnStartedAt}
            mode={session.mode ?? 'manual'}
            projectRoot={projectRoot}
            projectContext={projectContext}
            projectContextError={projectContextError}
            indexing={indexingProject}
          />

          <Composer
            models={models}
            model={session.model}
            onModelChange={(model) => persist({ ...session, model })}
            agents={AGENT_PRESETS}
            agentId={session.agentId}
            onAgentChange={(agentId) => persist({ ...session, agentId })}
            mode={session.mode ?? 'manual'}
            onModeChange={(mode) => persist({ ...session, mode })}
            attachments={attachments}
            onAttach={attachFiles}
            onRemoveAttachment={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
            grants={grants}
            onGrantFolder={grantFolder}
            onRevokeGrant={(path) => setGrants((prev) => prev.filter((g) => g.path !== path))}
            onSend={send}
            onStop={stop}
            streaming={streaming}
            disabled={!connected || pending !== null}
            voiceMode={voiceMode}
            onVoiceModeChange={changeVoiceMode}
          />
        </div>
      </div>
    </div>
  )
}
