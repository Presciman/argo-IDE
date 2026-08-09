import { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'
import { AppSettings, ShimStatus } from '../shared/types'
import { loadSettings, resolveBaseUrl, shimPort, readShimToken, childEnv } from './settings'

/**
 * Owns the argo-shim child process.
 *
 * The shim authenticates with `ssh -N -f`, and ssh writes its interactive Duo
 * prompt to /dev/tty — not to stdout. A plain child_process.spawn gives it no
 * controlling terminal, so two-factor login would silently hang. We therefore
 * run the shim inside a PTY and stream both directions to a renderer dialog:
 * the user reads the Duo challenge and types their choice right there.
 */

let child: pty.IPty | null = null
let state: ShimStatus['state'] = 'disconnected'
let lastMessage = ''

const CHANNEL_OUT = 'shim:output'
const CHANNEL_STATE = 'shim:state'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function setState(next: ShimStatus['state'], message: string): void {
  state = next
  lastMessage = message
  broadcast(CHANNEL_STATE, getStatus())
}

export function getStatus(): ShimStatus {
  const s = loadSettings()
  return {
    state,
    baseUrl: resolveBaseUrl(s),
    port: s.useShim ? shimPort(s) : 0,
    hasToken: readShimToken() !== null,
    message: lastMessage
  }
}

/**
 * Start argo-shim in a PTY. Output is streamed to the renderer so the Duo
 * prompt is visible; `writeToShim` feeds the user's reply back in.
 *
 * Resolves as soon as the process is spawned — connection success is reported
 * asynchronously via the health check, because Duo can take a while.
 */
export function connect(): ShimStatus {
  const s = loadSettings()

  if (!s.useShim) {
    setState('connected', `Intranet mode — using ${s.directBaseUrl} directly (shim off).`)
    return getStatus()
  }
  if (child) {
    setState(state, 'argo-shim is already running in this window.')
    return getStatus()
  }
  if (!s.celsUsername.trim()) {
    setState('error', 'Set your CELS username in Settings before connecting.')
    return getStatus()
  }

  const args = s.shimArgs.trim() ? s.shimArgs.trim().split(/\s+/) : []
  // Pin the port so the shim and the IDE agree even if the user overrode it.
  if (s.shimPort > 0 && !args.includes('--port')) args.push('--port', String(s.shimPort))

  setState('connecting', `Starting ${s.shimCommand} ${args.join(' ')}`.trim())

  try {
    child = pty.spawn(s.shimCommand, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: process.env.HOME,
      env: childEnv(s) as { [key: string]: string }
    })
  } catch (err) {
    child = null
    setState('error', `Could not launch "${s.shimCommand}": ${(err as Error).message}`)
    return getStatus()
  }

  child.onData((data) => broadcast(CHANNEL_OUT, data))

  child.onExit(({ exitCode }) => {
    child = null
    // The shim daemonizes on success and its foreground process exits 0. A
    // nonzero code is a real failure the user needs to see (SSH lockout, bad
    // key, port conflict) — the PTY log in the dialog has the details.
    if (exitCode === 0) void verify()
    else setState('error', `argo-shim exited with code ${exitCode}. See the log above.`)
  })

  return getStatus()
}

/** Feed a line (typically the Duo choice) into the shim's PTY. */
export function writeToShim(data: string): void {
  child?.write(data)
}

export function disconnect(): ShimStatus {
  child?.kill()
  child = null
  setState('disconnected', 'Disconnected.')
  return getStatus()
}

/**
 * Probe the resolved base URL by listing models. This is the only signal that
 * actually proves the whole chain (shim -> tunnel -> Argo) works.
 */
export async function verify(): Promise<ShimStatus> {
  const s = loadSettings()
  setState('connecting', 'Verifying connection…')
  try {
    const models = await fetchModels(s)
    setState('connected', `Connected — ${models.length} models available.`)
  } catch (err) {
    setState('error', `Health check failed: ${(err as Error).message}`)
  }
  return getStatus()
}

/**
 * GET <base>/v1/models.
 *
 * Returns the raw `data` array. The shim accepts its token as a bearer, and in
 * intranet (direct) mode Argo wants the username in `x-api-key` instead — we
 * send both and let the receiving end use the one it understands.
 */
export function fetchModels(s: AppSettings = loadSettings()): Promise<
  { id: string; internal_id?: string }[]
> {
  return new Promise((resolve, reject) => {
    const url = new URL(resolveBaseUrl(s) + '/v1/models')
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const token = readShimToken()

    const headers: Record<string, string> = { accept: 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    if (s.celsUsername.trim()) headers['x-api-key'] = s.celsUsername.trim()

    const req = send(url, { method: 'GET', headers, timeout: 20_000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} from ${url.pathname}: ${body.slice(0, 200)}`))
          return
        }
        try {
          const parsed = JSON.parse(body)
          resolve(Array.isArray(parsed) ? parsed : (parsed.data ?? []))
        } catch {
          reject(new Error(`Unparseable model list: ${body.slice(0, 200)}`))
        }
      })
    })

    req.on('timeout', () => req.destroy(new Error('timed out after 20s')))
    req.on('error', (e) =>
      reject(
        new Error(
          `${e.message} — is argo-shim running on port ${shimPort(s)}? ` +
            `Use Connect, or turn the shim off in Settings if you're on the intranet.`
        )
      )
    )
    req.end()
  })
}

/** Kill the shim on app quit so we don't leak a PTY child. */
export function shutdown(): void {
  child?.kill()
  child = null
}
