import { JSX, useCallback, useEffect, useRef, useState } from 'react'
import { AppSettings, DEFAULT_SETTINGS, ShimStatus } from '../../shared/types'
import FileExplorer from './components/FileExplorer'
import ChatPane from './components/ChatPane'
import ViewerPane, { ViewerTab } from './components/ViewerPane'
import TerminalPanel from './components/TerminalPanel'
import SettingsModal from './components/SettingsModal'
import ConnectModal from './components/ConnectModal'
import Splitter from './components/Splitter'
import { NewWindowIcon, TerminalIcon } from './components/Icons'

const uid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** Horizontal viewer rows and which tab is active in each. Kept in lockstep. */
interface ViewerState {
  groups: ViewerTab[][]
  activeIds: (string | null)[]
}

const MAX_VIEWER_ROWS = 3

const INITIAL_STATUS: ShimStatus = {
  state: 'disconnected',
  baseUrl: '',
  port: 0,
  hasToken: false,
  message: '',
  ownsProcess: false
}

export default function App(): JSX.Element {
  // Main-process PTYs are shared by every BrowserWindow. A per-renderer id
  // prevents a second window from replacing the first window's terminal.
  const terminalId = useRef(`main-${uid()}`).current
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [status, setStatus] = useState<ShimStatus>(INITIAL_STATUS)
  const [showSettings, setShowSettings] = useState(false)
  const [showConnect, setShowConnect] = useState(false)

  const [root, setRoot] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  // Viewer state. Rows and their active tabs are one object rather than two
  // pieces of state: every mutation touches both, and a React state updater
  // must stay pure (StrictMode invokes it twice), so they cannot be nested.
  const [viewer, setViewer] = useState<ViewerState>({ groups: [[]], activeIds: [null] })

  // Column widths as flex weights: explorer | chat | viewer.
  const [columnWeights, setColumnWeights] = useState<[number, number, number]>([0.9, 1.15, 1.4])
  const [terminalHeight, setTerminalHeight] = useState(240)
  const [terminalOpen, setTerminalOpen] = useState(true)
  const [terminalNonce, setTerminalNonce] = useState(0)

  // ------------------------------------------------------------- bootstrap

  useEffect(() => {
    void window.api.settings.get().then(setSettings)
    void window.api.shim.status().then(setStatus)
    return window.api.shim.onState(setStatus)
  }, [])

  // On launch, probe once: a shim left running from an earlier session (or an
  // intranet connection) means we're already usable with no user action.
  useEffect(() => {
    void window.api.shim.verify()
  }, [])

  const saveSettings = useCallback(async (patch: Partial<AppSettings>) => {
    setSettings(await window.api.settings.save(patch))
    // Base URL and port may have changed; re-probe against the new target.
    void window.api.shim.verify()
  }, [])

  // ---------------------------------------------------------------- viewer

  const openFile = useCallback(async (path: string) => {
    setSelectedPath(path)
    const kind = await window.api.fs.classify(path)
    const label = path.split('/').pop() ?? path

    setViewer((prev) => {
      // Focus an already-open tab instead of opening a duplicate.
      const existing = prev.groups[0].find((t) => t.target === path && t.kind !== 'web')
      if (existing) {
        return { ...prev, activeIds: [existing.id, ...prev.activeIds.slice(1)] }
      }
      const tab: ViewerTab = { id: uid(), kind, target: path, label }
      return {
        groups: [[...prev.groups[0], tab], ...prev.groups.slice(1)],
        activeIds: [tab.id, ...prev.activeIds.slice(1)]
      }
    })
  }, [])

  const pickRoot = useCallback(async () => {
    const dir = await window.api.fs.pickFolder()
    if (dir) setRoot(dir)
  }, [])

  const newWebTab = useCallback((gi: number) => {
    setViewer((prev) => {
      const tab: ViewerTab = {
        id: uid(),
        kind: 'web',
        target: 'https://www.alcf.anl.gov',
        label: 'Browser'
      }
      return {
        groups: prev.groups.map((g, i) => (i === gi ? [...g, tab] : g)),
        activeIds: prev.activeIds.map((id, i) => (i === gi ? tab.id : id))
      }
    })
  }, [])

  const closeTab = useCallback((gi: number, tabId: string) => {
    setViewer((prev) => {
      const remaining = prev.groups[gi].filter((t) => t.id !== tabId)
      return {
        groups: prev.groups.map((g, i) => (i === gi ? remaining : g)),
        // Closing the active tab falls back to the last one still open.
        activeIds: prev.activeIds.map((id, i) =>
          i === gi && id === tabId ? (remaining.at(-1)?.id ?? null) : id
        )
      }
    })
  }, [])

  const activateTab = useCallback((gi: number, tabId: string) => {
    setViewer((prev) => ({
      ...prev,
      activeIds: prev.activeIds.map((id, i) => (i === gi ? tabId : id))
    }))
  }, [])

  const splitViewer = useCallback(() => {
    setViewer((prev) =>
      prev.groups.length >= MAX_VIEWER_ROWS
        ? prev
        : { groups: [...prev.groups, []], activeIds: [...prev.activeIds, null] }
    )
  }, [])

  const unsplitViewer = useCallback((gi: number) => {
    setViewer((prev) => ({
      groups: prev.groups.filter((_, i) => i !== gi),
      activeIds: prev.activeIds.filter((_, i) => i !== gi)
    }))
  }, [])

  // --------------------------------------------------------------- layout

  const resizeColumn = useCallback((index: 0 | 1, deltaPx: number) => {
    setColumnWeights((prev) => {
      const width = window.innerWidth || 1600
      const total = prev[0] + prev[1] + prev[2]
      const shift = deltaPx * (total / width)
      const next: [number, number, number] = [...prev]
      const a = next[index] + shift
      const b = next[index + 1] - shift
      const min = total * 0.1
      if (a < min || b < min) return prev
      next[index] = a
      next[index + 1] = b
      return next
    })
  }, [])

  const resizeTerminal = useCallback((deltaPx: number) => {
    // Dragging the handle up (negative delta) makes the terminal taller.
    setTerminalHeight((h) => Math.min(Math.max(h - deltaPx, 90), window.innerHeight - 220))
  }, [])

  return (
    <div className="app">
      <div className="titlebar">
        <span className="titlebar__title">ArgoIDE</span>
        <span className="titlebar__spacer" />
        <span className="status-line">
          <span className={`status-dot status-dot--${status.state}`} />
          <span className="status-line__text">
            {status.state === 'connected'
              ? settings.useShim
                ? `shim :${status.port}`
                : 'intranet (direct)'
              : status.state}
          </span>
        </span>
        <button className="icon-btn" onClick={() => window.api.app.newWindow()} title="New window (⌘N)">
          <NewWindowIcon size={14} />
        </button>
        <button
          className={`icon-btn${terminalOpen ? ' is-active' : ''}`}
          onClick={() => setTerminalOpen((v) => !v)}
          title="Toggle terminal"
        >
          <TerminalIcon size={14} />
        </button>
      </div>

      <div className="workspace" style={{ flexDirection: 'column' }}>
        <div className="columns" style={{ flex: 1, minHeight: 0 }}>
          <div style={{ flex: `${columnWeights[0]} 1 0`, display: 'flex', minWidth: 0 }}>
            <FileExplorer
              root={root}
              selectedPath={selectedPath}
              onOpenFile={openFile}
              onPickRoot={pickRoot}
            />
          </div>

          <Splitter orientation="v" onDrag={(d) => resizeColumn(0, d)} />

          <div style={{ flex: `${columnWeights[1]} 1 0`, display: 'flex', minWidth: 0 }}>
            <ChatPane
              settings={settings}
              status={status}
              onOpenSettings={() => setShowSettings(true)}
              onOpenConnect={() => setShowConnect(true)}
            />
          </div>

          <Splitter orientation="v" onDrag={(d) => resizeColumn(1, d)} />

          <div style={{ flex: `${columnWeights[2]} 1 0`, display: 'flex', minWidth: 0 }}>
            <ViewerPane
              groups={viewer.groups}
              activeIds={viewer.activeIds}
              onActivate={activateTab}
              onClose={closeTab}
              onNewWebTab={newWebTab}
              onSplit={splitViewer}
              onUnsplit={unsplitViewer}
            />
          </div>
        </div>

        {terminalOpen && (
          <>
            <Splitter
              orientation="h"
              onDrag={resizeTerminal}
              onDragEnd={() => setTerminalNonce((n) => n + 1)}
            />
            <div style={{ height: terminalHeight, flex: '0 0 auto', minHeight: 0 }}>
              <TerminalPanel
                id={terminalId}
                cwd={root}
                resizeNonce={terminalNonce}
                onToggle={() => setTerminalOpen(false)}
              />
            </div>
          </>
        )}
      </div>

      {showSettings && (
        <SettingsModal
          settings={settings}
          status={status}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showConnect && (
        <ConnectModal
          settings={settings}
          status={status}
          onClose={() => setShowConnect(false)}
        />
      )}
    </div>
  )
}
