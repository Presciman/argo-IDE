import { JSX, useEffect, useRef, useState } from 'react'
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

/** Read-only Monaco. The viewer pane browses code; it does not edit it. */
export function CodeViewer({ path }: { path: string }): JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editorReady, setEditorReady] = useState(false)
  const [editorTimedOut, setEditorTimedOut] = useState(false)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(null)
    setEditorReady(false)
    setEditorTimedOut(false)
    window.api.fs
      .readText(path)
      .then((text) => !cancelled && setContent(text))
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [path])

  // Never strand the viewer on a spinner again. If Monaco cannot initialize
  // for an unexpected platform reason, the file remains readable as plain text.
  useEffect(() => {
    if (content === null || editorReady) return
    const timer = window.setTimeout(() => setEditorTimedOut(true), 8_000)
    return () => window.clearTimeout(timer)
  }, [content, editorReady])

  if (error) return <div className="empty-state">{error}</div>
  if (content === null) return <div className="empty-state">Loading…</div>
  if (editorTimedOut) {
    return (
      <div className="code-fallback">
        <div className="banner banner--warn">
          Syntax highlighting could not start. Showing the file as plain text.
        </div>
        <pre>{content}</pre>
      </div>
    )
  }

  return (
    <Editor
      height="100%"
      theme="vs-dark"
      path={path}
      language={languageOf(path)}
      value={content}
      loading={<div className="empty-state">Starting local editor…</div>}
      onMount={() => setEditorReady(true)}
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: true, maxColumn: 70 },
        fontSize: 12.5,
        fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, monospace",
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        smoothScrolling: true,
        automaticLayout: true
      }}
    />
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
  return <iframe className="viewer-frame" src={window.api.fs.url(path)} title={path} />
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
export function WebViewer({ initialUrl }: { initialUrl: string }): JSX.Element {
  const [url, setUrl] = useState(initialUrl)
  const [input, setInput] = useState(initialUrl)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = document.createElement('webview')
    view.setAttribute('src', url)
    view.setAttribute('partition', 'persist:argo-ide-browser')
    view.setAttribute('allowpopups', 'false')
    view.style.width = '100%'
    view.style.height = '100%'
    view.style.background = '#fff'
    host.appendChild(view)
    viewRef.current = view
    return () => {
      view.remove()
      viewRef.current = null
    }
  }, [url])

  const go = (): void => {
    const trimmed = input.trim()
    if (!trimmed) return
    setUrl(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
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
          onClick={() => (viewRef.current as { reload?: () => void } | null)?.reload?.()}
        >
          <RefreshIcon size={13} />
        </button>
      </div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  )
}
