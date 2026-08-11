import { JSX, useCallback, useEffect, useRef, useState } from 'react'
import Editor, { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import { GlobeIcon, RefreshIcon } from './Icons'

/**
 * @monaco-editor/react otherwise downloads Monaco from jsDelivr at runtime.
 * Packaged ArgoIDE intentionally blocks remote scripts, so configure the
 * already-installed module and its workers before the first Editor mounts.
 */
const monacoScope = self as typeof self & {
  MonacoEnvironment: { getWorker: (workerId: string, label: string) => Worker }
}
monacoScope.MonacoEnvironment = {
  getWorker: (_workerId, label) => {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker()
    return new EditorWorker()
  }
}
loader.config({ monaco })

/** Map a file extension to a Monaco language id. */
export function languageOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript', json: 'json', jsonc: 'json',
    py: 'python', pyi: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c',
    cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp', m: 'objective-c', mm: 'objective-c',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'powershell',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    xml: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
    md: 'markdown', markdown: 'markdown', sql: 'sql', graphql: 'graphql',
    lua: 'lua', r: 'r', jl: 'julia', dockerfile: 'dockerfile'
  }
  return map[ext] ?? 'plaintext'
}

interface CodeEditorProps {
  path: string
  projectRoot: string
  /** A tab-owned draft survives tab switches and cross-split moves. */
  draft?: string
  dirty: boolean
  onDraftChange: (value: string, dirty: boolean) => void
  onSaved: (value: string) => void
}

/** Editable Monaco with explicit save, Cmd/Ctrl+S, and a plain-text fallback. */
export function CodeEditor({
  path,
  projectRoot,
  draft,
  dirty,
  onDraftChange,
  onSaved
}: CodeEditorProps): JSX.Element {
  const [diskContent, setDiskContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editorReady, setEditorReady] = useState(false)
  const [editorTimedOut, setEditorTimedOut] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [staleOnDisk, setStaleOnDisk] = useState(false)
  const currentValueRef = useRef('')
  const saveRef = useRef<() => Promise<void>>(async () => undefined)
  // Latest dirty flag for the disk-change listener, which outlives this render.
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  useEffect(() => {
    let cancelled = false
    setDiskContent(null)
    setError(null)
    setEditorReady(false)
    setEditorTimedOut(false)
    setSaveState('idle')
    setSaveError(null)
    setStaleOnDisk(false)
    window.api.fs
      .readText(path)
      .then((text) => !cancelled && setDiskContent(text))
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [path])

  /**
   * The AI Agent can write files this editor has open.
   *
   * A clean tab silently reloads. A tab with unsaved edits must not: the
   * user's draft is the one thing we can't recover, so it stays and they get
   * told the file moved underneath them.
   */
  useEffect(
    () =>
      window.api.fs.onFileChanged((changed) => {
        if (changed !== path) return
        if (dirtyRef.current) {
          setStaleOnDisk(true)
          return
        }
        window.api.fs
          .readText(path)
          .then(setDiskContent)
          .catch((err: Error) => setError(err.message))
      }),
    [path]
  )

  // Never strand the editor on a spinner again. If Monaco cannot initialize
  // for an unexpected platform reason, the file remains readable as plain text.
  useEffect(() => {
    if (diskContent === null || editorReady) return
    const timer = window.setTimeout(() => setEditorTimedOut(true), 8_000)
    return () => window.clearTimeout(timer)
  }, [diskContent, editorReady])

  const value = draft ?? diskContent ?? ''
  currentValueRef.current = value

  const save = useCallback(async (): Promise<void> => {
    if (diskContent === null || saveState === 'saving') return
    const next = currentValueRef.current
    setSaveState('saving')
    setSaveError(null)
    try {
      await window.api.fs.writeText(projectRoot, path, next)
      setDiskContent(next)
      onSaved(next)
      setSaveState('saved')
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
      setSaveState('error')
    }
  }, [diskContent, onSaved, path, projectRoot, saveState])
  saveRef.current = save

  const changeDraft = (next: string): void => {
    currentValueRef.current = next
    onDraftChange(next, next !== diskContent)
    setSaveState('idle')
    setSaveError(null)
  }

  const saveLabel =
    saveState === 'saving'
      ? 'Saving…'
      : saveState === 'error'
        ? `Save failed: ${saveError ?? 'Unknown error'}`
        : dirty
          ? 'Unsaved changes'
          : saveState === 'saved'
            ? 'Saved'
            : 'Ready'

  const reloadFromDisk = (): void => {
    setStaleOnDisk(false)
    window.api.fs
      .readText(path)
      .then((text) => {
        setDiskContent(text)
        // Drop the draft: the user explicitly chose the disk copy.
        onDraftChange(text, false)
      })
      .catch((err: Error) => setError(err.message))
  }

  const statusBar = (
    <div
      className={`editor-status${saveState === 'error' ? ' is-error' : ''}${staleOnDisk ? ' is-stale' : ''}`}
    >
      <span className="editor-status__message" title={saveError ?? undefined}>
        {staleOnDisk ? 'Changed on disk — your unsaved edits are kept' : saveLabel}
      </span>
      {staleOnDisk && (
        <button className="btn btn--sm" onClick={reloadFromDisk} title="Discard edits and reload">
          Reload
        </button>
      )}
      <span className="editor-status__shortcut">⌘S</span>
      <button
        className="btn btn--sm"
        disabled={!dirty || saveState === 'saving'}
        onClick={() => void save()}
        title="Save file (⌘S)"
      >
        Save
      </button>
    </div>
  )

  if (error) return <div className="empty-state">{error}</div>
  if (diskContent === null) return <div className="empty-state">Loading…</div>
  if (editorTimedOut) {
    return (
      <div className="code-editor">
        <div className="banner banner--warn">
          Syntax highlighting could not start. Editing as plain text.
        </div>
        <textarea
          className="code-fallback"
          value={value}
          spellCheck={false}
          onChange={(event) => changeDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
              event.preventDefault()
              void save()
            }
          }}
        />
        {statusBar}
      </div>
    )
  }

  return (
    <div className="code-editor">
      <div className="code-editor__surface">
        <Editor
          height="100%"
          theme="vs-dark"
          path={path}
          language={languageOf(path)}
          value={value}
          loading={<div className="empty-state">Starting local editor…</div>}
          onChange={(next) => changeDraft(next ?? '')}
          onMount={(editor) => {
            setEditorReady(true)
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
              void saveRef.current()
            })
          }}
          options={{
            minimap: { enabled: true, maxColumn: 70 },
            fontSize: 12.5,
            fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, monospace",
            scrollBeyondLastLine: false,
            renderWhitespace: 'selection',
            smoothScrolling: true,
            automaticLayout: true
          }}
        />
      </div>
      {statusBar}
    </div>
  )
}

