import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import { describeSchedule, nextRun, type Agent, type EngineId, type Routine, type Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { LATE_GRACE_MS, outcome, Routines } from '../src/core/routines'
import { Runner } from '../src/core/runs'

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()
const WEEKDAYS = [1, 2, 3, 4, 5]

describe('schedule', () => {
  it('finds the next matching day and time, in local time', () => {
    const s = { days: WEEKDAYS, time: '09:00' }
    expect(nextRun(s, at(2026, 10, 16, 8, 0))).toBe(at(2026, 10, 16, 9, 0)) // Friday, before 9
    expect(nextRun(s, at(2026, 10, 16, 9, 0))).toBe(at(2026, 10, 19, 9, 0)) // exactly at 9 → Monday
    expect(nextRun({ days: [0], time: '23:30' }, at(2026, 10, 17, 12))).toBe(at(2026, 10, 18, 23, 30))
    expect(nextRun({ days: [], time: '09:00' }, Date.now())).toBeUndefined()
    expect(nextRun({ days: [1], time: '25:00' }, Date.now())).toBeUndefined()
  })

  it('says when it runs in plain words', () => {
    expect(describeSchedule({ days: [0, 1, 2, 3, 4, 5, 6], time: '08:30' })).toBe('Todo dia às 8:30')
    expect(describeSchedule({ days: WEEKDAYS, time: '09:00' })).toBe('Seg a sex às 9h')
    expect(describeSchedule({ days: [5], time: '17:00' })).toBe('Toda sexta às 17h')
    expect(describeSchedule({ days: [1, 3, 5], time: '07:15' })).toBe('Seg, qua e sex às 7:15')
  })
})

describe('routines', () => {
  const ready = { installed: true, loggedIn: true }
  const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system' }
  const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({
    id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false, ...extra
  })

  let db: Db
  let gateway: Gateway
  let turns: Turn[]
  let runner: Runner
  let routines: Routines
  let clock: number
  let notes: { title: string; body: string; conversationId: string }[]

  beforeEach(async () => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-routines-')), 'test.db'))
    db.saveAgent(agent('a1', 'lia'))
    db.saveAgent(agent('a2', 'theo'))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    db.createConversation({ id: 'c1', kind: 'channel', name: 'engenharia', members: ['a1'] })
    turns = []
    notes = []
    clock = at(2026, 10, 19, 8, 0) // a Monday
    const base = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine = { id: 'claude', run: (t) => (turns.push(t), base.run(t)) }
    const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex', { delayMs: 1 }) }
    const emit = (_: CoreEvent): void => {}
    gateway = new Gateway()
    await gateway.start()
    runner = new Runner({ db, engines, settings: async () => settings, emit, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')), gateway })
    routines = new Routines({ db, runner, emit, now: () => clock, notify: (title, body, conversationId) => notes.push({ title, body, conversationId }) })
  })

  afterEach(async () => {
    await gateway.stop()
  })

  const settle = async (): Promise<void> => {
    await routines.idle()
    await runner.idle()
  }
  const create = (extra: Partial<Routine> = {}): Routine =>
    routines.save({ name: 'Bom dia', agentId: 'a1', conversationId: 'c1', prompt: 'Resume o que está aberto no Linear.', schedule: { days: WEEKDAYS, time: '09:00' }, enabled: true, ...extra })
  const posted = (conv = 'c1') => db.messages().filter((m) => m.conversationId === conv)

  it('runs at its time: posts the request, the agent answers, and I get notified', async () => {
    const r = create()
    expect(r.nextAt).toBe(at(2026, 10, 19, 9, 0))

    routines.tick()
    await settle()
    expect(posted()).toHaveLength(0)

    clock = at(2026, 10, 19, 9, 0) + 10_000
    routines.tick()
    await settle()
    const [ask, reply] = posted()
    expect(ask).toMatchObject({ author: { kind: 'routine', id: r.id }, text: 'Resume o que está aberto no Linear.', routine: { name: 'Bom dia', late: false } })
    expect(reply).toMatchObject({ author: { kind: 'agent', id: 'a1' }, run: { status: 'done' } })

    const turn = turns.at(-1)!
    expect(turn.prompt).toContain('[Rotina "Bom dia", agendada por Edu')
    expect(turn.prompt).toContain('Esta é a rotina "Bom dia" (seg a sex às 9h)')
    expect(turn.prompt).toContain('pode não estar olhando')

    const saved = db.routine(r.id)!
    expect(saved.lastMessageId).toBe(reply!.id)
    expect(saved.nextAt).toBe(at(2026, 10, 20, 9, 0))
    expect(notes).toEqual([{ title: 'Lia · Bom dia', body: expect.stringContaining('Resposta de teste') as string, conversationId: 'c1' }])

    routines.tick() // nothing new is due
    await settle()
    expect(posted()).toHaveLength(2)
  })

  it('a run missed while the app was closed runs once, as late; one missed for too long is skipped', async () => {
    const r = create()
    clock = at(2026, 10, 19, 9, 40)
    routines.tick()
    routines.tick()
    await settle()
    expect(posted().filter((m) => m.author.kind === 'routine')).toHaveLength(1)
    expect(posted()[0]!.routine).toMatchObject({ late: true, scheduledAt: at(2026, 10, 19, 9, 0) })
    expect(turns.at(-1)!.prompt).toContain('Era pra ter rodado às 09:00')

    clock = at(2026, 10, 20, 9, 0) + LATE_GRACE_MS + 60_000 // Tuesday's run, missed by more than the grace
    routines.tick()
    await settle()
    expect(posted().filter((m) => m.author.kind === 'routine')).toHaveLength(1)
    expect(db.routine(r.id)!.nextAt).toBe(at(2026, 10, 21, 9, 0))
  })

  it('off means off, and turning it back on schedules from now', async () => {
    const r = create({ enabled: false })
    expect(r.nextAt).toBeUndefined()
    clock = at(2026, 10, 20, 12, 0)
    routines.tick()
    await settle()
    expect(posted()).toHaveLength(0)
    expect(routines.save({ ...r, enabled: true }).nextAt).toBe(at(2026, 10, 21, 9, 0))
  })

  it('one run at a time per routine', async () => {
    const r = create()
    routines.runNow(r.id)
    routines.runNow(r.id)
    await settle()
    expect(posted().filter((m) => m.author.kind === 'routine')).toHaveLength(1)
    routines.runNow(r.id)
    await settle()
    expect(posted().filter((m) => m.author.kind === 'routine')).toHaveLength(2)
  })

  it('an agent past its limit does not open the CLI, and the notification says so', async () => {
    db.saveAgent(agent('a1', 'lia', { limit: 0 }))
    const r = create()
    routines.runNow(r.id)
    await settle()
    expect(turns).toHaveLength(0)
    expect(posted().at(-1)!.run?.status).toBe('limit_reached')
    expect(notes[0]!.body).toBe('Parou: chegou no limite de tokens do mês.')
  })

  it('posts only where the agent is: its DM or one of its channels', () => {
    expect(() => create({ agentId: 'a2' })).toThrow(/participa/)
    expect(() => create({ conversationId: 'd1', agentId: 'a2' })).toThrow(/participa/)
    expect(() => create({ schedule: { days: [], time: '09:00' } })).toThrow(/dia/)
    expect(create({ conversationId: 'd1' }).conversationId).toBe('d1')
  })

  it('the notification is the start of the reply, in plain text', () => {
    const base = { id: 'm', conversationId: 'c1', author: { kind: 'agent' as const, id: 'a1' }, at: 0 }
    expect(outcome({ ...base, text: '## Resumo\n\n**3 issues** vencidas: [ENG-1](https://x.y/1)', run: { status: 'done', steps: [] } })).toBe('Resumo 3 issues vencidas: ENG-1')
    expect(outcome({ ...base, text: '', run: { status: 'waiting_approval', steps: [] } })).toBe('Pediu aprovação pra continuar.')
  })
})
