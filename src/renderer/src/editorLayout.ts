/**
 * The Editor pane's split layout: rows of side-by-side cells.
 *
 * Groups carry stable ids rather than being addressed by position. Splitting
 * and closing reshuffle indices constantly, and a drag that lands on "group 2"
 * must mean the same group it did when the drag started.
 *
 * Sizes live here rather than in the component so they survive a split: a row
 * that gains a neighbour keeps its own height, and the new one is sized from
 * the space its sibling gives up.
 */

export interface EditorTab {
  id: string
  kind: 'text' | 'image' | 'pdf' | 'binary' | 'web'
  /** File path, or the latest URL for a web tab. */
  target: string
  label: string
  /** Explorer root that authorized an editable text file. */
  root?: string
  /** Editor state lives on the tab so moves and inactive tabs cannot lose it. */
  draft?: string
  dirty?: boolean
}

/** One pane of tabs: a single cell in the grid. */
export interface EditorGroup {
  id: string
  tabs: EditorTab[]
  activeId: string | null
  /** Width weight within its row. */
  weight: number
}

export interface EditorRow {
  id: string
  cells: EditorGroup[]
  /** Height weight within the pane. */
  weight: number
}

export interface EditorLayout {
  rows: EditorRow[]
  /** The group that receives newly opened files. */
  focusedId: string
}

export const MAX_ROWS = 3
export const MAX_COLUMNS = 3

const uid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export function emptyGroup(): EditorGroup {
  return { id: uid(), tabs: [], activeId: null, weight: 1 }
}

export function initialLayout(): EditorLayout {
  const group = emptyGroup()
  return { rows: [{ id: uid(), cells: [group], weight: 1 }], focusedId: group.id }
}

/** Every group, left to right then top to bottom. */
export function allGroups(layout: EditorLayout): EditorGroup[] {
  return layout.rows.flatMap((row) => row.cells)
}

export function findGroup(layout: EditorLayout, groupId: string): EditorGroup | null {
  return allGroups(layout).find((g) => g.id === groupId) ?? null
}

/** Rebuild a layout by mapping over its groups. */
function mapGroups(
  layout: EditorLayout,
  fn: (group: EditorGroup, row: EditorRow) => EditorGroup
): EditorLayout {
  return {
    ...layout,
    rows: layout.rows.map((row) => ({ ...row, cells: row.cells.map((cell) => fn(cell, row)) }))
  }
}

export function updateGroup(
  layout: EditorLayout,
  groupId: string,
  fn: (group: EditorGroup) => EditorGroup
): EditorLayout {
  return mapGroups(layout, (group) => (group.id === groupId ? fn(group) : group))
}

/**
 * Drop empty groups, and any row they leave empty.
 *
 * The last group is always kept: the pane must have somewhere to open a file.
 * Freed weight is handed to the surviving siblings so the row still fills its
 * width rather than leaving a gap.
 */
function prune(layout: EditorLayout): EditorLayout {
  const rows: EditorRow[] = []

  for (const row of layout.rows) {
    const kept = row.cells.filter((cell) => cell.tabs.length > 0)
    if (kept.length === 0) continue
    if (kept.length === row.cells.length) {
      rows.push(row)
      continue
    }
    const freed = row.cells
      .filter((cell) => cell.tabs.length === 0)
      .reduce((sum, cell) => sum + cell.weight, 0)
    const share = freed / kept.length
    rows.push({ ...row, cells: kept.map((cell) => ({ ...cell, weight: cell.weight + share })) })
  }

  if (rows.length === 0) return initialLayout()

  // Rows that disappeared give their height back to the rest.
  const lostHeight = layout.rows
    .filter((row) => !rows.some((kept) => kept.id === row.id))
    .reduce((sum, row) => sum + row.weight, 0)
  const heightShare = lostHeight / rows.length
  const resized =
    lostHeight > 0 ? rows.map((row) => ({ ...row, weight: row.weight + heightShare })) : rows

  const survivingFocus = resized.some((row) => row.cells.some((c) => c.id === layout.focusedId))
  return {
    rows: resized,
    focusedId: survivingFocus ? layout.focusedId : resized[0].cells[0].id
  }
}

