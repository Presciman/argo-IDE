import {
  Fragment,
  JSX,
  PointerEvent as ReactPointerEvent,
  useRef,
  useState
} from 'react'
import Splitter from './Splitter'
import { CodeEditor, ImageViewer, PdfViewer, WebViewer } from './viewers'
import {
  canSplitDown,
  canSplitRight,
  EditorGroup,
  EditorLayout,
  EditorTab,
  groupCount
} from '../editorLayout'
import { CloseIcon, GlobeIcon, SplitDownIcon, SplitRightIcon } from './Icons'

interface Props {
  layout: EditorLayout
  onActivate: (groupId: string, tabId: string) => void
  onClose: (groupId: string, tabId: string) => void
  onUpdateTab: (groupId: string, tabId: string, patch: Partial<EditorTab>) => void
  onMoveTab: (sourceGroupId: string, targetGroupId: string, tabId: string) => void
  onNewWebTab: (groupId: string) => void
  onSplitRight: (groupId: string) => void
  onSplitDown: (groupId: string) => void
  onCloseGroup: (groupId: string) => void
  onFocusGroup: (groupId: string) => void
  onResizeRows: (index: number, deltaPx: number, hostHeight: number) => void
  onResizeColumns: (rowId: string, index: number, deltaPx: number, hostWidth: number) => void
}

interface DraggedTab {
  sourceGroupId: string
  tabId: string
}

interface PendingTabDrag extends DraggedTab {
  pointerId: number
  startX: number
  startY: number
}

function renderTab(tab: EditorTab, onPatch: (patch: Partial<EditorTab>) => void): JSX.Element {
  switch (tab.kind) {
    case 'web':
      return <WebViewer initialUrl={tab.target} onUrlChange={(target) => onPatch({ target })} />
    case 'pdf':
      return <PdfViewer path={tab.target} />
    case 'image':
      return <ImageViewer path={tab.target} />
    case 'binary':
      return (
        <div className="empty-state">
          <div>Binary file — no preview available.</div>
          <div className="mono">{tab.target}</div>
        </div>
      )
    default:
      return tab.root ? (
        <CodeEditor
          path={tab.target}
          projectRoot={tab.root}
          draft={tab.draft}
          dirty={tab.dirty ?? false}
          onDraftChange={(draft, dirty) => onPatch({ draft, dirty })}
          onSaved={(draft) => onPatch({ draft, dirty: false })}
        />
      ) : (
        <div className="empty-state">This file is no longer associated with an Explorer folder.</div>
      )
  }
}

