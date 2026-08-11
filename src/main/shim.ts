import { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import { execFile } from 'child_process'
import { accessSync, constants } from 'fs'
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'
import { homedir } from 'os'
import { basename, delimiter, join } from 'path'
import { promisify } from 'util'
import { AppSettings, ShimOccupant, ShimStatus } from '../shared/types'
import {
  argoAuthHeaders,
  childEnv,
  loadSettings,
  readShimToken,
  resolveBaseUrl,
  shimPort
} from './settings'

const run = promisify(execFile)

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
let launchGeneration = 0

const CHANNEL_OUT = 'shim:output'
const CHANNEL_STATE = 'shim:state'

function executable(command: string, env: NodeJS.ProcessEnv): string | null {
  const candidates = command.includes('/')
    ? [command]
    : (env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, command))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Keep looking through PATH.
    }
  }
  return null
}

/** Resolve a GUI-safe launch command, including the common uvx-only install. */
function resolveLaunch(s: AppSettings): { command: string; args: string[] } {
  const env = childEnv(s)
  const configuredArgs = s.shimArgs.trim() ? s.shimArgs.trim().split(/\s+/) : []
  let command = s.shimCommand.trim() || 'argo-shim'
  let args = configuredArgs

  if (basename(command) === 'uvx' && args[0] !== 'argo-shim') {
    args = ['argo-shim', ...args]
  } else if (command === 'argo-shim' && !executable(command, env)) {
    const localShim = executable(join(homedir(), '.local', 'bin', 'argo-shim'), env)
    const uvx = executable('uvx', env) ?? executable(join(homedir(), '.local', 'bin', 'uvx'), env)
    if (localShim) {
      command = localShim
    } else if (uvx) {
      command = uvx
      args = ['argo-shim', ...args]
    }
  }

  if (s.shimPort > 0 && !args.some((arg) => arg === '--port' || arg.startsWith('--port='))) {
    args.push('--port', String(s.shimPort))
  }
  return { command, args }
}

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

/** Stop only the PTY process launched by this window; never touch an external shim. */
function stopManagedChild(): boolean {
  if (!child) return false
  const managed = child
  launchGeneration += 1
  child = null
  managed.kill()
  return true
}

async function belongsToManagedChild(pid: number, rootPid: number | null): Promise<boolean> {
  if (!rootPid) return false
  let current = pid
  for (let depth = 0; depth < 12 && current > 1; depth += 1) {
    if (current === rootPid) return true
    try {
      const { stdout } = await run('ps', ['-o', 'ppid=', '-p', String(current)])
      const parent = Number(stdout.trim())
      if (!Number.isFinite(parent) || parent <= 0 || parent === current) return false
      current = parent
    } catch {
      return false
    }
  }
  return false
}

export function getStatus(): ShimStatus {
  const s = loadSettings()
  return {
    state,
    baseUrl: resolveBaseUrl(s),
    port: s.useShim ? shimPort(s) : 0,
    hasToken: readShimToken() !== null,
    message: lastMessage,
    ownsProcess: child !== null
  }
}

/**
 * Who is listening on the shim port right now.
 *
 * A shim started outside this app — a previous run of the IDE, or the user's
 * own `argo-shim` in a terminal — can be adopted instead of treated as a port
 * conflict. Listing the holders also lets us distinguish it from our PTY child.
 *
 * `lsof` failing (missing, or no matching process) is the normal "port is free"
 * case: it exits nonzero with no output.
 */
export async function listOccupants(): Promise<ShimOccupant[]> {
  const s = loadSettings()
  if (!s.useShim) return []
  const port = shimPort(s)

  let stdout: string
  try {
    // -sTCP:LISTEN restricts this to servers bound to the port: a client socket
    // that merely connected to it is not something we should offer to kill.
    ;({ stdout } = await run('lsof', ['-nP', '-Fpc', `-iTCP:${port}`, '-sTCP:LISTEN']))
  } catch {
    return []
  }

  // -F output is one field per line, tagged by its first character, grouped
  // per process: p=pid, c=command. A `p` line starts each new process.
  const ownPid = child?.pid ?? null
  const found: ShimOccupant[] = []
  let current: ShimOccupant | null = null
  for (const line of stdout.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      const pid = Number(value)
      current = { pid, command: '', isOurs: false }
      found.push(current)
    } else if (tag === 'c' && current) {
      current.command = value
    }
  }

  const valid = found.filter((o) => Number.isFinite(o.pid) && o.pid > 0)
  return Promise.all(
    valid.map(async (occupant) => ({
      ...occupant,
      // Usually the listener is the PTY root itself. With `uvx argo-shim`, it
      // can be a Python descendant, so walk the parent chain before deciding.
      isOurs: await belongsToManagedChild(occupant.pid, ownPid)
    }))
  )
}

