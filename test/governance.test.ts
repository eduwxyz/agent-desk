// End to end through the real pieces: the demo MCP server (stdio), the
// connector manager, the gateway and the runner. Only the model is fake: a
// scripted engine that calls tools through the gateway like a CLI would.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, GrantLevel, Message, Settings } from '../src/shared/types'
import { ConnectorManager } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { plainCipher, Secrets } from '../src/core/secrets'

const DEMO = join(import.meta.dirname, '..', 'scripts', 'demo-mcp-server.mjs')
const ready = { installed: true, loggedIn: true }

type Plan = { tool: string; args: Record<string, unknown> } | null

// A "model" that, on each turn, lists its tools and makes at most one call.
function scripted(plan: (turn: Turn, tools: string[]) => Plan, seen: { turns: Turn[]; tools: string[][]; results: unknown[] }): Engine {
  return {
    id: 'claude',
    async *run(turn) {
      seen.turns.push(turn)
      let reply = 'ok'
      if (turn.mcpUrl) {
        const client = new Client({ name: 'scripted', version: '0' })
        await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl)))
        const tools = (await client.listTools()).tools.map((t) => t.name)
        seen.tools.push(tools)
        const p = plan(turn, tools)
        if (p) {
          const r = await client.callTool({ name: p.tool, arguments: p.args })
          seen.results.push(r)
          reply = `chamei ${p.tool}`
        }
        await client.close()
      }
      yield { type: 'text', delta: reply }
      yield { type: 'done', text: reply, usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 } }
    }
  }
}

let dir: string
let tasksFile: string
let db: Db
let gateway: Gateway
let connectors: ConnectorManager
let events: CoreEvent[]
let settings: Settings
let connectorId: string
let seen: { turns: Turn[]; tools: string[][]; results: unknown[] }

const agent = (grant: GrantLevel): Agent => ({
  id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low',
  limit: 1_000_000, used: 0, grants: { [connectorId]: grant }, archived: false
})

function runner(plan: (turn: Turn, tools: string[]) => Plan, onDb: Db = db): Runner {
  return new Runner({
    db: onDb,
    engines: { claude: scripted(plan, seen), codex: fakeEngine('codex', { delayMs: 1 }) },
    settings: async () => settings,
    emit: (e) => events.push(e),
    workDir: join(dir, 'work'),
    gateway,
    connectors
  })
}

const tasks = (): { id: number; title: string; done: boolean }[] => {
  try {
    return JSON.parse(readFileSync(tasksFile, 'utf8')) as { id: number; title: string; done: boolean }[]
  } catch {
    return [] // not written yet: the server starts from its built-in list
  }
}
const agentMessages = (d: Db = db): Message[] => d.messages().filter((m) => m.author.kind === 'agent')
const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]?.text ?? '')

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ad-gov-'))
  tasksFile = join(dir, 'tasks.json')
  db = new Db(join(dir, 'test.db'))
  events = []
  seen = { turns: [], tools: [], results: [] }
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready }, routerModel: 'haiku', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system' }
  gateway = new Gateway()
  await gateway.start()
  connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: (e) => events.push(e), openUrl: () => {}, oauthCallbackUrl: () => gateway.url('/oauth/callback') })
  connectorId = await connectors.add({ kind: 'stdio', name: 'Tarefas', command: process.execPath, args: [DEMO], env: { DEMO_TASKS_FILE: tasksFile } })
  await connectors.connect(connectorId)
  db.saveAgent(agent('none'))
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
})

afterEach(async () => {
  await connectors.closeAll()
  await gateway.stop()
})

describe('connectors', () => {
  it('classifies the server tools on first sync and keeps the env value encrypted', async () => {
    const c = connectors.get(connectorId)!
    expect(c.status).toBe('connected')
    expect(c.envKeys).toEqual(['DEMO_TASKS_FILE'])
    expect(Object.fromEntries(c.tools.map((t) => [t.name, [t.cls, t.enabled]]))).toEqual({
      list_tasks: ['read', true],
      create_task: ['write', true],
      complete_task: ['write', true],
      delete_task: ['sensitive', true]
    })
    expect(db.getSecret(`connector:${connectorId}:env`)).toMatch(/^plain:/) // went through the cipher
  })

  it('a tool published later comes in disabled and flagged until reviewed', async () => {
    await connectors.call(connectorId, 'list_tasks', {})
    await expect.poll(() => connectors.get(connectorId)!.tools.find((t) => t.name === 'export_tasks')).toMatchObject({ enabled: false, isNew: true })
    connectors.updateTool(connectorId, 'export_tasks', { enabled: true })
    expect(connectors.get(connectorId)!.tools.find((t) => t.name === 'export_tasks')).toMatchObject({ enabled: true, isNew: false })
  })
})

