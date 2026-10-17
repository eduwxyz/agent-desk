// Routines (spec §14): a request scheduled for an agent, posted in a
// conversation at a day and time. A tick every 30 s runs whatever is due, so
// it also catches up after the Mac wakes or the app opens again.
import { randomUUID } from 'node:crypto'
import type { CoreEvent } from '../shared/rpc'
import { nextRun, validTime, type Message, type Routine, type RoutineInput } from '../shared/types'
import type { Db } from './db'

export const TICK_MS = 30_000
export const LATE_GRACE_MS = 12 * 3_600_000 // a run missed by more than this is skipped
const LATE_AFTER_MS = 2 * 60_000 // later than this is "atrasada" in the conversation

export interface RoutineDeps {
  db: Db
  runner: { runRoutine(r: Routine, when: { scheduledAt: number; late: boolean }): Promise<Message | undefined> }
  emit: (e: CoreEvent) => void
  notify?: (title: string, body: string, conversationId: string) => void
  now?: () => number
}

export class Routines {
  private running = new Set<string>()
  private runs = new Set<Promise<void>>()
  private timer: NodeJS.Timeout | null = null

  constructor(private deps: RoutineDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  start(): void {
    this.tick()
    this.timer ??= setInterval(() => this.tick(), TICK_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // Runs what is due once, at most, and moves each due routine to its next time.
  tick(): void {
    const now = this.now()
    for (const r of this.deps.db.routines()) {
      if (!r.enabled || r.nextAt === undefined || r.nextAt > now) continue
      const scheduledAt = r.nextAt
      this.store({ ...r, nextAt: nextRun(r.schedule, now) })
      if (now - scheduledAt > LATE_GRACE_MS) continue
      this.fire(r.id, { scheduledAt, late: now - scheduledAt > LATE_AFTER_MS })
    }
  }

  save(input: RoutineInput): Routine {
    const { db } = this.deps
    const name = input.name.trim()
    const prompt = input.prompt.trim()
    const agent = db.agent(input.agentId)
    const conv = db.conversation(input.conversationId)
    const days = [...new Set(input.schedule.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort()
    if (!name) throw new Error('Dê um nome pra rotina.')
    if (!prompt) throw new Error('Escreva o que o agente deve fazer.')
    if (!agent || agent.archived) throw new Error('Escolha um agente.')
    if (!conv || !(conv.kind === 'dm' ? conv.name === agent.id : conv.members.includes(agent.id))) throw new Error(`Escolha a DM com ${agent.name} ou um canal de que ele participa.`)
    if (days.length === 0) throw new Error('Escolha pelo menos um dia.')
    if (!validTime(input.schedule.time)) throw new Error('Horário inválido.')

    const prev = input.id ? db.routine(input.id) : undefined
    const schedule = { days, time: input.schedule.time }
    const r: Routine = {
      ...prev,
      id: prev?.id ?? randomUUID(),
      name,
      agentId: agent.id,
      conversationId: conv.id,
      prompt,
      schedule,
      enabled: input.enabled,
      nextAt: input.enabled ? nextRun(schedule, this.now()) : undefined,
      createdAt: prev?.createdAt ?? this.now()
    }
    this.store(r)
    return r
  }

  remove(id: string): void {
    this.deps.db.removeRoutine(id)
    this.deps.emit({ type: 'routine_removed', id })
  }

  runNow(id: string): void {
    this.fire(id, { scheduledAt: this.now(), late: false })
  }

  // Resolves when no routine is running (tests).
  async idle(): Promise<void> {
    while (this.runs.size) await Promise.all(this.runs)
  }

  private store(r: Routine): void {
    this.deps.db.saveRoutine(r)
    this.deps.emit({ type: 'routine', routine: r })
  }

  // One run of a routine at a time: if the last one is still going, this one skips.
  private fire(id: string, when: { scheduledAt: number; late: boolean }): void {
    const r = this.deps.db.routine(id)
    if (!r || this.running.has(id)) return
    this.running.add(id)
    const run = this.deps.runner
      .runRoutine(r, when)
      .then((reply) => {
        if (!reply) return
        const latest = this.deps.db.routine(id)
        if (latest) this.store({ ...latest, lastAt: this.now(), lastMessageId: reply.id })
        this.deps.notify?.(`${agentName(this.deps.db, r.agentId)} · ${r.name}`, outcome(reply), r.conversationId)
      })
      .catch((e: unknown) => console.error('[routines]', e))
      .finally(() => {
        this.running.delete(id)
        this.runs.delete(run)
      })
    this.runs.add(run)
  }
}

const agentName = (db: Db, id: string): string => db.agent(id)?.name ?? 'Agente'

// The notification's body: how the run ended, or the start of the reply.
export function outcome(reply: Message): string {
  switch (reply.run?.status) {
    case 'waiting_approval':
      return 'Pediu aprovação pra continuar.'
    case 'waiting_input':
      return `Perguntou: ${reply.run.question ?? ''}`.trim()
    case 'limit_reached':
      return 'Parou: chegou no limite de tokens do mês.'
    case 'failed':
      return `Falhou: ${reply.run.error ?? 'erro desconhecido'}`
    case 'stopped':
      return 'Foi interrompida.'
  }
  const plain = reply.text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>[\]]|\(https?:[^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > 140 ? `${plain.slice(0, 139)}…` : plain || 'Terminou.'
}