/**
 * Adopt an argo-shim that was started in Terminal.
 *
 * If an IDE launch is still waiting for Duo while a separate external shim is
 * already listening, cancel only that managed PTY. The external listener is
 * never signalled and remains alive when the IDE exits.
 */
export async function useExternal(): Promise<ShimStatus> {
  const s = loadSettings()
  if (!s.useShim) {
    setState('error', 'Turn on argo-shim in Settings before using a Terminal shim.')
    return getStatus()
  }

  const occupants = await listOccupants()
  const external = occupants.filter((o) => !o.isOurs)
  if (external.length === 0) {
    setState(
      'error',
      `No Terminal argo-shim is listening on port ${shimPort(s)}. Start it in Terminal first.`
    )
    return getStatus()
  }

  const stoppedManaged = stopManagedChild()
  setState('connecting', `Checking Terminal argo-shim on port ${shimPort(s)}…`)
  try {
    const models = await fetchModels(s)
    const who = external.map((o) => `${o.command} (pid ${o.pid})`).join(', ')
    setState(
      'connected',
      `Using Terminal argo-shim on port ${shimPort(s)} — ${models.length} models available (${who}).` +
        (stoppedManaged ? ' Stopped the IDE-managed shim.' : '')
    )
  } catch (err) {
    setState('error', `Terminal argo-shim is listening but not healthy: ${(err as Error).message}`)
  }
  return getStatus()
}

/**
 * Start argo-shim in a PTY. Output is streamed to the renderer so the Duo
 * prompt is visible; `writeToShim` feeds the user's reply back in.
 *
 * Resolves as soon as the process is spawned — connection success is reported
 * asynchronously via the health check, because Duo can take a while.
 */
export async function connect(): Promise<ShimStatus> {
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

  // Spawning on top of an occupied port produces an opaque nonzero exit. Say
  // what is holding it, and let the user stop it from the dialog.
  const occupants = await listOccupants()
  if (occupants.length > 0) {
    return useExternal()
  }

  const { command, args } = resolveLaunch(s)

  setState('connecting', `Starting ${command} ${args.join(' ')}`.trim())

  try {
    child = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: process.env.HOME,
      env: childEnv(s) as { [key: string]: string }
    })
  } catch (err) {
    child = null
    setState('error', `Could not launch "${command}": ${(err as Error).message}`)
    return getStatus()
  }

  const launched = child
  const generation = ++launchGeneration
  launched.onData((data) => broadcast(CHANNEL_OUT, data))

  launched.onExit(({ exitCode }) => {
    if (child === launched) child = null
    const expected = generation !== launchGeneration
    if (expected) return
    setState('error', `argo-shim exited with code ${exitCode}. See the log above.`)
  })

  // argo-shim's HTTP server is a foreground serve_forever() process; it does
  // not exit after daemonizing the SSH child. Probe while it is alive so the UI
  // transitions from Connecting to Connected as soon as Duo and startup finish.
  void (async () => {
    while (child === launched && generation === launchGeneration) {
      try {
        const models = await fetchModels(s)
        if (child === launched && generation === launchGeneration) {
          setState('connected', `Connected — ${models.length} models available.`)
        }
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
    }
  })()

  return getStatus()
}

/** Feed a line (typically the Duo choice) into the shim's PTY. */
export function writeToShim(data: string): void {
  child?.write(data)
}

/**
 * Detach from the shim without killing anything we did not start.
 *
 * Our own PTY child is stopped; a Terminal shim is always left alone.
 */
export function disconnect(): ShimStatus {
  const stopped = stopManagedChild()
  setState(
    'disconnected',
    stopped ? 'Stopped the IDE-managed argo-shim.' : 'No IDE-managed argo-shim was running.'
  )
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
    const occupants = s.useShim ? await listOccupants() : []
    const external = occupants.filter((o) => !o.isOurs)
    setState(
      'connected',
      external.length > 0
        ? `Using Terminal argo-shim on port ${shimPort(s)} — ${models.length} models available.`
        : `Connected — ${models.length} models available.`
    )
  } catch (err) {
    setState('error', `Health check failed: ${(err as Error).message}`)
  }
  return getStatus()
}

/**
 * GET <base>/v1/models.
 *
 * Returns the raw `data` array. Shim mode authenticates with the rotating
 * session token; direct intranet mode authenticates with the CELS username.
 */
export function fetchModels(s: AppSettings = loadSettings()): Promise<
  { id: string; internal_id?: string }[]
> {
  return new Promise((resolve, reject) => {
    const url = new URL(resolveBaseUrl(s) + '/v1/models')
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...argoAuthHeaders(s)
    }

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

/**
 * Kill the shim on app quit so we don't leak a PTY child.
 *
 * A Terminal shim is deliberately left alone. Only the exact node-pty child
 * launched by this process is stopped.
 */
export function shutdown(): void {
  stopManagedChild()
}
