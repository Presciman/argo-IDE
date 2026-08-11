import { JSX, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

interface Props {
  /** Stable id for the PTY session in the main process. */
  id: string
  /** Initial working directory — the folder open in the explorer. */
  cwd: string | null
  /** Bumped by the parent whenever the layout changes, to trigger a refit. */
  resizeNonce: number
  /**
   * False while this terminal is on an inactive tab. It stays mounted (so the
   * shell keeps running and its scrollback survives) but is hidden, and a
   * hidden xterm cannot measure itself — so fitting waits for visibility.
   */
  visible: boolean
}

const THEME = {
  background: '#16181d',
  foreground: '#e6e8ec',
  cursor: '#5b9dff',
  selectionBackground: '#343945',
  black: '#16181d',
  brightBlack: '#6e7681',
  red: '#f2635f',
  brightRed: '#ff8785',
  green: '#4ec9a0',
  brightGreen: '#6fe0bb',
  yellow: '#e0a54b',
  brightYellow: '#f5c473',
  blue: '#5b9dff',
  brightBlue: '#84b6ff',
  magenta: '#c07ce8',
  brightMagenta: '#d79bf5',
  cyan: '#4ec9d4',
  brightCyan: '#7ee0e9',
  white: '#a8aeb9',
  brightWhite: '#ffffff'
}

/**
 * One shell, one xterm instance.
 *
 * Split out of TerminalPanel so the panel can host several of these at once —
 * as tabs and as side-by-side splits — each owning its own PTY in the main
 * process. Mount/unmount is exactly the PTY lifetime, so an inactive tab must
 * stay mounted rather than being conditionally rendered away.
 */
export default function TerminalView({ id, cwd, resizeNonce, visible }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  // One PTY per mount. cwd is read at spawn time only — changing the explorer
  // root later does not move an existing shell, which matches how a terminal
  // behaves everywhere else.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      theme: THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    try {
      fit.fit()
    } catch {
      // Mounted hidden (a background tab); the effect below fits on reveal.
    }

    termRef.current = term
    fitRef.current = fit

    const offData = window.api.terminal.onData(id, (data) => term.write(data))
    const offExit = window.api.terminal.onExit(id, (code) => {
      // A clean shell exit is expected (for example after `exit`) and does not
      // need an IDE diagnostic. Keep failures visible because they are useful.
      if (code !== 0) {
        term.write(`\r\n\x1b[31m[process exited with code ${code}]\x1b[0m\r\n`)
      }
    })
    const input = term.onData((data) => window.api.terminal.write(id, data))

    // Subscribe before spawning so an immediate launch failure is visible in
    // the terminal instead of racing past the renderer listeners.
    window.api.terminal.spawn({ id, cwd: cwd ?? undefined, cols: term.cols, rows: term.rows })

    // The panel resizes with the window and with its own splitters.
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
        window.api.terminal.resize(id, term.cols, term.rows)
      } catch {
        // fit() throws while the host has zero size (panel collapsed).
      }
    })
    observer.observe(host)

    return () => {
      observer.disconnect()
      input.dispose()
      offData()
      offExit()
      window.api.terminal.kill(id)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Refit after a splitter drag settles or this tab becomes visible. A
  // terminal hidden with display:none reports zero size, so its dimensions are
  // only meaningful once it is on screen again.
  useEffect(() => {
    if (!visible) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    try {
      fit.fit()
      window.api.terminal.resize(id, term.cols, term.rows)
      term.focus()
    } catch {
      // Zero-size host; the observer will fit once it's visible again.
    }
  }, [resizeNonce, id, visible])

  return <div className="terminal-host" ref={hostRef} />
}
