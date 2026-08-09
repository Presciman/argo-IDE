import { Fragment, JSX, useCallback, useRef, useState } from 'react'
import Splitter from './Splitter'
import { CodeViewer, ImageViewer, PdfViewer, WebViewer } from './viewers'
import { CloseIcon, GlobeIcon, SplitIcon } from './Icons'

export interface ViewerTab {
  id: string
  kind: 'text' | 'image' | 'pdf' | 'binary' | 'web'
  /** File path, or the initial URL for a web tab. */
  target: string
  label: string
}

interface Props {
  /** One group per horizontal row. The pane starts as a single row. */
  groups: ViewerTab[][]
  activeIds: (string | null)[]
  onActivate: (groupIndex: number, tabId: string) => void
  onClose: (groupIndex: number, tabId: string) => void
  onNewWebTab: (groupIndex: number) => void
  onSplit: () => void
  onUnsplit: (groupIndex: number) => void
}

function renderTab(tab: ViewerTab): JSX.Element {
  switch (tab.kind) {
    case 'web':
      return <WebViewer initialUrl={tab.target} />
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
      return <CodeViewer path={tab.target} />
  }
}

export default function ViewerPane(props: Props): JSX.Element {
  // Row heights as flex weights, so a window resize keeps the proportions.
  const [weights, setWeights] = useState<number[]>([1])
  const hostRef = useRef<HTMLDivElement>(null)

  const resizeRow = useCallback((index: number, deltaPx: number) => {
    const height = hostRef.current?.clientHeight ?? 600
    setWeights((prev) => {
      const next = [...prev]
      // A newly-added row may not have a weight yet.
      while (next.length < index + 2) next.push(1)
      const total = next.reduce((a, b) => a + b, 0)
      const shift = deltaPx * (total / Math.max(height, 1))
      const a = next[index] + shift
      const b = next[index + 1] - shift
      // Refuse a drag that would collapse either row past a usable minimum.
      const min = total * 0.08
      if (a < min || b < min) return prev
      next[index] = a
      next[index + 1] = b
      return next
    })
  }, [])

  return (
    <div className="pane" style={{ flex: '1.4 1 0' }}>
      <div className="viewer-split" ref={hostRef}>
        {props.groups.map((tabs, gi) => {
          const activeId = props.activeIds[gi]
          const active = tabs.find((t) => t.id === activeId) ?? tabs[0]

          return (
            <Fragment key={gi}>
              {gi > 0 && (
                <Splitter orientation="h" onDrag={(d) => resizeRow(gi - 1, d)} />
              )}

              <div
                style={{
                  flex: `${weights[gi] ?? 1} 1 0`,
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                  borderTop: gi > 0 ? '1px solid var(--border)' : undefined
                }}
              >
                <div className="pane__header">
                  <div className="tabs">
                    {tabs.length === 0 && <span className="pane__title">Viewer</span>}
                    {tabs.map((t) => (
                      <div
                        key={t.id}
                        className={`tab${t.id === active?.id ? ' is-active' : ''}`}
                        onClick={() => props.onActivate(gi, t.id)}
                        title={t.target}
                      >
                        <span className="tab__label">{t.label}</span>
                        <button
                          className="tab__close"
                          onClick={(e) => {
                            e.stopPropagation()
                            props.onClose(gi, t.id)
                          }}
                        >
                          <CloseIcon size={12} />
                        </button>
                      </div>
                    ))}
                  </div>

                  <button
                    className="icon-btn"
                    onClick={() => props.onNewWebTab(gi)}
                    title="New browser tab"
                  >
                    <GlobeIcon size={14} />
                  </button>
                  {gi === 0 ? (
                    <button className="icon-btn" onClick={props.onSplit} title="Split horizontally">
                      <SplitIcon size={14} />
                    </button>
                  ) : (
                    <button
                      className="icon-btn"
                      onClick={() => props.onUnsplit(gi)}
                      title="Close this split"
                    >
                      <CloseIcon size={13} />
                    </button>
                  )}
                </div>

                <div className="pane__body" style={{ overflow: 'hidden' }}>
                  {active ? (
                    // Keying on tab id remounts the viewer when the tab changes,
                    // so no stale Monaco model or webview survives the switch.
                    <div key={active.id} style={{ height: '100%' }}>
                      {renderTab(active)}
                    </div>
                  ) : (
                    <div className="empty-state">
                      <div>Nothing open.</div>
                      <div>Pick a file in the explorer, or open a browser tab.</div>
                      <button className="btn btn--sm" onClick={() => props.onNewWebTab(gi)}>
                        New Browser Tab
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
