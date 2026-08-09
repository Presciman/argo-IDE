import { readdir, readFile, stat } from 'fs/promises'
import { join, extname } from 'path'
import { DirEntry, Attachment } from '../shared/types'

/** Files bigger than this are never inlined into a prompt. */
const MAX_ATTACHMENT_BYTES = 512 * 1024

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.jsonc',
  '.py', '.pyi', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cxx', '.m', '.mm',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
  '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.sql', '.graphql', '.proto', '.tf', '.dockerfile', '.gitignore', '.lua', '.r', '.jl'
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'])

export type FileKind = 'text' | 'image' | 'pdf' | 'binary'

export function classify(path: string): FileKind {
  const ext = extname(path).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  // Extensionless files in a repo are almost always text (Makefile, LICENSE).
  if (!ext) return 'text'
  return 'binary'
}

/** One directory level. Directories sort first, then case-insensitive by name. */
export async function listDirectory(dir: string): Promise<DirEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => !e.name.startsWith('.') || e.name === '.gitignore' || e.name === '.env')
    .map((e) => ({
      name: e.name,
      path: join(dir, e.name),
      // A symlink to a directory should still expand in the tree.
      isDirectory: e.isDirectory() || e.isSymbolicLink()
    }))
    .sort((a, b) =>
      a.isDirectory !== b.isDirectory
        ? a.isDirectory
          ? -1
          : 1
        : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    )
}

export async function readTextFile(path: string): Promise<string> {
  const info = await stat(path)
  if (info.size > 5 * 1024 * 1024) {
    throw new Error(`File is ${(info.size / 1e6).toFixed(1)} MB — too large to open in the editor.`)
  }
  return readFile(path, 'utf8')
}

/** Read a file as a data URL, for the PDF and image viewers. */
export async function readAsDataUrl(path: string, mime: string): Promise<string> {
  const buf = await readFile(path)
  return `data:${mime};base64,${buf.toString('base64')}`
}

/**
 * Turn a file into a chat attachment. Binary and oversized files come back
 * with `skipped` set rather than throwing, so the UI can show them greyed out
 * instead of failing the whole send.
 */
export async function makeAttachment(path: string, id: string): Promise<Attachment> {
  const info = await stat(path)
  const name = path.split('/').pop() ?? path
  const base: Attachment = { id, name, path, bytes: info.size }

  if (info.size > MAX_ATTACHMENT_BYTES) {
    return { ...base, skipped: `too large (${(info.size / 1024).toFixed(0)} KB)` }
  }
  if (classify(path) !== 'text') {
    return { ...base, skipped: 'not a text file' }
  }
  return { ...base, text: await readFile(path, 'utf8') }
}