/** Total cells, used to cap how far the pane can be divided. */
export function groupCount(layout: EditorLayout): number {
  return allGroups(layout).length
}

export function canSplitRight(layout: EditorLayout, groupId: string): boolean {
  const row = layout.rows.find((r) => r.cells.some((c) => c.id === groupId))
  return !!row && row.cells.length < MAX_COLUMNS
}

export function canSplitDown(layout: EditorLayout): boolean {
  return layout.rows.length < MAX_ROWS
}

/**
 * Add a cell beside the given group, splitting its width.
 *
 * The new group is empty and focused, so the next file the user opens lands in
 * the split they just made — which is almost always why they made it.
 */
export function splitRight(layout: EditorLayout, groupId: string): EditorLayout {
  if (!canSplitRight(layout, groupId)) return layout
  const fresh = emptyGroup()

  return {
    ...layout,
    focusedId: fresh.id,
    rows: layout.rows.map((row) => {
      const index = row.cells.findIndex((cell) => cell.id === groupId)
      if (index < 0) return row
      const source = row.cells[index]
      const half = source.weight / 2
      const cells = [...row.cells]
      cells.splice(index, 1, { ...source, weight: half }, { ...fresh, weight: half })
      return { ...row, cells }
    })
  }
}

/** Add a row below the one holding the given group, splitting its height. */
export function splitDown(layout: EditorLayout, groupId: string): EditorLayout {
  if (!canSplitDown(layout)) return layout
  const index = layout.rows.findIndex((row) => row.cells.some((cell) => cell.id === groupId))
  if (index < 0) return layout

  const source = layout.rows[index]
  const half = source.weight / 2
  const fresh = emptyGroup()
  const rows = [...layout.rows]
  rows.splice(
    index,
    1,
    { ...source, weight: half },
    { id: uid(), cells: [fresh], weight: half }
  )
  return { ...layout, rows, focusedId: fresh.id }
}

/** Open a tab in a specific group, or focus it if that file is already open. */
export function openTab(layout: EditorLayout, tab: EditorTab, groupId?: string): EditorLayout {
  // A file already open anywhere is focused rather than opened twice.
  for (const group of allGroups(layout)) {
    const existing = group.tabs.find((t) => t.kind !== 'web' && t.target === tab.target)
    if (existing) {
      return {
        ...updateGroup(layout, group.id, (g) => ({ ...g, activeId: existing.id })),
        focusedId: group.id
      }
    }
  }

  const target = groupId ?? layout.focusedId
  const exists = allGroups(layout).some((g) => g.id === target)
  const destination = exists ? target : layout.rows[0].cells[0].id
  return {
    ...updateGroup(layout, destination, (g) => ({
      ...g,
      tabs: [...g.tabs, tab],
      activeId: tab.id
    })),
    focusedId: destination
  }
}

export function activateTab(layout: EditorLayout, groupId: string, tabId: string): EditorLayout {
  return {
    ...updateGroup(layout, groupId, (g) => ({ ...g, activeId: tabId })),
    focusedId: groupId
  }
}

export function closeTab(layout: EditorLayout, groupId: string, tabId: string): EditorLayout {
  return prune(
    updateGroup(layout, groupId, (g) => {
      const tabs = g.tabs.filter((t) => t.id !== tabId)
      return {
        ...g,
        tabs,
        // Closing the active tab falls back to the last one still open.
        activeId: g.activeId === tabId ? (tabs.at(-1)?.id ?? null) : g.activeId
      }
    })
  )
}

export function updateTab(
  layout: EditorLayout,
  groupId: string,
  tabId: string,
  patch: Partial<EditorTab>
): EditorLayout {
  return updateGroup(layout, groupId, (g) => ({
    ...g,
    tabs: g.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t))
  }))
}

