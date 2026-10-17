import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { projectScope, type Agent, type Conversation, type EngineId, type Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Memories } from '../src/core/memory'
import { cleanFiles, projectFolders, readContext } from '../src/core/projects'
import { Runner } from '../src/core/runs'

const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra
})

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ad-repo-'))
  writeFileSync(join(dir, 'CLAUDE.md'), '# Regras\nTestes com swift test.')
  writeFileSync(join(dir, 'README.md'), 'x'.repeat(30_000))
  mkdirSync(join(dir, 'docs'))
  symlinkSync(join(homedir(), '.zshrc'), join(dir, 'docs', 'segredo.md')) // an agent's trick to read the Mac
  return dir
}

describe('context files', () => {
  it('reads the files, cut at a size, and never one that resolves outside the folder', () => {
    const folder = repo()
    const [claude, readme, secret, missing] = readContext({ folder, files: ['CLAUDE.md', 'README.md', 'docs/segredo.md', 'NADA.md'], brief: '', access: {} })
    expect(claude).toEqual({ path: 'CLAUDE.md', text: '# Regras\nTestes com swift test.', truncated: false })
    expect(readme!.text).toHaveLength(20_000)
    expect(readme!.truncated).toBe(true)
    expect(secret!.text).toBeUndefined()
    expect(missing!.text).toBeUndefined()
  })

  it('accepts only paths inside the folder', () => {
    expect(cleanFiles(['CLAUDE.md', ' docs/a.md ', '../fora.md', '/etc/passwd', 'CLAUDE.md', ''])).toEqual(['CLAUDE.md', 'docs/a.md'])
  })
})

describe('project folders', () => {
  const channel = (extra: Partial<Conversation> = {}): Conversation => ({
    id: 'c1', kind: 'channel', name: 'simula-oab', members: ['a1', 'a2'],
    project: { folder: '/Users/edu/dev/app', files: [], brief: '', access: { a1: 'read_write', a2: 'read_only' } }, ...extra
  })

  it("lends the project's folder to members with access, next to folders lent by hand", () => {
    const manual = { name: 'outro', path: '/Users/edu/outro', readOnly: false }
    const lia = agent('a1', 'lia', { folders: [manual] })
    const next = projectFolders(lia, [channel()])
    expect(next).toEqual([manual, { name: 'simula-oab', path: '/Users/edu/dev/app', readOnly: false, channelId: 'c1' }])
    expect(projectFolders({ ...lia, folders: next }, [channel()])).toBeUndefined() // nothing to change
    expect(projectFolders(agent('a2', 'theo'), [channel()])![0]!.readOnly).toBe(true)
  })

  it('takes it back when access, membership or the project goes', () => {
    const lia = agent('a1', 'lia', { folders: [{ name: 'simula-oab', path: '/Users/edu/dev/app', readOnly: false, channelId: 'c1' }] })
    expect(projectFolders(lia, [channel({ members: ['a2'] })])).toEqual([])
    expect(projectFolders(lia, [channel({ project: undefined })])).toEqual([])
  })
})

describe('in a project channel', () => {
  const ready = { installed: true, loggedIn: true }
  const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system' }
  let db: Db
  let gateway: Gateway
  let turns: Turn[]
  let runner: Runner
  let memory: Memories

  beforeEach(async () => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-proj-')), 'test.db'))
    turns = []
    const folder = repo()
    db.saveAgent(agent('a1', 'lia', { computer: true }))
    db.setFolders('a1', [{ name: 'simula-oab', path: folder, readOnly: false, channelId: 'c1' }])
    db.saveAgent(agent('a2', 'pm'))
    db.createConversation({ id: 'c1', kind: 'channel', name: 'simula-oab', members: ['a1', 'a2'] })
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a2', members: ['a2'] })
    db.setProject('c1', { folder, files: ['CLAUDE.md'], brief: 'Foco: lançar a 2ª fase.', access: { a1: 'read_write' } })
    const base = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine = { id: 'claude', run: (t) => (turns.push(t), base.run(t)) }
    const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex', { delayMs: 1 }) }
    gateway = new Gateway()
    await gateway.start()
    const workDir = mkdtempSync(join(tmpdir(), 'ad-w-'))
    memory = new Memories({ db, engines, settings: async () => settings, emit: () => {}, workDir })
    runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir, gateway, memory })
  })

  afterEach(async () => {
    await gateway.stop()
  })

  const systemOf = (handle: string): string => turns.filter((t) => t.system.includes(`é ${handle[0]!.toUpperCase()}${handle.slice(1)} (@${handle})`)).at(-1)!.system

  it('every agent gets the context files, the brief and where the folder is, if it has it', async () => {
    await runner.send('c1', '@lia @pm oi')
    await runner.idle()
    const lia = systemOf('lia')
    expect(lia).toContain('## Projeto deste canal: ad-repo-')
    expect(lia).toContain('### CLAUDE.md\n# Regras\nTestes com swift test.')
    expect(lia).toContain('Foco: lançar a 2ª fase.')
    expect(lia).toContain('/projetos/simula-oab')
    expect(systemOf('pm')).toContain('Você não tem a pasta do projeto')
    expect(systemOf('pm')).toContain('Testes com swift test.')
  })

  it("a project memory reaches every agent in the channel, and stays out of other conversations", async () => {
    const r = memory.remember(db.agent('a1')!, db.conversation('c1')!, { texto: 'A API v1 está congelada', sobre: 'projeto' })
    expect(r.memory?.scope).toBe(projectScope('c1'))
    expect(memory.remember(db.agent('a2')!, db.conversation('d1')!, { texto: 'x', sobre: 'projeto' }).error).toBe(true)

    await runner.send('c1', '@pm o que está congelado?')
    await runner.send('d1', 'e aí?')
    await runner.idle()
    const [inChannel, inDm] = turns.filter((t) => t.system.includes('é Pm (@pm)')).map((t) => t.system)
    expect([inChannel, inDm].filter((s) => s!.includes('A API v1 está congelada'))).toHaveLength(1)
    expect(inChannel).toContain('A API v1 está congelada')
  })
})
