import { DiffLine, DiffSummary } from './types'

/**
 * A minimal line diff, used to describe a write before the user approves it.
 *
 * Approving a write blind is the one genuinely risky thing about "approve for
 * me" mode, so the prompt shows what would change. This is a plain LCS over
 * whole lines — no word-level refinement, no hunk headers. It only has to make
 * a change legible at a glance.
 */

const MAX_PREVIEW_LINES = 40
/** Above this, the quadratic LCS table costs more than the preview is worth. */
const MAX_DIFF_LINES = 4_000

function splitLines(text: string): string[] {
  if (text === '') return []
  // A trailing newline shouldn't register as a final empty line.
  return text.replace(/\n$/, '').split('\n')
}

/** Longest-common-subsequence lengths for the classic backtracking walk. */
function lcsTable(a: string[], b: string[]): Uint32Array {
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  return table
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)

  // Very large files fall back to a whole-file replacement rather than
  // allocating a multi-million-entry table for a preview nobody reads.
  if (a.length + b.length > MAX_DIFF_LINES) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'remove', text })),
      ...b.map((text): DiffLine => ({ kind: 'add', text }))
    ]
  }

  const width = b.length + 1
  const table = lcsTable(a, b)
  const out: DiffLine[] = []
  let i = 0
  let j = 0

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i] })
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      out.push({ kind: 'remove', text: a[i] })
      i += 1
    } else {
      out.push({ kind: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < a.length) {
    out.push({ kind: 'remove', text: a[i] })
    i += 1
  }
  while (j < b.length) {
    out.push({ kind: 'add', text: b[j] })
    j += 1
  }
  return out
}

/**
 * Counts plus a bounded preview centred on the changes.
 *
 * `before` is null when the file does not exist yet, which the prompt shows as
 * a creation rather than a diff.
 */
export function summarizeDiff(before: string | null, after: string): DiffSummary {
  const created = before === null
  const lines = diffLines(before ?? '', after)

  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'add') added += 1
    else if (line.kind === 'remove') removed += 1
  }

  // Keep only changed lines and one line of surrounding context, so a small
  // edit to a big file doesn't preview as hundreds of unchanged lines.
  const interesting = lines.map(
    (line, index) =>
      line.kind !== 'context' ||
      lines[index - 1]?.kind === 'add' ||
      lines[index - 1]?.kind === 'remove' ||
      lines[index + 1]?.kind === 'add' ||
      lines[index + 1]?.kind === 'remove'
  )
  const kept = lines.filter((_, index) => interesting[index])

  return {
    added,
    removed,
    created,
    preview: kept.slice(0, MAX_PREVIEW_LINES),
    previewTruncated: kept.length > MAX_PREVIEW_LINES
  }
}