export default function EditorPane(props: Props): JSX.Element {
  const [dragged, setDragged] = useState<DraggedTab | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement | null>())
  const pendingDragRef = useRef<PendingTabDrag | null>(null)
  const draggedRef = useRef<DraggedTab | null>(null)
  const suppressClickRef = useRef(false)

  const setCurrentDropTarget = (target: string | null): void => {
    setDropTarget(target)
  }

  /** Which group is under the pointer, ignoring the one being dragged from. */
  const groupAtPoint = (x: number, y: number, sourceGroupId: string): string | null => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-editor-group]')) {
      const id = el.dataset.editorGroup
      if (!id || id === sourceGroupId) continue
      const rect = el.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return id
    }
    return null
  }

  const pointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    sourceGroupId: string,
    tabId: string
  ): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    pendingDragRef.current = {
      sourceGroupId,
      tabId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pending = pendingDragRef.current
    if (!pending || pending.pointerId !== event.pointerId) return
    const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY)
    if (!draggedRef.current && distance < 6) return

    event.preventDefault()
    if (!draggedRef.current) {
      const payload: DraggedTab = { sourceGroupId: pending.sourceGroupId, tabId: pending.tabId }
      draggedRef.current = payload
      setDragged(payload)
    }
    const target = groupAtPoint(event.clientX, event.clientY, pending.sourceGroupId)
    setCurrentDropTarget(target)

    // Commit on entry instead of waiting for drop. Chromium webviews, PDF
    // frames, and Monaco can consume the final mouse-up; pointer capture lets
    // us reliably transfer at the moment the highlighted split is reached.
    const payload = draggedRef.current
    if (payload && target !== null) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      pendingDragRef.current = null
      draggedRef.current = null
      setDragged(null)
      setCurrentDropTarget(null)
      suppressClickRef.current = true
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
      props.onMoveTab(payload.sourceGroupId, target, payload.tabId)
    }
  }

  const endPointerDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pending = pendingDragRef.current
    if (!pending || pending.pointerId !== event.pointerId) return
    const payload = draggedRef.current
    const target = groupAtPoint(event.clientX, event.clientY, pending.sourceGroupId)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    pendingDragRef.current = null
    draggedRef.current = null
    setDragged(null)
    setCurrentDropTarget(null)

    if (payload) {
      suppressClickRef.current = true
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
      if (target !== null) props.onMoveTab(payload.sourceGroupId, target, payload.tabId)
    }
  }

  const cancelPointerDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (pendingDragRef.current?.pointerId !== event.pointerId) return
    pendingDragRef.current = null
    draggedRef.current = null
    setDragged(null)
    setCurrentDropTarget(null)
  }

  const multipleGroups = groupCount(props.layout) > 1

  const renderGroup = (group: EditorGroup): JSX.Element => {
    const active = group.tabs.find((t) => t.id === group.activeId) ?? group.tabs[0]
    const focused = props.layout.focusedId === group.id

    return (
      <div
        className={`editor-group${dropTarget === group.id ? ' is-drop-target' : ''}${
          focused && multipleGroups ? ' is-focused' : ''
        }`}
        style={{ flex: `${group.weight} 1 0` }}
        data-editor-group={group.id}
        key={group.id}
        onMouseDown={() => !focused && props.onFocusGroup(group.id)}
      >
        <div className="pane__header">
          <div className="tabs">
            {group.tabs.length === 0 && <span className="pane__title">Editor</span>}
            {group.tabs.map((tab) => {
              const isDragged = dragged?.tabId === tab.id
              return (
                <div
                  key={tab.id}
                  className={`tab${tab.id === active?.id ? ' is-active' : ''}${isDragged ? ' is-dragging' : ''}`}
                  onPointerDown={(event) => pointerDown(event, group.id, tab.id)}
                  onPointerMove={pointerMove}
                  onPointerUp={endPointerDrag}
                  onPointerCancel={cancelPointerDrag}
                  onClick={(event) => {
                    if (suppressClickRef.current) {
                      event.preventDefault()
                      return
                    }
                    props.onActivate(group.id, tab.id)
                  }}
                  title={`${tab.target}${tab.dirty ? ' — unsaved changes' : ''}`}
                >
                  <span className="tab__label">{tab.label}</span>
                  {tab.dirty && <span className="tab__dirty" title="Unsaved changes" />}
                  <button
                    className="tab__close"
                    onClick={(event) => {
                      event.stopPropagation()
                      if (tab.dirty && !window.confirm(`Discard unsaved changes to ${tab.label}?`)) {
                        return
                      }
                      props.onClose(group.id, tab.id)
                    }}
                    title={`Close ${tab.label}`}
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              )
            })}
          </div>

          <button
            className="icon-btn"
            onClick={() => props.onNewWebTab(group.id)}
            title="New browser tab"
          >
            <GlobeIcon size={14} />
          </button>
          <button
            className="icon-btn"
            onClick={() => props.onSplitRight(group.id)}
            disabled={!canSplitRight(props.layout, group.id)}
            title="Split right"
          >
            <SplitRightIcon size={14} />
          </button>
          <button
            className="icon-btn"
            onClick={() => props.onSplitDown(group.id)}
            disabled={!canSplitDown(props.layout)}
            title="Split down"
          >
            <SplitDownIcon size={14} />
          </button>
          {multipleGroups && (
            <button
              className="icon-btn"
              onClick={() => props.onCloseGroup(group.id)}
              title="Close this split and keep its tabs"
            >
              <CloseIcon size={13} />
            </button>
          )}
        </div>

        <div className="pane__body" style={{ overflow: 'hidden' }}>
          {active ? (
            // Keying on tab id remounts the editor when the tab changes.
            // Draft and navigation state live on the tab, not the mount.
            <div key={active.id} style={{ height: '100%' }}>
              {renderTab(active, (patch) => props.onUpdateTab(group.id, active.id, patch))}
            </div>
          ) : (
            <div className="empty-state">
              <div>Nothing open.</div>
              <div>Pick a file in the explorer, or drag a tab into this split.</div>
              <button className="btn btn--sm" onClick={() => props.onNewWebTab(group.id)}>
                New Browser Tab
              </button>
            </div>
          )}
        </div>

        {dragged && dragged.sourceGroupId !== group.id && (
          <div className="editor-drop-zone">
            <span>Move tab here</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="pane" style={{ flex: '1.4 1 0' }}>
      <div className="editor-split" ref={hostRef}>
        {props.layout.rows.map((row, rowIndex) => (
          <Fragment key={row.id}>
            {rowIndex > 0 && (
              <Splitter
                orientation="h"
                onDrag={(d) => props.onResizeRows(rowIndex - 1, d, hostRef.current?.clientHeight ?? 600)}
              />
            )}
            <div
              className="editor-row"
              style={{ flex: `${row.weight} 1 0` }}
              ref={(el) => {
                rowRefs.current.set(row.id, el)
              }}
            >
              {row.cells.map((cell, cellIndex) => (
                <Fragment key={cell.id}>
                  {cellIndex > 0 && (
                    <Splitter
                      orientation="v"
                      onDrag={(d) =>
                        props.onResizeColumns(
                          row.id,
                          cellIndex - 1,
                          d,
                          rowRefs.current.get(row.id)?.clientWidth ?? 800
                        )
                      }
                    />
                  )}
                  {renderGroup(cell)}
                </Fragment>
              ))}
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  )
}
