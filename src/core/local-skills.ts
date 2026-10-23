// The skills already on this Mac: the user's Claude Code skills (~/.claude/skills),
// the skills of the Claude Code plugins they turned on, and their Codex skills
// (~/.codex/skills). The app reads them, never runs them: the user links one to
// agents, and an agent reads it with ler_skill, straight from the file, so an
// edit in Claude Code counts from the next read.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import type { LocalSkill } from '../shared/types'

const TEXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.toml', '.xml', '.html'])
const SCRIPT = new Set(['.py', '.sh', '.js', '.mjs', '.cjs', '.ts', '.rb', '.go', '.swift'])
const MAX_FILE = 60_000

const dirs = (d: string): string[] => {
  try {
    return readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(d, e.name))
  } catch {
    return []
  }
}

// name and description from the YAML frontmatter, including "description: |" blocks.
export function frontmatter(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { body: text }
  const lines = m[1]!.split(/\r?\n/)
  const field = (key: string): string | undefined => {
    const i = lines.findIndex((l) => l.startsWith(`${key}:`))
    if (i < 0) return undefined
    const inline = lines[i]!.slice(key.length + 1).trim()
    if (inline && !/^[|>][-+]?$/.test(inline)) return inline.replace(/^(["'])(.*)\1$/, '$2')
    const block: string[] = []
    for (const l of lines.slice(i + 1)) {
      if (/^\S/.test(l)) break
      block.push(l.trim())
    }
    return block.join(' ').trim() || undefined
  }
  return { name: field('name'), description: field('description'), body: text.slice(m[0].length) }
}

// The other files of a skill: text ones it may point to, and whether it has scripts.
function contents(dir: string): { files: string[]; scripts: boolean } {
  const files: string[] = []
  let scripts = false
  const walk = (d: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'scripts') scripts = true
        if (depth < 2) walk(p, depth + 1)
      } else if (SCRIPT.has(extname(e.name))) scripts = true
      else if (TEXT.has(extname(e.name)) && e.name !== 'SKILL.md') files.push(relative(dir, p))
    }
  }
  walk(dir, 0)
  return { files: files.sort(), scripts }
}

function skill(file: string, origin: string): LocalSkill | undefined {
  try {
    const fm = frontmatter(readFileSync(file, 'utf8'))
    const dir = dirname(file)
    return { source: file, name: fm.name || basename(dir), description: fm.description || '', origin, ...contents(dir) }
  } catch {
    return undefined
  }
}

const inDirs = (root: string, origin: string): LocalSkill[] =>
  dirs(root)
    .map((d) => skill(join(d, 'SKILL.md'), origin))
    .filter((s): s is LocalSkill => !!s)

// The newest version folder of each plugin the user turned on in Claude Code.
function pluginSkills(claude: string): LocalSkill[] {
  let enabled: string[] = []
  try {
    const s = JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')) as { enabledPlugins?: Record<string, boolean> }
    enabled = Object.entries(s.enabledPlugins ?? {})
      .filter(([, on]) => on)
      .map(([k]) => k)
  } catch {
    return []
  }
  return enabled.flatMap((key) => {
    const [plugin, market] = key.split('@')
    if (!plugin || !market) return []
    const versions = dirs(join(claude, 'plugins', 'cache', market, plugin)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    return versions[0] ? inDirs(join(versions[0], 'skills'), `Plugin ${plugin}`) : []
  })
}

export function findLocalSkills(home = homedir()): LocalSkill[] {
  const claude = process.env['CLAUDE_CONFIG_DIR'] || join(home, '.claude')
  const codex = process.env['CODEX_HOME'] || join(home, '.codex')
  return [...inDirs(join(claude, 'skills'), 'Claude Code'), ...pluginSkills(claude), ...inDirs(join(codex, 'skills'), 'Codex')]
}

// A linked skill's recipe, or one of its files; never a file outside its folder.
export function readLinked(source: string, file?: string): string {
  const dir = realpathSync(dirname(source))
  if (!file) return frontmatter(readFileSync(source, 'utf8')).body.trim()
  const path = realpathSync(join(dir, file))
  if (!path.startsWith(dir + sep)) throw new Error('Esse arquivo não é da skill.')
  if (!TEXT.has(extname(path))) throw new Error('Só dá pra ler arquivos de texto da skill.')
  const text = readFileSync(path, 'utf8')
  return text.length > MAX_FILE ? `${text.slice(0, MAX_FILE)}\n\n[… cortado em ${MAX_FILE} caracteres]` : text
}
