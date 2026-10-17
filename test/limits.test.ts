import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, EngineEvent } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const agent = (extra: Partial<Agent> = {}): Agent => ({
  id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false, ...extra
})

// Calls a tool over and over, like a model stuck in a loop, until the app cuts it.
const looping: Engine = {
  id: 'claude',
  async *run(turn): AsyncIterable<EngineEvent> {
    yield { type: 'progress', tokens: 100 }
    for (let i = 0; i < 100 && !turn.signal.aborted; i++) await callTool(turn.mcpUrl!, 'ask_user', { question: `de novo ${i}?` }).catch(() => {})
    if (!turn.signal.aborted) yield { type: 'done', text: 'fim', usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 1 } }
  }
}

// Never finishes on its own.
const hanging: Engine = {
  id: 'claude',
  async *run(turn): AsyncIterable<EngineEvent> {
    yield { type: 'text', delta: 'Começando' }
    await new Promise((r) => turn.signal.addEventListener('abort', r))
  }
}

let db: Db
let gateway: Gateway
let settings: Settings
let notes: string[]

const runner = (claude: Engine): Runner => {
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex', { delayMs: 1 }) }
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')), gateway, notify: (title) => notes.push(title) })
}
const reply = () => db.messages().filter((m) => m.author.kind === 'agent').at(-1)!

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-limits-')), 'test.db'))
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system' }
  notes = []
  db.saveAgent(agent())
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
  gateway = new Gateway()
  await gateway.start()
})

afterEach(async () => {
  await gateway.stop()
})

describe('limits per reply', () => {
  it('refuses tool calls past the cap, then cuts a model that keeps calling', async () => {
    settings.runMaxToolCalls = 5
    const r = runner(looping)
    await r.send('d1', 'oi')
    await r.idle()
    const m = reply()
    expect(m.run?.status).toBe('failed')
    expect(m.run?.error).toContain('passei de 5 chamadas de ferramenta')
    expect(m.run?.steps.map((s) => s.label)).toContain('Chegou no limite de ferramentas')
  })

  it('stops a reply that runs past the time limit, keeping what it wrote', async () => {
    settings.runMaxMinutes = 0.002 // ~120 ms
    const r = runner(hanging)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply()).toMatchObject({ text: 'Começando …', run: { status: 'failed', error: expect.stringContaining('minutos') as string } })
  })
})

describe('usage alert', () => {
  it('warns once, in the conversation and with a notification, when an agent crosses 80% of its limit', async () => {
    db.saveAgent(agent({ limit: 10_000 }))
    db.addReceipt({ model: 'sonnet', inputTokens: 7_900, cacheReadTokens: 0, outputTokens: 0, ms: 1, messageId: 'old', agentId: 'a1', engine: 'claude', at: Date.now() })
    const r = runner(fakeEngine('claude', { delayMs: 1 }))
    await r.send('d1', 'oi')
    await r.idle()
    await r.send('d1', 'oi de novo')
    await r.idle()
    const alerts = db.messages().filter((m) => m.author.kind === 'system' && m.text.includes('do limite do mês'))
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.text).toMatch(/\*\*Lia\*\* já usou 8\d% do limite do mês \(\d+ mil de 10 mil tokens\)/)
    expect(notes).toEqual([expect.stringMatching(/^Lia usou 8\d% do limite do mês$/)])
  })
})
