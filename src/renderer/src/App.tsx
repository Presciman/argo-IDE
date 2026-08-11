import { JSX, useCallback, useEffect, useRef, useState } from 'react'
import { AppSettings, DEFAULT_SETTINGS, ShimStatus } from '../../shared/types'
import FileExplorer from './components/FileExplorer'
import ChatPane from './components/ChatPane'
import EditorPane from './components/EditorPane'
import TerminalPanel from './components/TerminalPanel'
import SettingsModal from './components/SettingsModal'
import ConnectModal from './components/ConnectModal'
import Splitter from './components/Splitter'
import * as layout from './editorLayout'
import { EditorLayout, EditorTab } from './editorLayout'
import { NewWindowIcon, TerminalIcon } from './components/Icons'

const uid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

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

  // Editor state. The whole split layout — rows, cells, sizes, focus — is one
  // object, because every mutation touches several of those at once and a
  // React state updater must stay pure (StrictMode invokes it twice).
  const [editor, setEditor] = useState<EditorLayout>(layout.initialLayout)

  // Column widths as flex weights: explorer | chat | editor.
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

  // ---------------------------------------------------------------- editor

  const openFile = useCallback(
    async (path: string) => {
      setSelectedPath(path)
      const kind = await window.api.fs.classify(path)
      const label = path.split('/').pop() ?? path
      const tab: EditorTab = { id: uid(), kind, target: path, label, root: root ?? undefined }
      // openTab focuses an already-open copy rather than duplicating it.
      setEditor((prev) => layout.openTab(prev, tab))
    },
    [root]
  )

  const pickRoot = useCallback(async () => {
    const dir = await window.api.fs.pickFolder()
    if (dir) setRoot(dir)
  }, [])

  const newWebTab = useCallback((groupId: string) => {
    const tab: EditorTab = {
      id: uid(),
      kind: 'web',
      target: 'https://www.alcf.anl.gov',
      label: 'Browser'
    }
    setEditor((prev) => layout.openTab(prev, tab, groupId))
  }, [])

  const closeTab = useCallback((groupId: string, tabId: string) => {
    setEditor((prev) => layout.closeTab(prev, groupId, tabId))
  }, [])

  const activateTab = useCallback((groupId: string, tabId: string) => {
    setEditor((prev) => layout.activateTab(prev, groupId, tabId))
  }, [])

  const updateTab = useCallback((groupId: string, tabId: string, patch: Partial<EditorTab>) => {
    setEditor((prev) => layout.updateTab(prev, groupId, tabId, patch))
  }, [])

  const moveTab = useCallback((sourceGroupId: string, targetGroupId: string, tabId: string) => {
    setEditor((prev) => layout.moveTab(prev, sourceGroupId, targetGroupId, tabId))
  }, [])

  const splitEditorRight = useCallback((groupId: string) => {
    setEditor((prev) => layout.splitRight(prev, groupId))
  }, [])

  const splitEditorDown = useCallback((groupId: string) => {
    setEditor((prev) => layout.splitDown(prev, groupId))
  }, [])

  const closeEditorGroup = useCallback((groupId: string) => {
    setEditor((prev) => layout.closeGroup(prev, groupId))
  }, [])

  const focusEditorGroup = useCallback((groupId: string) => {
    setEditor((prev) => (prev.focusedId === groupId ? prev : { ...prev, focusedId: groupId }))
  }, [])

  const resizeEditorRows = useCallback((index: number, deltaPx: number, hostHeight: number) => {
    setEditor((prev) => layout.resizeRows(prev, index, deltaPx, hostHeight))
  }, [])

  const resizeEditorColumns = useCallback(
    (rowId: string, index: number, deltaPx: number, hostWidth: number) => {
      setEditor((prev) => layout.resizeColumns(prev, rowId, index, deltaPx, hostWidth))
    },
    []
  )

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
              projectRoot={root}
              onOpenSettings={() => setShowSettings(true)}
              onOpenConnect={() => setShowConnect(true)}
            />
          </div>

          <Splitter orientation="v" onDrag={(d) => resizeColumn(1, d)} />

          <div style={{ flex: `${columnWeights[2]} 1 0`, display: 'flex', minWidth: 0 }}>
            <EditorPane
              layout={editor}
              onActivate={activateTab}
              onClose={closeTab}
              onUpdateTab={updateTab}
              onMoveTab={moveTab}
              onNewWebTab={newWebTab}
              onSplitRight={splitEditorRight}
              onSplitDown={splitEditorDown}
              onCloseGroup={closeEditorGroup}
              onFocusGroup={focusEditorGroup}
              onResizeRows={resizeEditorRows}
              onResizeColumns={resizeEditorColumns}
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
                idPrefix={terminalId}
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
