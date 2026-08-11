/**
 * The custom scheme used to stream local files into the renderer's frames.
 * Shared so the main process (which serves it) and the renderer (which builds
 * URLs for it) cannot drift apart. See src/main/protocol.ts for why a plain
 * `file://` or `data:` URL does not work here.
 */
export const FILE_SCHEME = 'argo-file'

/** Absolute filesystem path -> a URL an <iframe> or <img> can load. */
export function fileUrl(path: string): string {
  return `${FILE_SCHEME}://local${path.split('/').map(encodeURIComponent).join('/')}`
}
