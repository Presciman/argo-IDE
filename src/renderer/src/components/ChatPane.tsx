import { JSX, useCallback, useEffect, useRef, useState } from 'react'
import {
  AppSettings,
  ArgoModel,
  Attachment,
  ChatMessage,
  ChatSession,
  FolderGrant,
  ProjectContext,
  Role,
  SessionSummary,
  ShimStatus
} from '../../../shared/types'
import { AGENT_PRESETS, findAgent } from '../agents'
import Composer from './Composer'
import SessionDrawer from './SessionDrawer'
import { FolderIcon, GearIcon, MenuIcon, PlugIcon } from './Icons'

interface Props {
  settings: AppSettings
  status: ShimStatus
  projectRoot: string | null
  onOpenSettings: () => void
  onOpenConnect: () => void
}

const uid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const MAX_AGENT_FILE_READS = 8

type WireMessage = { role: Role; content: string }

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
${context.tree}${omitted}

When you need the contents of a text file, output exactly one line and nothing else:
[[ARGO_READ_FILE:path/relative/to/project]]

ArgoIDE will securely read that file only from the open project and return its contents. You may repeat this for multiple files, one request at a time. Never claim to have read a file until ArgoIDE has returned it.`
}

function requestedProjectFile(text: string): string | null {
  const match = text.match(
    /^\s*(?:```(?:text)?\s*)?\[\[ARGO_READ_FILE:([^\]\r\n]+)\]\](?:\s*```)?\s*$/i
  )
  return match?.[1].trim() || null
}

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
      setStreaming(true)

      // Mark the indexing phase as cancellable too. It is not a real network
      // id, but cancel() safely ignores ids that are not in the main map.
      const preparationId = uid()
      activeRequest.current = preparationId

      void (async () => {
        let context = projectRoot ? projectContext : null
        if (projectRoot) {
          try {
            context = await loadProjectContext()
            setProjectContext(context)
            setProjectContextError(null)
          } catch (err) {
            setProjectContextError((err as Error).message)
          }
        }
        if (activeRequest.current !== preparationId) return
        const workspaceContext = context

        // The wire history excludes the placeholder we just added for the reply.
        const history: WireMessage[] = withUser.messages
          .slice(0, -1)
          .map((m) => ({ role: m.role, content: m.content }))
        const initialMessages: WireMessage[] = [
          {
            role: 'system',
            content: `${findAgent(current.agentId).systemPrompt}\n\n${projectInstructions(workspaceContext)}`
          },
          ...history
        ]

        const finish = (requestId: string, patch: Partial<ChatMessage>): void => {
          // A cancelled request may still deliver a trailing event; ignore it so
          // a newer request's state isn't clobbered.
          if (activeRequest.current !== requestId) return

          const next = updateSession((prev) => ({
            ...prev,
            updatedAt: Date.now(),
            messages: prev.messages.map((m) =>
              m.id === assistantMsg.id ? { ...m, ...patch } : m
            )
          }))
          void window.api.sessions.write(next).then(refreshSummaries)

          unsubscribe.current?.()
          unsubscribe.current = null
          activeRequest.current = null
          setStreaming(false)
        }

        const streamRound = (messages: WireMessage[], readCount: number): void => {
          const requestId = uid()
          activeRequest.current = requestId
          let accumulated = ''

          unsubscribe.current?.()
          unsubscribe.current = window.api.chat.send(
            { requestId, model: current.model, messages },
            (event) => {
              if (activeRequest.current !== requestId) return
              if (event.type === 'delta') {
                accumulated += event.text
                // Update in place; persistence happens once, in finish().
                updateSession((prev) => ({
                  ...prev,
                  messages: prev.messages.map((m) =>
                    m.id === assistantMsg.id ? { ...m, content: accumulated, error: undefined } : m
                  )
                }))
                return
              }

              if (event.type === 'error') {
                finish(requestId, { content: accumulated, error: event.message })
                return
              }

              const requestedPath = workspaceContext ? requestedProjectFile(accumulated) : null
              if (!workspaceContext || !requestedPath) {
                if (voiceModeRef.current && accumulated.trim()) {
                  window.speechSynthesis.cancel()
                  window.speechSynthesis.speak(new SpeechSynthesisUtterance(accumulated))
                }
                finish(requestId, { content: accumulated })
                return
              }

              if (readCount >= MAX_AGENT_FILE_READS) {
                finish(requestId, {
                  content: '',
                  error: `AI Agent stopped after ${MAX_AGENT_FILE_READS} project-file reads in one turn.`
                })
                return
              }

              updateSession((prev) => ({
                ...prev,
                messages: prev.messages.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, content: `Reading ${requestedPath}…`, error: undefined }
                    : m
                )
              }))
              unsubscribe.current?.()
              unsubscribe.current = null

              void window.api.fs
                .readProjectFile(workspaceContext.root, requestedPath)
                .then((file) => {
                  if (activeRequest.current !== requestId) return
                  const result = `ArgoIDE read this local project file for you:\n<file path="${file.relativePath}"${
                    file.truncated ? ' truncated="true"' : ''
                  }>\n${file.content}\n</file>\nContinue answering the user's original request. Read another file only if necessary.`
                  streamRound(
                    [
                      ...messages,
                      { role: 'assistant', content: accumulated },
                      { role: 'user', content: result }
                    ],
                    readCount + 1
                  )
                })
                .catch((err: Error) => {
                  if (activeRequest.current !== requestId) return
                  streamRound(
                    [
                      ...messages,
                      { role: 'assistant', content: accumulated },
                      {
                        role: 'user',
                        content: `ArgoIDE could not read "${requestedPath}": ${err.message}. Choose a valid text-file path from the project tree and continue.`
                      }
                    ],
                    readCount + 1
                  )
                })
            }
          )
        }

        streamRound(initialMessages, 0)
      })()
    },
    [
      attachments,
      grants,
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

          <div
            className={`project-context${projectContextError ? ' project-context--error' : ''}`}
            title={projectContext?.root ?? projectContextError ?? 'Open a folder in Explorer'}
          >
            <FolderIcon size={12} />
            <span className="project-context__label">AI Agent context</span>
            <span className="project-context__value">
              {!projectRoot
                ? 'No Explorer folder open'
                : indexingProject
                  ? 'Indexing project…'
                  : projectContext
                    ? `${projectContext.name} · ${projectContext.fileCount} files · ${projectContext.directoryCount} folders${projectContext.truncated ? ' · tree truncated' : ''}`
                    : projectContextError || 'Project unavailable'}
            </span>
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
