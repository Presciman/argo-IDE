import { protocol } from 'electron'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { extname } from 'path'
import { Readable } from 'stream'
import { FILE_SCHEME } from '../shared/fileUrl'

/**
 * A custom scheme that serves local files to the renderer with a real
 * Content-Type.
 *
 * The PDF pane needs this. Chromium refuses to navigate a frame to a `data:`
 * URL, and our CSP would block it anyway, so the previous data-URL approach
 * could never render. `file://` is no better: the renderer runs from a custom
 * origin and cannot frame it. A registered scheme is the one route that works,
 * and it streams instead of holding the whole document in memory.
 *
 * Scope note: `protocol.handle` below binds to the *default* session only. The
 * browser pane's <webview> runs in `persist:argo-ide-browser`, a different
 * session, so a remote page loaded there cannot read local files through this
 * scheme.
 */

/**
 * Only media we actually preview. Anything else is refused, so the scheme is
 * not a general-purpose "read any file" hole in the renderer's frame sandbox.
 */
const SERVABLE: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

/** Must run before `app.whenReady()`. */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FILE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

/** Parse a `bytes=start-end` header against a known size. */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/)
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (!rawStart && !rawEnd) return null
  // A suffix range ("bytes=-500") counts back from the end of the file.
  const start = rawStart ? Number(rawStart) : Math.max(size - Number(rawEnd), 0)
  const end = rawStart ? (rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1) : size - 1
  if (start > end || start >= size) return null
  return { start, end }
}

export function registerHandler(): void {
  protocol.handle(FILE_SCHEME, async (request) => {
    // `standard: true` gives us a real URL: the host is a fixed placeholder and
    // the path is the absolute filesystem path, percent-encoded.
    const path = decodeURIComponent(new URL(request.url).pathname)
    const mime = SERVABLE[extname(path).toLowerCase()]
    if (!mime) return new Response('Unsupported file type', { status: 415 })

    let size: number
    try {
      const info = await stat(path)
      if (!info.isFile()) return new Response('Not a file', { status: 404 })
      size = info.size
    } catch {
      return new Response('Not found', { status: 404 })
    }

    // Chromium's PDF viewer fetches by range once it sees Accept-Ranges, which
    // is how a large document starts rendering before it has fully loaded.
    const range = parseRange(request.headers.get('range'), size)
    const stream = createReadStream(path, range ?? {})
    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>

    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        'content-type': mime,
        'accept-ranges': 'bytes',
        'content-length': String(range ? range.end - range.start + 1 : size),
        ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${size}` } : {}),
        // The renderer frames this; nothing else should be able to.
        'cache-control': 'no-store'
      }
    })
  })
}