/** Move a tab between groups; within one group this is just a focus change. */
export function moveTab(
  layout: EditorLayout,
  sourceGroupId: string,
  targetGroupId: string,
  tabId: string
): EditorLayout {
  if (sourceGroupId === targetGroupId) return activateTab(layout, targetGroupId, tabId)

  const source = findGroup(layout, sourceGroupId)
  const tab = source?.tabs.find((t) => t.id === tabId)
  if (!tab || !findGroup(layout, targetGroupId)) return layout

  const detached = updateGroup(layout, sourceGroupId, (g) => {
    const tabs = g.tabs.filter((t) => t.id !== tabId)
    return { ...g, tabs, activeId: g.activeId === tabId ? (tabs.at(-1)?.id ?? null) : g.activeId }
  })
  const attached = updateGroup(detached, targetGroupId, (g) => ({
    ...g,
    tabs: [...g.tabs, tab],
    activeId: tab.id
  }))
  // Pruning would drop a source group the user just emptied by dragging its
  // last tab out, which is the behaviour they expect from a split.
  return prune({ ...attached, focusedId: targetGroupId })
}

/**
 * Close a split, moving its tabs to a neighbour so nothing is silently lost.
 *
 * Prefers the previous cell in the same row, then the next, then the first
 * cell of another row.
 */
export function closeGroup(layout: EditorLayout, groupId: string): EditorLayout {
  if (groupCount(layout) <= 1) return layout

  const row = layout.rows.find((r) => r.cells.some((c) => c.id === groupId))
  const group = findGroup(layout, groupId)
  if (!row || !group) return layout

  const index = row.cells.findIndex((c) => c.id === groupId)
  const neighbour =
    row.cells[index - 1] ??
    row.cells[index + 1] ??
    allGroups(layout).find((g) => g.id !== groupId)
  if (!neighbour) return layout

  const merged = updateGroup(layout, neighbour.id, (g) => ({
    ...g,
    tabs: [...g.tabs, ...group.tabs],
    activeId: group.activeId ?? g.activeId
  }))
  // Empty the group so prune() removes it and redistributes its space.
  const emptied = updateGroup(merged, groupId, (g) => ({ ...g, tabs: [], activeId: null }))
  return prune({ ...emptied, focusedId: neighbour.id })
}

/** Drag a row divider. `index` is the row above the divider. */
export function resizeRows(
  layout: EditorLayout,
  index: number,
  deltaPx: number,
  hostHeight: number
): EditorLayout {
  const rows = layout.rows
  if (index < 0 || index + 1 >= rows.length) return layout

  const total = rows.reduce((sum, row) => sum + row.weight, 0)
  const shift = deltaPx * (total / Math.max(hostHeight, 1))
  const a = rows[index].weight + shift
  const b = rows[index + 1].weight - shift
  const min = total * 0.08
  if (a < min || b < min) return layout

  return {
    ...layout,
    rows: rows.map((row, i) =>
      i === index ? { ...row, weight: a } : i === index + 1 ? { ...row, weight: b } : row
    )
  }
}

/** Drag a column divider inside one row. `index` is the cell to its left. */
export function resizeColumns(
  layout: EditorLayout,
  rowId: string,
  index: number,
  deltaPx: number,
  hostWidth: number
): EditorLayout {
  return {
    ...layout,
    rows: layout.rows.map((row) => {
      if (row.id !== rowId || index < 0 || index + 1 >= row.cells.length) return row
      const total = row.cells.reduce((sum, cell) => sum + cell.weight, 0)
      const shift = deltaPx * (total / Math.max(hostWidth, 1))
      const a = row.cells[index].weight + shift
      const b = row.cells[index + 1].weight - shift
      const min = total * 0.1
      if (a < min || b < min) return row
      return {
        ...row,
        cells: row.cells.map((cell, i) =>
          i === index ? { ...cell, weight: a } : i === index + 1 ? { ...cell, weight: b } : cell
        )
      }
    })
  }
}
