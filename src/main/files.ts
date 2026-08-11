import { lstat, open, readdir, readFile, realpath, stat } from 'fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'path'
import { Attachment, DirEntry, ProjectContext, ProjectFile } from '../shared/types'

/** Files bigger than this are never inlined into a prompt. */
const MAX_ATTACHMENT_BYTES = 512 * 1024
const MAX_PROJECT_FILE_BYTES = 512 * 1024
const MAX_PROJECT_TREE_ENTRIES = 4_000
const MAX_PROJECT_TREE_CHARS = 120_000

// Keep generated dependencies visible as a directory name, but do not spend
// the model's context window enumerating tens of thousands of vendor files.
const PROJECT_TREE_EXCLUDED = new Set([
  '.git',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'venv'
])

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

function visibleName(name: string): boolean {
  return !name.startsWith('.') || name === '.gitignore' || name === '.env'
}

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
    .filter((e) => visibleName(e.name))
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

/**
 * Recursively index the Explorer root for the AI Agent.
 *
 * Symlinked directories are listed but never followed, preventing cycles and
 * keeping the snapshot inside the directory the user explicitly opened.
 */
export async function projectContext(requestedRoot: string): Promise<ProjectContext> {
  const root = await realpath(requestedRoot)
  const rootInfo = await stat(root)
  if (!rootInfo.isDirectory()) throw new Error('The Explorer root is not a directory.')

  const lines: string[] = [`${basename(root)}/`]
  const excludedDirectories = new Set<string>()
  let chars = lines[0].length + 1
  let entriesSeen = 0
  let fileCount = 0
  let directoryCount = 0
  let truncated = false

  const addLine = (line: string): boolean => {
    if (entriesSeen >= MAX_PROJECT_TREE_ENTRIES || chars + line.length + 1 > MAX_PROJECT_TREE_CHARS) {
      truncated = true
      return false
    }
    lines.push(line)
    chars += line.length + 1
    entriesSeen += 1
    return true
  }

  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (truncated) return
    let entries
    try {
      entries = (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => visibleName(entry.name))
        .sort((a, b) => {
          const aDir = a.isDirectory()
          const bDir = b.isDirectory()
          return aDir !== bDir
            ? aDir
              ? -1
              : 1
            : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        })
    } catch {
      addLine(`${prefix}└── [unreadable directory]`)
      return
    }

    for (let index = 0; index < entries.length; index += 1) {
      if (truncated) return
      const entry = entries[index]
      const last = index === entries.length - 1
      const branch = last ? '└── ' : '├── '
      const childPrefix = `${prefix}${last ? '    ' : '│   '}`
      const path = join(dir, entry.name)

      let info
      try {
        info = await lstat(path)
      } catch {
        continue
      }

      if (info.isDirectory()) {
        directoryCount += 1
        if (PROJECT_TREE_EXCLUDED.has(entry.name)) {
          excludedDirectories.add(relative(root, path))
          if (!addLine(`${prefix}${branch}${entry.name}/ [generated contents omitted]`)) return
          continue
        }
        if (!addLine(`${prefix}${branch}${entry.name}/`)) return
        await walk(path, childPrefix)
      } else {
        fileCount += 1
        const suffix = info.isSymbolicLink() ? ' @' : ''
        if (!addLine(`${prefix}${branch}${entry.name}${suffix}`)) return
      }
    }
  }

  await walk(root, '')
  if (truncated) lines.push('… [project tree truncated]')

  return {
    root,
    name: basename(root),
    tree: lines.join('\n'),
    fileCount,
    directoryCount,
    truncated,
    excludedDirectories: [...excludedDirectories]
  }
}

/** Read a bounded UTF-8 file, only when its real path stays under the Explorer root. */
export async function readProjectFile(
  requestedRoot: string,
  requestedPath: string
): Promise<ProjectFile> {
  const root = await realpath(requestedRoot)
  const target = await realpath(resolve(root, requestedPath))
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error('Requested file is outside the open Explorer folder.')
  }

  const info = await stat(target)
  if (!info.isFile()) throw new Error('Requested path is not a file.')
  if (classify(target) !== 'text') throw new Error('Requested file is not a supported text file.')

  const bytesToRead = Math.min(info.size, MAX_PROJECT_FILE_BYTES)
  const buffer = Buffer.alloc(bytesToRead)
  const handle = await open(target, 'r')
  try {
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
    return {
      relativePath: relative(root, target),
      content: buffer.subarray(0, bytesRead).toString('utf8'),
      bytes: info.size,
      truncated: info.size > MAX_PROJECT_FILE_BYTES
    }
  } finally {
    await handle.close()
  }
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
