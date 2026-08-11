import { Fragment, JSX, useCallback, useRef, useState } from 'react'
import Splitter from './Splitter'
import TerminalView from './TerminalView'
import { CloseIcon, PlusIcon, SplitRightIcon, TerminalIcon } from './Icons'

interface Props {
  /** Prefix for PTY ids, unique per window. */
  idPrefix: string
  /** Initial working directory for new shells. */
  cwd: string | null
  /** Bumped by the parent whenever the panel is resized, to trigger a refit. */
  resizeNonce: number
  onToggle: () => void
}

interface TerminalTab {
  id: string
  label: string
}

/** One column of the panel: its own tab strip and shells. */
interface TerminalGroup {
  id: string
  tabs: TerminalTab[]
  activeId: string
  weight: number
}

const MAX_GROUPS = 3

const uid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/**
 * The bottom terminal dock.
 *
 * Holds several shells at once: tabs within a column, and up to three columns
 * side by side. Every shell stays mounted for the life of its tab — a
 * background tab is hidden with CSS, never unmounted, because unmounting kills
 * its PTY and would drop whatever is running in it.
 */
export default function TerminalPanel({
  idPrefix,
  cwd,
  resizeNonce,
  onToggle
}: Props): JSX.Element {
  const counter = useRef(1)
  const hostRef = useRef<HTMLDivElement>(null)
  const [dragNonce, setDragNonce] = useState(0)

  const newTab = useCallback((): TerminalTab => {
    const n = counter.current++
    return { id: `${idPrefix}-${uid()}`, label: `Shell ${n}` }
  }, [idPrefix])

  const [groups, setGroups] = useState<TerminalGroup[]>(() => {
    const first = { id: `${idPrefix}-${uid()}`, label: 'Shell 1' }
    counter.current = 2
    return [{ id: uid(), tabs: [first], activeId: first.id, weight: 1 }]
  })
  const [focusedGroup, setFocusedGroup] = useState<string | null>(null)

  const addTab = useCallback(
    (groupId: string) => {
      const tab = newTab()
      setGroups((prev) =>
        prev.map((g) => (g.id === groupId ? { ...g, tabs: [...g.tabs, tab], activeId: tab.id } : g))
      )
      setFocusedGroup(groupId)
    },
    [newTab]
  )

  /**
   * Close a shell. Its TerminalView unmounts, which kills the PTY.
   *
   * Emptying a column removes it, unless it is the last one — the panel always
   * keeps one shell so it is never a blank dock with no way back.
   */
  const closeTab = useCallback((groupId: string, tabId: string) => {
    setGroups((prev) => {
      const next = prev.map((g) => {
        if (g.id !== groupId) return g
        const tabs = g.tabs.filter((t) => t.id !== tabId)
        return { ...g, tabs, activeId: g.activeId === tabId ? (tabs.at(-1)?.id ?? '') : g.activeId }
      })

      const kept = next.filter((g) => g.tabs.length > 0)
      if (kept.length === 0) return prev
      if (kept.length === next.length) return next

      // Give the closed column's width back to the survivors.
      const freed = next
        .filter((g) => g.tabs.length === 0)
        .reduce((sum, g) => sum + g.weight, 0)
      const share = freed / kept.length
      return kept.map((g) => ({ ...g, weight: g.weight + share }))
    })
  }, [])

  const splitRight = useCallback(
    (groupId: string) => {
      setGroups((prev) => {
        if (prev.length >= MAX_GROUPS) return prev
        const index = prev.findIndex((g) => g.id === groupId)
        if (index < 0) return prev
        const source = prev[index]
        const half = source.weight / 2
        const tab = newTab()
        const fresh: TerminalGroup = { id: uid(), tabs: [tab], activeId: tab.id, weight: half }
        const next = [...prev]
        next.splice(index, 1, { ...source, weight: half }, fresh)
        setFocusedGroup(fresh.id)
        return next
      })
    },
    [newTab]
  )

  const closeGroup = useCallback((groupId: string) => {
    setGroups((prev) => {
      if (prev.length <= 1) return prev
      const kept = prev.filter((g) => g.id !== groupId)
      const freed = prev.find((g) => g.id === groupId)?.weight ?? 0
      const share = freed / kept.length
      return kept.map((g) => ({ ...g, weight: g.weight + share }))
    })
  }, [])

  const resize = useCallback((index: number, deltaPx: number) => {
    const width = hostRef.current?.clientWidth ?? 800
    setGroups((prev) => {
      if (index + 1 >= prev.length) return prev
      const total = prev.reduce((sum, g) => sum + g.weight, 0)
      const shift = deltaPx * (total / Math.max(width, 1))
      const a = prev[index].weight + shift
      const b = prev[index + 1].weight - shift
      const min = total * 0.12
      if (a < min || b < min) return prev
      return prev.map((g, i) =>
        i === index ? { ...g, weight: a } : i === index + 1 ? { ...g, weight: b } : g
      )
    })
    // xterm measures in character cells, so every column needs to re-fit.
    setDragNonce((n) => n + 1)
  }, [])

  const multiple = groups.length > 1

  return (
    <div className="terminal-panel" style={{ height: '100%' }}>
      <div className="terminal-columns" ref={hostRef}>
        {groups.map((group, index) => (
          <Fragment key={group.id}>
            {index > 0 && <Splitter orientation="v" onDrag={(d) => resize(index - 1, d)} />}
            <div
              className={`terminal-group${multiple && focusedGroup === group.id ? ' is-focused' : ''}`}
              style={{ flex: `${group.weight} 1 0` }}
              onMouseDown={() => setFocusedGroup(group.id)}
            >
              <div className="pane__header">
                {index === 0 && !multiple && <TerminalIcon size={13} />}
                <div className="tabs">
                  {group.tabs.map((tab) => (
                    <div
                      key={tab.id}
                      className={`tab${tab.id === group.activeId ? ' is-active' : ''}`}
                      onClick={() =>
                        setGroups((prev) =>
                          prev.map((g) => (g.id === group.id ? { ...g, activeId: tab.id } : g))
                        )
                      }
                      title={tab.label}
                    >
                      <span className="tab__label">{tab.label}</span>
                      <button
                        className="tab__close"
                        onClick={(event) => {
                          event.stopPropagation()
                          closeTab(group.id, tab.id)
                        }}
                        title={`Close ${tab.label}`}
                      >
                        <CloseIcon size={12} />
                      </button>
                    </div>
                  ))}
                </div>

                <button
                  className="icon-btn"
                  onClick={() => addTab(group.id)}
                  title="New shell tab"
                >
                  <PlusIcon size={14} />
                </button>
                <button
                  className="icon-btn"
                  onClick={() => splitRight(group.id)}
                  disabled={groups.length >= MAX_GROUPS}
                  title="Split terminal right"
                >
                  <SplitRightIcon size={14} />
                </button>
                {multiple ? (
                  <button
                    className="icon-btn"
                    onClick={() => closeGroup(group.id)}
                    title="Close this terminal split"
                  >
                    <CloseIcon size={13} />
                  </button>
                ) : (
                  <button className="icon-btn" onClick={onToggle} title="Hide terminal">
                    <span style={{ fontSize: 14, lineHeight: 1 }}>−</span>
                  </button>
                )}
              </div>

              <div className="terminal-stack">
                {group.tabs.map((tab) => (
                  // Hidden, never unmounted: unmounting would kill the shell.
                  <div
                    key={tab.id}
                    className="terminal-slot"
                    style={{ display: tab.id === group.activeId ? 'block' : 'none' }}
                  >
                    <TerminalView
                      id={tab.id}
                      cwd={cwd}
                      resizeNonce={resizeNonce + dragNonce}
                      visible={tab.id === group.activeId}
                    />
                  </div>
                ))}
              </div>
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  )
}