describe('grants', () => {
  it('read: the agent sees only read tools, and a forced call to another is refused without running', async () => {
    db.saveAgent(agent('read'))
    const r = runner((_, tools) => ({ tool: tools.find((t) => t.endsWith('__create_task')) ?? 'tarefas__create_task', args: { title: 'invasora' } }))
    await r.send('d1', 'oi')
    await r.idle()
    expect(seen.tools[0]).toEqual(['ask_user', 'tarefas__list_tasks'])
    expect(seen.results[0]).toMatchObject({ isError: true })
    expect(textOf(seen.results[0])).toContain('não permitida')
    expect(tasks().some((t) => t.title === 'invasora')).toBe(false)
  })

  it('read_write: write tools run right away and show up as steps', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner((turn) => (turn.prompt.includes('cria') ? { tool: 'tarefas__create_task', args: { title: 'Nova' } } : null))
    await r.send('d1', 'cria uma tarefa')
    await r.idle()
    expect(textOf(seen.results[0])).toContain('Criada')
    expect(tasks().some((t) => t.title === 'Nova')).toBe(true)
    expect(agentMessages()[0]?.run?.steps.map((s) => [s.label, s.detail ?? ''])).toContainEqual(['Executou', 'Tarefas · create_task'])
  })

  it('removing the grant before a call takes effect immediately', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner((turn, tools) => {
      if (!turn.prompt.includes('cria')) return null
      db.saveAgent(agent('none')) // revoked while the turn runs
      return { tool: tools.find((t) => t.endsWith('__create_task'))!, args: { title: 'tarde demais' } }
    })
    await r.send('d1', 'cria')
    await r.idle()
    expect(textOf(seen.results[0])).toContain('não permitida')
    expect(tasks().some((t) => t.title === 'tarde demais')).toBe(false)
  })
})

describe('approvals', () => {
  const askDelete = (turn: Turn): Plan => (turn.prompt.includes('apaga') && !turn.prompt.includes('aprovou') && !turn.prompt.includes('recusou') ? { tool: 'tarefas__delete_task', args: { id: 2, _motivo: 'está duplicada' } } : null)

  it('a sensitive call becomes a pending approval and nothing runs', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner(askDelete)
    await r.send('d1', 'apaga a tarefa 2')
    await r.idle()

    const [ap] = db.approvals()
    expect(ap).toMatchObject({ state: 'pending', tool: 'delete_task', args: { id: 2 }, why: 'está duplicada', connectorName: 'Tarefas' })
    expect(agentMessages()[0]?.run).toMatchObject({ status: 'waiting_approval', approvalId: ap!.id })
    expect(textOf(seen.results[0])).toContain('NÃO foi executada')
    expect(tasks().some((t) => t.id === 2) || tasks().length === 0).toBe(true) // untouched
  })

  it('refusing hands the reason to the agent in a new turn and runs nothing', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner(askDelete)
    await r.send('d1', 'apaga a tarefa 2')
    await r.idle()
    const ap = db.approvals()[0]!
    await r.decide(ap.id, 'refused', 'ainda vou usar')
    await r.idle()

    expect(db.approval(ap.id)).toMatchObject({ state: 'refused', reason: 'ainda vou usar', outcome: 'Nada foi executado.' })
    expect(seen.turns.at(-1)?.prompt).toContain('Edu recusou o seu pedido "delete_task"')
    expect(seen.turns.at(-1)?.prompt).toContain('Motivo: "ainda vou usar"')
    expect(agentMessages()).toHaveLength(2)
    expect(tasks().length === 0 || tasks().some((t) => t.id === 2)).toBe(true)
  })

  it('approving runs exactly the stored call, once, and the agent gets the result', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner(askDelete)
    await r.send('d1', 'apaga a tarefa 2')
    await r.idle()
    const ap = db.approvals()[0]!
    await Promise.all([r.decide(ap.id, 'approved'), r.decide(ap.id, 'refused', 'tarde')]) // the first decision wins
    await r.idle()

    expect(db.approval(ap.id)).toMatchObject({ state: 'approved', outcome: 'Executou.' })
    expect(tasks().map((t) => t.id)).toEqual([1, 3])
    expect(seen.turns.at(-1)?.prompt).toContain('Resultado:\nApagada: #2')
    expect(agentMessages()[0]?.run?.steps.at(-1)).toMatchObject({ label: 'Aprovado', status: 'done' })
  })

  it('a pending approval survives a restart and still runs when approved', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner(askDelete)
    await r.send('d1', 'apaga a tarefa 2')
    await r.idle()
    const ap = db.approvals()[0]!

    // "Restart": a new database handle on the same file, a new connector manager and runner.
    await connectors.closeAll()
    db.close()
    db = new Db(join(dir, 'test.db'))
    connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => '' })
    const r2 = runner(askDelete, db)
    expect(db.approval(ap.id)?.state).toBe('pending')
    await r2.decide(ap.id, 'approved')
    await r2.idle()
    expect(db.approval(ap.id)?.outcome).toBe('Executou.')
    expect(tasks().map((t) => t.id)).toEqual([1, 3])
  })

  it('does not run an approved call if the grant was removed meanwhile', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner(askDelete)
    await r.send('d1', 'apaga a tarefa 2')
    await r.idle()
    db.saveAgent(agent('read'))
    await r.decide(db.approvals()[0]!.id, 'approved')
    await r.idle()
    expect(db.approvals()[0]?.outcome).toContain('Não executou')
    expect(tasks().length === 0 || tasks().some((t) => t.id === 2)).toBe(true)
  })

  it('expired approvals are closed and the agent is told', async () => {
    db.saveAgent(agent('read_write'))
    settings.approvalTtlHours = -1 // already expired
    const r = runner(askDelete)
    await r.send('d1', 'apaga a tarefa 2')
    await r.idle()
    await r.expireApprovals()
    await r.idle()
    expect(db.approvals()[0]).toMatchObject({ state: 'expired', outcome: 'Expirou sem decisão.' })
    expect(seen.turns.at(-1)?.prompt).toContain('expirou sem decisão')
  })
})
