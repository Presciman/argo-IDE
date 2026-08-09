import { JSX, useEffect, useState } from 'react'
import { AppSettings, ShimStatus } from '../../../shared/types'
import { CloseIcon } from './Icons'

interface Props {
  settings: AppSettings
  status: ShimStatus
  onSave: (patch: Partial<AppSettings>) => Promise<void>
  onClose: () => void
}

export default function SettingsModal({ settings, status, onSave, onClose }: Props): JSX.Element {
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [saved, setSaved] = useState(false)

  // Reset the "Saved" confirmation whenever the user edits again.
  useEffect(() => setSaved(false), [draft])

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }))

  const save = async (): Promise<void> => {
    await onSave(draft)
    setSaved(true)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal--wide">
        <div className="modal__header">
          <span className="modal__title">Settings</span>
          <button className="icon-btn" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </div>

        <div className="modal__body">
          <div className="section-title">Identity</div>

          <div className="field">
            <label className="field__label" htmlFor="cels">
              CELS username
            </label>
            <input
              id="cels"
              className="input"
              value={draft.celsUsername}
              placeholder="your CELS account name"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => set('celsUsername', e.target.value)}
            />
            <div className="field__hint">
              Exported as <span className="mono">CELS_USERNAME</span> (and{' '}
              <span className="mono">ARGO_USER</span>) to argo-shim and to every terminal this app
              opens. argo-shim uses it for the SSH tunnel and to derive its listen port; Argo
              requires it on OpenAI-format requests. Set this if your ALCF username differs from
              your CELS one.
            </div>
          </div>

          <div className="section-title">Connection</div>

          <div className="field">
            <label className="toggle">
              <input
                type="checkbox"
                checked={draft.useShim}
                onChange={(e) => set('useShim', e.target.checked)}
              />
              <span>Use argo-shim (off-site access)</span>
            </label>
            <div className="field__hint">
              On: traffic goes through a local argo-shim, which tunnels to Argo over SSH. Turn this{' '}
              <strong>off</strong> when you are already on the ANL intranet and can reach the API
              host directly. This app never guesses which network you are on.
            </div>
          </div>

          {draft.useShim ? (
            <>
              <div className="field">
                <label className="field__label" htmlFor="shimcmd">
                  Shim command
                </label>
                <input
                  id="shimcmd"
                  className="input mono"
                  value={draft.shimCommand}
                  spellCheck={false}
                  onChange={(e) => set('shimCommand', e.target.value)}
                />
                <div className="field__hint">
                  Usually <span className="mono">argo-shim</span>. Use an absolute path if it is not
                  on the PATH that GUI apps inherit.
                </div>
              </div>

              <div className="field">
                <label className="field__label" htmlFor="shimargs">
                  Extra shim flags
                </label>
                <input
                  id="shimargs"
                  className="input mono"
                  value={draft.shimArgs}
                  placeholder="e.g. --restart"
                  spellCheck={false}
                  onChange={(e) => set('shimArgs', e.target.value)}
                />
              </div>

              <div className="field">
                <label className="field__label" htmlFor="port">
                  Shim port override
                </label>
                <input
                  id="port"
                  className="input mono"
                  type="number"
                  min={0}
                  max={65535}
                  value={draft.shimPort}
                  onChange={(e) => set('shimPort', Number(e.target.value) || 0)}
                />
                <div className="field__hint">
                  0 means derive it from the username, the same way argo-shim does. Currently
                  resolving to <span className="mono">{status.port || '—'}</span>. Only change this
                  if you also pass <span className="mono">--port</span> to the shim.
                </div>
              </div>
            </>
          ) : (
            <div className="field">
              <label className="field__label" htmlFor="direct">
                Direct API base URL
              </label>
              <input
                id="direct"
                className="input mono"
                value={draft.directBaseUrl}
                spellCheck={false}
                onChange={(e) => set('directBaseUrl', e.target.value)}
              />
              <div className="field__hint">
                Used when the shim is off. Should end in <span className="mono">/argoapi</span>.
              </div>
            </div>
          )}

          <div className="banner banner--info">
            Requests currently go to <span className="mono">{status.baseUrl}</span>
            {status.hasToken ? ' with the shim token from ~/.claude/settings.json.' : ' (no shim token found yet).'}
          </div>
        </div>

        <div className="modal__footer">
          {saved && <span style={{ color: 'var(--ok)', fontSize: 12 }}>Saved</span>}
          <span className="pane__spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn btn--primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