/**
 * PDF preview via Chromium's built-in viewer.
 *
 * The file is served over the app's `argo-file:` scheme (see
 * src/main/protocol.ts). A `data:` URL cannot work here — Chromium refuses to
 * navigate a frame to one — and `file://` is unreachable from the renderer's
 * origin. The scheme also streams and supports range requests, so a large
 * document starts rendering before it has fully loaded.
 */
export function PdfViewer({ path }: { path: string }): JSX.Element {
  return <iframe className="editor-frame" src={window.api.fs.url(path)} title={path} />
}

export function ImageViewer({ path }: { path: string }): JSX.Element {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        overflow: 'auto',
        background: 'var(--bg-0)'
      }}
    >
      <img
        src={window.api.fs.url(path)}
        alt={path}
        style={{ maxWidth: '100%', maxHeight: '100%' }}
      />
    </div>
  )
}

/**
 * Embedded browser.
 *
 * Uses <webview>, which runs the page in a separate process with its own
 * origin — an <iframe> would inherit the app's CSP and be blocked for most
 * external sites. React doesn't know the tag, so attributes are set on the DOM
 * node directly.
 */
interface WebViewerProps {
  initialUrl: string
  /** Keep the tab's current address when it is moved or remounted. */
  onUrlChange: (url: string) => void
}

interface WebViewElement extends HTMLElement {
  loadURL?: (url: string) => Promise<void>
  reload?: () => void
}

export function WebViewer({ initialUrl, onUrlChange }: WebViewerProps): JSX.Element {
  const [input, setInput] = useState(initialUrl)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<WebViewElement | null>(null)
  const onUrlChangeRef = useRef(onUrlChange)
  onUrlChangeRef.current = onUrlChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = document.createElement('webview') as WebViewElement
    view.setAttribute('src', initialUrl)
    view.setAttribute('partition', 'persist:argo-ide-browser')
    view.setAttribute('allowpopups', 'false')
    view.style.width = '100%'
    view.style.height = '100%'
    view.style.background = '#fff'

    const trackNavigation = (event: Event): void => {
      const next = (event as Event & { url?: string }).url
      if (!next) return
      setInput(next)
      onUrlChangeRef.current(next)
    }
    view.addEventListener('did-navigate', trackNavigation)
    view.addEventListener('did-navigate-in-page', trackNavigation)
    host.appendChild(view)
    viewRef.current = view
    return () => {
      view.removeEventListener('did-navigate', trackNavigation)
      view.removeEventListener('did-navigate-in-page', trackNavigation)
      view.remove()
      viewRef.current = null
    }
    // The active viewer is keyed by tab id. Moving or reactivating the tab
    // remounts it with the latest URL already stored in the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const go = (): void => {
    const trimmed = input.trim()
    if (!trimmed) return
    const destination = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    setInput(destination)
    onUrlChangeRef.current(destination)
    if (viewRef.current?.loadURL) void viewRef.current.loadURL(destination)
    else viewRef.current?.setAttribute('src', destination)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="urlbar">
        <GlobeIcon size={13} />
        <input
          className="input mono"
          value={input}
          spellCheck={false}
          placeholder="https://…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
        <button
          className="icon-btn"
          title="Reload"
          onClick={() => viewRef.current?.reload?.()}
        >
          <RefreshIcon size={13} />
        </button>
      </div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  )
}
