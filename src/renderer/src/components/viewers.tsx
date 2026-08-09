import { JSX, useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import { GlobeIcon, RefreshIcon } from './Icons'

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

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(null)
    window.api.fs
      .readText(path)
      .then((text) => !cancelled && setContent(text))
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [path])

  if (error) return <div className="empty-state">{error}</div>
  if (content === null) return <div className="empty-state">Loading…</div>

  return (
    <Editor
      height="100%"
      theme="vs-dark"
      path={path}
      language={languageOf(path)}
      value={content}
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
 * The file is passed as a data: URL rather than file://, because the renderer
 * runs from a custom origin and cannot navigate a frame to file:// under our
 * CSP. That means the whole PDF is loaded into memory — fine for papers and
 * docs, which is what this pane is for.
 */
export function PdfViewer({ path }: { path: string }): JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setError(null)
    window.api.fs
      .dataUrl(path, 'application/pdf')
      .then((url) => !cancelled && setSrc(url))
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [path])

  if (error) return <div className="empty-state">{error}</div>
  if (!src) return <div className="empty-state">Loading PDF…</div>
  return <iframe className="viewer-frame" src={src} title={path} />
}

export function ImageViewer({ path }: { path: string }): JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const ext = path.split('.').pop()?.toLowerCase() ?? 'png'
  const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`

  useEffect(() => {
    let cancelled = false
    setSrc(null)
    window.api.fs.dataUrl(path, mime).then((url) => !cancelled && setSrc(url))
    return () => {
      cancelled = true
    }
  }, [path, mime])

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
      {src ? (
        <img src={src} alt={path} style={{ maxWidth: '100%', maxHeight: '100%' }} />
      ) : (
        <span style={{ color: 'var(--fg-2)' }}>Loading…</span>
      )}
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
