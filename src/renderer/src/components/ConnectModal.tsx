import { JSX, useCallback, useEffect, useRef, useState } from 'react'
import { AppSettings, ShimOccupant, ShimStatus } from '../../../shared/types'
import { CloseIcon } from './Icons'

interface Props {
  settings: AppSettings
  status: ShimStatus
  onClose: () => void
}

/**
 * Drives argo-shim's connection, including two-factor login.
 *
 * argo-shim authenticates with `ssh -N -f`, and ssh writes its Duo challenge to
 * the controlling terminal, not to stdout. The main process therefore runs the
 * shim inside a PTY; this dialog renders that PTY's output and sends the user's
 * reply back in — that is the whole two-factor flow.
 */
export default function ConnectModal({ settings, status, onClose }: Props): JSX.Element {
  const [log, setLog] = useState('')
  const [reply, setReply] = useState('')
  const [occupants, setOccupants] = useState<ShimOccupant[]>([])
  const [busy, setBusy] = useState(false)
  const consoleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Strip ANSI escapes — this is a log view, not a terminal emulator.
    // eslint-disable-next-line no-control-regex
    const ansi = /\x1b\[[0-9;?]*[A-Za-z]|\r/g
    return window.api.shim.onOutput((chunk) => setLog((prev) => prev + chunk.replace(ansi, '')))
  }, [])

  const refreshOccupants = useCallback(() => {
    void window.api.shim.occupants().then(setOccupants)
  }, [])

  // Re-check on open and whenever the connection state moves: a shim left over
  // from a previous run is exactly the thing the user needs to see here, and
  // it's also what makes Connect fail with a port conflict.
  useEffect(() => {
    refreshOccupants()
  }, [refreshOccupants, status.state, settings.useShim])

  // Pin to the bottom so the Duo prompt is always the visible line.
  useEffect(() => {
    const el = consoleRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  const send = (): void => {
    window.api.shim.input(reply + '\r')
    setLog((prev) => prev + reply + '\n')
    setReply('')
  }

  const connecting = status.state === 'connecting'
  const portBusy = occupants.length > 0
  // A foreign listener is a Terminal-launched shim. It is adopted, never
  // stopped, by this dialog.
  const foreign = occupants.filter((o) => !o.isOurs)
  const usingExternal = status.state === 'connected' && foreign.length > 0 && !status.ownsProcess

  const stopIdeShim = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.shim.disconnect()
    } finally {
      setBusy(false)
      refreshOccupants()
    }
  }

  const useTerminalShim = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.shim.useExternal()
    } finally {
      setBusy(false)
      refreshOccupants()
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal--wide">
        <div className="modal__header">
          <span className={`status-dot status-dot--${status.state}`} />
          <span className="modal__title">Connect to Argo</span>
          <button className="icon-btn" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </div>

        <div className="modal__body">
          {!settings.useShim && (
            <div className="banner banner--info">
              argo-shim is turned off in Settings, so the app talks to{' '}
              <span className="mono">{settings.directBaseUrl}</span> directly. Use{' '}
              <strong>Check connection</strong> to verify you can reach it from this network.
            </div>
          )}

          {settings.useShim && !settings.celsUsername.trim() && (
            <div className="banner banner--warn">
              No CELS username set. Open Settings and fill it in first — argo-shim needs it for the
              SSH tunnel.
            </div>
          )}

          {status.state === 'error' && <div className="banner banner--err">{status.message}</div>}

          {settings.useShim && portBusy && (
            <div className="banner banner--info">
              Port <span className="mono">{status.port}</span> is in use by{' '}
              {occupants.map((o, i) => (
                <span key={o.pid}>
                  {i > 0 && ', '}
                  <span className="mono">
                    {o.command} (pid {o.pid})
                  </span>
                  {o.isOurs && ' — started by this app'}
                </span>
              ))}
              .{' '}
              {foreign.length > 0 &&
                'This Terminal shim can be reused without starting or owning another shim in the IDE.'}
            </div>
          )}

          {settings.useShim && (
            <div className="banner banner--warn">
              <strong>If a connection fails, do not retry repeatedly.</strong> ALCF login nodes are
              shared, and repeated SSH auth failures get the whole node&apos;s IP blocked. Read the
              error, fix that one thing, then try again. argo-shim enforces its own cooldown after
              repeated failures — clear it with <span className="mono">argo-shim --reset</span> once
              SSH works.
            </div>
          )}

          <div className="field">
            <div className="field__label">argo-shim output</div>
            <div className="console" ref={consoleRef}>
              {log || 'Not started. Press Connect to launch argo-shim.\n'}
            </div>
            <div className="field__hint">
              Two-factor prompts from Duo appear here. Type your choice below and press Enter —
              usually <span className="mono">1</span> for a push notification.
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input mono"
              value={reply}
              placeholder="Reply to the prompt above (e.g. 1)"
              spellCheck={false}
              disabled={!settings.useShim}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
            />
            <button className="btn" onClick={send} disabled={!settings.useShim}>
              Send
            </button>
          </div>
        </div>

        <div className="modal__footer">
          <span className="status-line">
            <span className={`status-dot status-dot--${status.state}`} />
            <span className="status-line__text">{status.message || status.state}</span>
          </span>
          <span className="pane__spacer" />
          <button className="btn" onClick={() => void window.api.shim.verify()}>
            Check connection
          </button>
          {settings.useShim && status.ownsProcess && (
            <button
              className="btn btn--danger"
              disabled={busy}
              title="Stop only the argo-shim process launched by this IDE"
              onClick={() => void stopIdeShim()}
            >
              {busy ? 'Stopping…' : 'Stop IDE shim'}
            </button>
          )}
          {foreign.length > 0 ? (
            <button
              className="btn btn--primary"
              disabled={busy || connecting || usingExternal || !settings.useShim}
              title="Leave the Terminal process running and use it for Argo requests"
              onClick={() => void useTerminalShim()}
            >
              {usingExternal ? 'Using Terminal shim' : busy || connecting ? 'Checking…' : 'Use Terminal shim'}
            </button>
          ) : (
            <button
              className="btn btn--primary"
              disabled={connecting || busy || !settings.useShim}
              onClick={() => {
                setLog('')
                void window.api.shim.connect().then(refreshOccupants)
              }}
            >
              {connecting ? 'Connecting…' : 'Start IDE shim'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
