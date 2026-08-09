import { JSX, useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  /** 'v' drags horizontally (resizes columns); 'h' drags vertically (rows). */
  orientation: 'v' | 'h'
  /** Called with the pointer delta in px since the drag started. */
  onDrag: (deltaPx: number) => void
  onDragEnd?: () => void
}

/**
 * A drag handle between two panes.
 *
 * Listeners live on `window` for the duration of the drag so the pointer can
 * leave the 4px handle (or the window) without the drag sticking. We report
 * deltas rather than absolute positions so the parent owns the sizing policy
 * and its clamping.
 */
export default function Splitter({ orientation, onDrag, onDragEnd }: Props): JSX.Element {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)

  const start = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    origin.current = orientation === 'v' ? e.clientX : e.clientY
    setDragging(true)
  }, [orientation])

  useEffect(() => {
    if (!dragging) return

    const move = (e: MouseEvent): void => {
      const pos = orientation === 'v' ? e.clientX : e.clientY
      onDrag(pos - origin.current)
      origin.current = pos
    }
    const up = (): void => {
      setDragging(false)
      onDragEnd?.()
    }

    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    // Keep the resize cursor while dragging over Monaco, the terminal, etc.
    document.body.style.cursor = orientation === 'v' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'

    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging, orientation, onDrag, onDragEnd])

  return (
    <div
      className={`splitter splitter--${orientation}${dragging ? ' is-dragging' : ''}`}
      onMouseDown={start}
      role="separator"
      aria-orientation={orientation === 'v' ? 'vertical' : 'horizontal'}
    />
  )
}
