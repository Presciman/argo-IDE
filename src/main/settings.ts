import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { homedir, userInfo } from 'os'
import { AppSettings, DEFAULT_SETTINGS } from '../shared/types'

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

let cache: AppSettings | null = null

export function loadSettings(): AppSettings {
  if (cache) return cache
  try {
    const raw = readFileSync(settingsPath(), 'utf8')
    // Merge over defaults so a settings file written by an older version
    // doesn't leave newly-added keys undefined.
    cache = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache!
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...patch }
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2) + '\n')
  cache = next
  return next
}

/**
 * The username argo-shim will use. Mirrors the shim's own resolution order
 * (CELS_USERNAME, then the login user) so our derived port matches its.
 */
export function resolveUsername(s: AppSettings = loadSettings()): string {
  return s.celsUsername.trim() || process.env.CELS_USERNAME || userInfo().username
}

/**
 * Reimplements argo-shim's `default_port()`:
 *   10000 + int(sha256(username)[:8], 16) % 22768
 * Both sides must agree or the IDE talks to the wrong port.
 */
export function derivePort(username: string): number {
  const hex = createHash('sha256').update(username, 'utf8').digest('hex').slice(0, 8)
  return 10000 + (parseInt(hex, 16) % 22768)
}

export function shimPort(s: AppSettings = loadSettings()): number {
  return s.shimPort > 0 ? s.shimPort : derivePort(resolveUsername(s))
}

/** Where chat requests should go, given the shim toggle. */
export function resolveBaseUrl(s: AppSettings = loadSettings()): string {
  if (!s.useShim) return s.directBaseUrl.replace(/\/+$/, '')
  return `http://127.0.0.1:${shimPort(s)}/argoapi`
}

/**
 * Read the shim's per-session auth token out of ~/.claude/settings.json.
 *
 * argo-shim stores it as `apiKeyHelper: "echo <token>"` and rotates it on every
 * restart, so we re-read rather than cache. Returns null when there's no token
 * (the shim was started with --no-auth, or hasn't run yet).
 */
export function readShimToken(): string | null {
  try {
    const raw = readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')
    const helper = JSON.parse(raw).apiKeyHelper
    if (typeof helper !== 'string') return null
    const token = helper.trim().split(/\s+/).pop()
    return !token || token === 'no-auth' ? null : token
  } catch {
    return null
  }
}

/** Authentication headers for the selected connection mode. */
export function argoAuthHeaders(s: AppSettings = loadSettings()): Record<string, string> {
  if (s.useShim) {
    const token = readShimToken()
    if (!token) return {}
    // argo-shim 0.3.19 checks x-api-key first and only falls back to Bearer
    // when x-api-key is absent. Send the session token in both forms for
    // compatibility with shim versions and OpenAI-style clients.
    return {
      'x-api-key': token,
      authorization: `Bearer ${token}`
    }
  }

  const username = s.celsUsername.trim()
  return username ? { 'x-api-key': username } : {}
}

/**
 * Environment for any child process that talks to Argo (the shim itself, and
 * terminals the user opens). CELS_USERNAME is the one setting the shim can't
 * infer, and ARGO_USER is what it injects into OpenAI-format requests.
 */
export function childEnv(s: AppSettings = loadSettings()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const user = s.celsUsername.trim()
  if (user) {
    env.CELS_USERNAME = user
    env.ARGO_USER = user
  }
  return env
}
