import { JSX, useCallback, useEffect, useState } from 'react'
import { DirEntry } from '../../../shared/types'
import { ChevronIcon, FileIcon, FolderIcon, RefreshIcon } from './Icons'

interface Props {
  root: string | null
  selectedPath: string | null
  onOpenFile: (path: string) => void
  onPickRoot: () => void
}

/** One expandable directory level. Children load lazily on first expand. */
function TreeNode({
  entry,
  depth,
  selectedPath,
  onOpenFile
}: {
  entry: DirEntry
  depth: number
  selectedPath: string | null
  onOpenFile: (path: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<DirEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const toggle = useCallback(async () => {
    if (!entry.isDirectory) {
      onOpenFile(entry.path)
      return
    }
    const next = !open
    setOpen(next)
    if (next && children === null) {
      try {
        setChildren(await window.api.fs.list(entry.path))
        setError(null)
      } catch (err) {
        // Permission-denied on a folder shouldn't collapse the whole tree.
        setError((err as Error).message)
        setChildren([])
      }
    }
  }, [entry, open, children, onOpenFile])

  return (
    <>
      <div
        className={`tree__row${selectedPath === entry.path ? ' is-selected' : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={toggle}
        title={entry.path}
      >
        <span className={`tree__chevron${open ? ' is-open' : ''}`}>
          {entry.isDirectory ? <ChevronIcon size={11} /> : null}
        </span>
        <span className="tree__icon">
          {entry.isDirectory ? <FolderIcon size={13} /> : <FileIcon size={13} />}
        </span>
        <span className="tree__name">{entry.name}</span>
      </div>

      {open && error && (
        <div className="tree__error" style={{ paddingLeft: 18 + depth * 12 }}>
          {error}
        </div>
      )}

      {open &&
        children?.map((child) => (
          <TreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onOpenFile={onOpenFile}
          />
        ))}
    </>
  )
}

export default function FileExplorer({
  root,
  selectedPath,
  onOpenFile,
  onPickRoot
}: Props): JSX.Element {
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  // Remounts the whole subtree, discarding every node's cached children.
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!root) {
      setEntries([])
      return
    }
    let cancelled = false
    window.api.fs
      .list(root)
      .then((list) => {
        if (!cancelled) {
          setEntries(list)
          setError(null)
        }
      })
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [root, nonce])

  return (
    <div className="pane" style={{ flex: '1 1 0' }}>
      <div className="pane__header">
        <span className="pane__title" title={root ?? undefined}>
          {root ? root.split('/').pop() || root : 'Explorer'}
        </span>
        <span className="pane__spacer" />
        <button
          className="icon-btn"
          onClick={() => setNonce((n) => n + 1)}
          disabled={!root}
          title="Refresh"
        >
          <RefreshIcon size={13} />
        </button>
        <button className="icon-btn" onClick={onPickRoot} title="Open folder…">
          <FolderIcon size={14} />
        </button>
      </div>

      <div className="pane__body">
        {!root ? (
          <div className="empty-state">
            <div>No folder open</div>
            <button className="btn btn--sm" onClick={onPickRoot}>
              Open Folder
            </button>
          </div>
        ) : error ? (
          <div className="tree__error">{error}</div>
        ) : (
          <div className="tree" key={nonce}>
            {entries.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                selectedPath={selectedPath}
                onOpenFile={onOpenFile}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
