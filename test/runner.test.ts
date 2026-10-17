import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }

function agent(id: string, handle: string, extra: Partial<Agent> = {}): Agent {
  return { id, name: handle, handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, archived: false, ...extra }
}

// Wraps an engine to count how many turns were actually started.
function counted(engine: Engine): Engine & { turns: Turn[] } {
  const turns: Turn[] = []
  return { id: engine.id, turns, run: (t) => (turns.push(t), engine.run(t)) }
}

let db: Db
let events: CoreEvent[]
let claude: ReturnType<typeof counted>
let settings: Settings

function runner(engine: Engine = fakeEngine('claude', { delayMs: 1 })): Runner {
  claude = counted(engine)
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex', { delayMs: 1 }) }
  return new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir: mkdtempSync(join(tmpdir(), 'ad-work-')) })
}

const agentMessages = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  events = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready }, routerModel: 'haiku', defaultLimit: 1000, theme: 'system' }
  db.saveAgent(agent('a1', 'lia'))
  db.saveAgent(agent('a2', 'theo', { modelId: 'gpt-5.6-luna' }))
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
  db.createConversation({ id: 'c1', kind: 'channel', name: 'engenharia', members: ['a1', 'a2'] })
})

describe('Runner', () => {
  it('answers in a DM, streams deltas and records a receipt that matches the agent usage', async () => {
    const r = runner()
    await r.send('d1', 'oi')
    await r.idle()

    const [reply] = agentMessages()
    expect(reply?.run?.status).toBe('done')
    expect(reply?.text).toContain('Resposta de teste (claude · sonnet)')
    expect(events.some((e) => e.type === 'delta')).toBe(true)

    const receipt = reply!.run!.receipt!
    const tokens = receipt.inputTokens + receipt.outputTokens
    expect(db.receiptTotals(reply!.id).tokens).toBe(tokens)
    expect(db.agent('a1')!.used).toBe(tokens)
    expect(events.at(-1)).toMatchObject({ type: 'agent', agent: { id: 'a1', used: tokens } })
  })

  it('sends the workspace context, instructions and transcript to the engine', async () => {
    settings.context = 'Trabalho com evals.'
    const r = runner()
    await r.send('d1', 'qual o plano?')
    await r.idle()
    const turn = claude.turns[0]!
    expect(turn.system).toContain('Trabalho com evals.')
    expect(turn.prompt).toContain('qual o plano?')
    expect(turn.model).toBe('sonnet')
    expect(turn.effort).toBe('low')
  })

  it('in a channel, only mentioned agents answer, each on its own engine', async () => {
    const r = runner()
    await r.send('c1', '@theo e @lia, bom dia')
    await r.idle()
    const replies = agentMessages()
    expect(replies.map((m) => (m.author as { id: string }).id).sort()).toEqual(['a1', 'a2'])
    expect(replies.find((m) => (m.author as { id: string }).id === 'a2')?.text).toContain('codex · gpt-5.6-luna')
  })

  it('in a channel without a mention, nobody answers and a hint is posted', async () => {
    const r = runner()
    await r.send('c1', 'bom dia')
    await r.idle()
    expect(agentMessages()).toHaveLength(0)
    expect(db.messages().at(-1)?.author.kind).toBe('system')
    expect(claude.turns).toHaveLength(0)
  })

  it('stops mid-turn when the usage limit is crossed, then refuses the next turn without starting the engine', async () => {
    db.saveAgent(agent('a1', 'lia', { limit: 10 })) // the fake reports more than 10 tokens up front
    const r = runner()
    await r.send('d1', 'oi')
    await r.idle()
    expect(agentMessages()[0]?.run?.status).toBe('limit_reached')
    expect(claude.turns).toHaveLength(1)
    expect(db.agent('a1')!.used).toBeGreaterThan(10) // the partial turn still counts

    await r.send('d1', 'de novo')
    await r.idle()
    expect(agentMessages()[1]?.run?.status).toBe('limit_reached')
    expect(claude.turns).toHaveLength(1) // no second turn was started
  })

  it('stops a run on request', async () => {
    const r = runner(fakeEngine('claude', { delayMs: 30, reply: () => 'uma resposta bem longa que demora pra chegar inteira' }))
    await r.send('d1', 'oi')
    await new Promise((res) => setTimeout(res, 80))
    const working = agentMessages()[0]!
    expect(working.run?.status).toBe('working')
    r.stop(working.id)
    await r.idle()
    const stopped = db.message(working.id)!
    expect(stopped.run?.status).toBe('stopped')
    expect(stopped.text.length).toBeLessThan('uma resposta bem longa que demora pra chegar inteira'.length)
  })

  it('fails fast when the engine is not logged in, without starting it', async () => {
    settings.engines.claude = { installed: true, loggedIn: false }
    const r = runner()
    await r.send('d1', 'oi')
    await r.idle()
    const [reply] = agentMessages()
    expect(reply?.run?.status).toBe('failed')
    expect(reply?.run?.error).toContain('não está logado')
    expect(claude.turns).toHaveLength(0)
  })

  it('reports engine errors on the message', async () => {
    const broken: Engine = {
      id: 'claude',
      async *run() {
        yield { type: 'error', message: 'usage limit reached' }
      }
    }
    const r = runner(broken)
    await r.send('d1', 'oi')
    await r.idle()
    expect(agentMessages()[0]?.run).toMatchObject({ status: 'failed', error: 'usage limit reached' })
  })
})

describe('Db', () => {
  it('marks runs left working as interrupted on startup', () => {
    db.saveMessage({ id: 'm1', conversationId: 'd1', author: { kind: 'agent', id: 'a1' }, text: 'meio', at: 1, run: { status: 'working', steps: [{ id: 's', label: 'Pensando', status: 'running' }] } })
    expect(db.interruptStaleRuns()).toBe(1)
    expect(db.message('m1')?.run).toMatchObject({ status: 'interrupted', steps: [{ status: 'error' }] })
  })

  it('counts usage per calendar month only', () => {
    const lastMonth = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15).getTime()
    db.addReceipt({ messageId: 'x', agentId: 'a1', engine: 'claude', model: 'sonnet', inputTokens: 500, cacheReadTokens: 0, outputTokens: 0, ms: 1, at: lastMonth })
    db.addReceipt({ messageId: 'y', agentId: 'a1', engine: 'claude', model: 'sonnet', inputTokens: 70, cacheReadTokens: 0, outputTokens: 30, ms: 1, at: Date.now() })
    expect(db.usedThisMonth('a1')).toBe(100)
  })
})
