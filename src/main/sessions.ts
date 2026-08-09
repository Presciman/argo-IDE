import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { ChatSession, SessionSummary } from '../shared/types'

/** Chat sessions, one JSON file each under <userData>/sessions/. */

function dir(): string {
  const d = join(app.getPath('userData'), 'sessions')
  mkdirSync(d, { recursive: true })
  return d
}

/** Reject ids that could escape the sessions directory. */
function pathFor(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid session id: ${id}`)
  return join(dir(), `${id}.json`)
}

export function list(): SessionSummary[] {
  return readdirSync(dir())
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        const s: ChatSession = JSON.parse(readFileSync(join(dir(), f), 'utf8'))
        return [
          {
            id: s.id,
            title: s.title,
            updatedAt: s.updatedAt,
            messageCount: s.messages.length
          }
        ]
      } catch {
        // A corrupt file shouldn't hide every other session.
        return []
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function read(id: string): ChatSession | null {
  try {
    return JSON.parse(readFileSync(pathFor(id), 'utf8'))
  } catch {
    return null
  }
}

export function write(session: ChatSession): void {
  writeFileSync(pathFor(session.id), JSON.stringify(session, null, 2) + '\n')
}

export function remove(id: string): void {
  try {
    unlinkSync(pathFor(id))
  } catch {
    // Already gone — deleting twice is not an error worth surfacing.
  }
}
