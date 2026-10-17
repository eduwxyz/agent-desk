// Projects (spec §15): a channel tied to a folder of the Mac. Every agent in it
// gets the project's context files and memories in its prompt, and agents with
// a computer get the folder itself, with the access the channel gives them.
import { existsSync, openSync, readSync, closeSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { PROJECT_FILES, type Agent, type Conversation, type LentFolder, type Project } from '../shared/types'
import { folderName } from './computer'

const MAX_FILE_CHARS = 20_000
const MAX_TOTAL_CHARS = 50_000

export interface ContextFile {
  path: string
  text?: string // undefined when missing or outside the folder
  truncated?: boolean
}

// A context file list the core accepts: relative, inside the folder, no repeats.
export function cleanFiles(files: string[]): string[] {
  const out: string[] = []
  for (const f of files.map((x) => x.trim()).filter(Boolean)) {
    const n = normalize(f)
    if (isAbsolute(n) || n === '..' || n.startsWith(`..${sep}`) || out.includes(n)) continue
    out.push(n)
  }
  return out.slice(0, 10)
}

export const defaultFiles = (folder: string): string[] => PROJECT_FILES.filter((f) => existsSync(join(folder, f)))

// Read again at every reply, so the repository stays the source of truth. A
// file that resolves outside the folder (an agent's symlink to ~/.ssh, say) is never read.
export function readContext(project: Project): ContextFile[] {
  let root: string
  try {
    root = realpathSync(project.folder)
  } catch {
    return project.files.map((path) => ({ path }))
  }
  let left = MAX_TOTAL_CHARS
  return project.files.map((path) => {
    try {
      const real = realpathSync(join(root, path))
      if (!real.startsWith(root + sep) || !statSync(real).isFile() || left <= 0) return { path }
      const limit = Math.min(MAX_FILE_CHARS, left)
      const buf = Buffer.alloc(limit * 4)
      const fd = openSync(real, 'r')
      const n = readSync(fd, buf, 0, buf.length, 0)
      closeSync(fd)
      const all = buf.subarray(0, n).toString('utf8')
      const text = all.slice(0, limit)
      left -= text.length
      return { path, text, truncated: text.length < all.length || n === buf.length }
    } catch {
      return { path }
    }
  })
}

// The folders an agent should have: the ones lent by hand, plus one per project
// channel it's in with access. Returns undefined when nothing changes.
export function projectFolders(agent: Agent, conversations: Conversation[]): LentFolder[] | undefined {
  const current = agent.folders ?? []
  const next = current.filter((f) => !f.channelId)
  for (const c of conversations) {
    const access = c.project?.access[agent.id]
    if (c.kind !== 'channel' || !c.project || !access || !c.members.includes(agent.id)) continue
    const kept = current.find((f) => f.channelId === c.id && f.path === c.project!.folder)
    next.push({
      name: kept?.name ?? folderName(c.name, next.map((f) => f.name)),
      path: c.project.folder,
      readOnly: access === 'read_only',
      channelId: c.id
    })
  }
  return JSON.stringify(next) === JSON.stringify(current) ? undefined : next
}
