// Routines (spec §14): a request scheduled for an agent, posted in a
// conversation at a day and time. A tick every 30 s runs whatever is due, so
// it also catches up after the Mac wakes or the app opens again.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { CoreEvent } from '../shared/rpc'
import { describeSchedule, nextRun, validTime, type Agent, type Connector, type Conversation, type Message, type Routine, type RoutineInput, type Trigger } from '../shared/types'
import type { Db } from './db'
import type { ToolDef } from './gateway'
import type { RoutineEvent } from './runs'

export const TICK_MS = 30_000
export const LATE_GRACE_MS = 12 * 3_600_000 // a run missed by more than this is skipped
const LATE_AFTER_MS = 2 * 60_000 // later than this is "atrasada" in the conversation
export const MAX_AGENT_ROUTINES = 10 // active ones per agent, so an agent can't schedule itself without end

const DAY_KEYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab']

export const AGENDAR: ToolDef = {
  name: 'agendar_rotina',
  description:
    'Agenda uma rotina pra você mesmo: no horário, o app posta o pedido nesta conversa e você roda sozinho, sem ninguém pedir. Use quando pedirem algo pra depois ("daqui a 10 minutos", "toda segunda às 9h", "amanhã cedo"). Também muda uma rotina sua, com substitui.',
  inputSchema: {
    type: 'object',
    properties: {
      nome: { type: 'string', description: 'Nome curto (ex.: "Issues do Linear").' },
      pedido: {
        type: 'string',
        description: 'O que fazer quando rodar, escrito como um pedido completo pra você mesmo. Inclua o contexto que precisar: quando rodar, você vê só as mensagens recentes desta conversa.'
      },
      horario: { type: 'string', description: 'HH:MM, 24 h, no horário local (o mesmo das mensagens).' },
      dias: { type: 'array', items: { type: 'string', enum: DAY_KEYS }, description: 'Dias da semana em que roda. Sem dias: todos.' },
      uma_vez: { type: 'boolean', description: 'true pra rodar uma vez só (no próximo horário que bate com os dias) e depois desligar.' },
      substitui: { type: 'string', description: 'Id de uma rotina sua que esta muda.' }
    },
    required: ['nome', 'pedido', 'horario']
  }
}

export const CANCELAR: ToolDef = {
  name: 'cancelar_rotina',
  description: 'Apaga uma rotina sua.',
  inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'O id da rotina.' } }, required: ['id'] }
}

export const ROUTINE_TOOL_NAMES = new Set([AGENDAR.name, CANCELAR.name])

// "sáb, 18/10, 13:15"
export const whenText = (at: number): string =>
  new Date(at).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace('.', '')

type ToolOutcome = { routine?: Routine; reply: string; error?: boolean }

const MAX_SEEN = 500 // item ids remembered per connector trigger
const MAX_EVENT_CHARS = 6_000

export interface RoutineDeps {
  db: Db
  runner: { runRoutine(r: Routine, when: { scheduledAt: number; late: boolean; event?: RoutineEvent }): Promise<Message | undefined> }
  connectors?: { call(id: string, tool: string, args: Record<string, unknown>): Promise<CallToolResult>; list(): Connector[] }
  emit: (e: CoreEvent) => void
  notify?: (title: string, body: string, conversationId: string) => void
  now?: () => number
}

export class Routines {
  private running = new Set<string>()
  private checking = new Set<string>()
  private runs = new Set<Promise<void>>()
  private timer: NodeJS.Timeout | null = null
  private awake = true

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

  // Between the Mac going to sleep and really waking up, nothing is due: the
  // wake catches up, with what was missed marked late.
  setAwake(awake: boolean): void {
    this.awake = awake
    if (awake) this.tick()
  }

  // Runs what is due once, at most, and moves each due routine to its next time.
  tick(): void {
    if (!this.awake) return
    const now = this.now()
    for (const r of this.deps.db.routines()) {
      if (r.enabled && r.trigger?.kind === 'poll' && now - (r.trigger.checkedAt ?? 0) >= r.trigger.everyMinutes * 60_000) void this.check(r)
      if (!r.enabled || r.trigger || r.nextAt === undefined || r.nextAt > now) continue
      const scheduledAt = r.nextAt
      this.store(r.schedule.once ? { ...r, enabled: false, nextAt: undefined } : { ...r, nextAt: nextRun(r.schedule, now) })
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
    const prev = input.id ? db.routine(input.id) : undefined
    const trigger = input.trigger && this.cleanTrigger(input.trigger, prev?.trigger)
    if (!trigger && days.length === 0) throw new Error('Escolha pelo menos um dia.')
    if (!trigger && !validTime(input.schedule.time)) throw new Error('Horário inválido.')

    const schedule = { days, time: input.schedule.time, ...(input.schedule.once ? { once: true } : {}) }
    const r: Routine = {
      ...prev,
      id: prev?.id ?? randomUUID(),
      name,
      agentId: agent.id,
      conversationId: conv.id,
      prompt,
      schedule,
      trigger,
      enabled: input.enabled,
      nextAt: input.enabled && !trigger ? nextRun(schedule, this.now()) : undefined,
      createdBy: prev ? prev.createdBy : input.createdBy,
      createdAt: prev?.createdAt ?? this.now()
    }
    this.store(r)
    if (r.enabled && trigger?.kind === 'poll' && trigger.seen === undefined) void this.check(r) // what's there now doesn't fire
    return r
  }

  // A connector trigger keeps what it has seen while the same check is kept;
  // a webhook keeps its address.
  private cleanTrigger(t: Trigger, prev?: Trigger): Trigger {
    if (t.kind === 'webhook') return { kind: 'webhook', token: prev?.kind === 'webhook' ? prev.token : randomBytes(18).toString('base64url') }
    const tool = this.deps.db.tools(t.connectorId).find((x) => x.name === t.tool)
    if (!this.deps.connectors?.list().some((c) => c.id === t.connectorId)) throw new Error('Escolha um conector.')
    if (!tool || !tool.enabled || tool.cls !== 'read') throw new Error('Escolha uma ferramenta de leitura do conector.')
    const everyMinutes = Math.max(1, Math.round(t.everyMinutes))
    const same = prev?.kind === 'poll' && prev.connectorId === t.connectorId && prev.tool === t.tool && JSON.stringify(prev.args) === JSON.stringify(t.args)
    return { kind: 'poll', connectorId: t.connectorId, tool: t.tool, args: t.args, everyMinutes, ...(same ? { seen: prev.seen, checkedAt: prev.checkedAt } : {}) }
  }

  // What the check finds right now, for the form ("Testar").
  async preview(t: Trigger): Promise<string> {
    if (t.kind !== 'poll') return ''
    const { items } = await this.look(t)
    if (items.length === 1 && items[0]!.whole) return 'A resposta não é uma lista: a rotina vai rodar quando ela mudar.'
    return `Achei ${items.length} ${items.length === 1 ? 'item' : 'itens'} agora${items.length ? `: ${items.slice(0, 3).map((i) => i.title).join('; ')}${items.length > 3 ? '…' : ''}` : ''}. Eles não disparam: a rotina roda pros que aparecerem depois.`
  }

  private async look(t: Extract<Trigger, { kind: 'poll' }>): Promise<{ items: EventItem[]; source: string }> {
    const connector = this.deps.connectors?.list().find((c) => c.id === t.connectorId)
    if (!this.deps.connectors || !connector) throw new Error('o conector não existe mais')
    const tool = this.deps.db.tools(t.connectorId).find((x) => x.name === t.tool)
    if (!tool || !tool.enabled || tool.cls !== 'read') throw new Error(`a ferramenta ${t.tool} não está liberada como leitura`)
    const r = await this.deps.connectors.call(t.connectorId, t.tool, t.args)
    const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    if (r.isError) throw new Error(text.slice(0, 200) || 'a ferramenta deu erro')
    return { items: eventItems(text), source: `${connector.name} · ${t.tool}` }
  }

  // One check of a connector trigger. The first one only learns what's there;
  // after that, the first new item runs the routine (one run at a time), and
  // the rest wait for the next check, which comes right after that run.
  private async check(r: Routine): Promise<void> {
    if (r.trigger?.kind !== 'poll' || this.checking.has(r.id) || this.running.has(r.id)) return
    this.checking.add(r.id)
    const t = r.trigger
    try {
      const { items, source } = await this.look(t)
      const latest = this.deps.db.routine(r.id)
      if (latest?.trigger?.kind !== 'poll') return
      const seen = latest.trigger.seen
      const fresh = seen ? items.filter((i) => !seen.includes(i.key)) : []
      const next = fresh[0]
      const keep = [...(seen ?? items.map((i) => i.key)), ...(next ? [next.key] : [])].slice(-MAX_SEEN)
      this.store({ ...latest, trigger: { ...latest.trigger, seen: keep, checkedAt: this.now(), error: undefined } })
      if (next && latest.enabled) this.fire(r.id, { scheduledAt: this.now(), late: false, event: { source, title: next.title, body: next.body } }, fresh.length > 1)
    } catch (e) {
      const latest = this.deps.db.routine(r.id)
      if (latest?.trigger?.kind === 'poll') this.store({ ...latest, trigger: { ...latest.trigger, checkedAt: this.now(), error: e instanceof Error ? e.message : String(e) } })
    } finally {
      this.checking.delete(r.id)
    }
  }

  // A call to http://127.0.0.1:WEBHOOK_PORT/gatilho/<token>, from something on this Mac.
  webhook(token: string, body: string): 'ok' | 'unknown' | 'busy' {
    const r = this.deps.db.routines().find((x) => x.trigger?.kind === 'webhook' && x.trigger.token === token)
    if (!r || !r.enabled) return 'unknown'
    if (this.running.has(r.id)) return 'busy'
    const text = body.trim()
    this.fire(r.id, { scheduledAt: this.now(), late: false, event: { source: 'chamada local', title: text.split('\n')[0]!.slice(0, 120) || 'chamada sem conteúdo', body: text.slice(0, MAX_EVENT_CHARS) || '(vazio)' } })
    return 'ok'
  }

  // The agent's own routines, for its prompt.
  forAgent(agentId: string): Routine[] {
    return this.deps.db.routines().filter((r) => r.agentId === agentId && r.enabled)
  }

  // `agendar_rotina`: an agent schedules (or changes) a routine for itself, posted where it was asked.
  schedule(agent: Agent, conv: Conversation, args: Record<string, unknown>): ToolOutcome {
    const text = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string).trim() : '')
    const fail = (reply: string): ToolOutcome => ({ reply, error: true })
    const replaces = text('substitui')
    const prev = replaces ? this.deps.db.routine(replaces) : undefined
    if (replaces && prev?.agentId !== agent.id) return fail(`Não achei uma rotina sua com id ${replaces}.`)
    if (!prev && this.forAgent(agent.id).length >= MAX_AGENT_ROUTINES) return fail(`Você já tem ${MAX_AGENT_ROUTINES} rotinas ligadas. Cancele uma antes.`)

    const keys = Array.isArray(args['dias']) ? (args['dias'] as unknown[]).map((d) => DAY_KEYS.indexOf(String(d).slice(0, 3).toLowerCase().normalize('NFD').replace(/[^a-z]/g, ''))) : []
    if (keys.includes(-1)) return fail(`Dias inválidos: use ${DAY_KEYS.join(', ')}.`)
    const time = text('horario').padStart(5, '0')
    try {
      const routine = this.save({
        id: prev?.id,
        name: text('nome'),
        prompt: text('pedido'),
        agentId: agent.id,
        conversationId: prev?.conversationId ?? conv.id,
        schedule: { days: keys.length ? keys : [0, 1, 2, 3, 4, 5, 6], time, once: args['uma_vez'] === true },
        enabled: true,
        createdBy: agent.id
      })
      return {
        routine,
        reply: `Rotina ${prev ? 'atualizada' : 'agendada'} (id ${routine.id}): ${describeSchedule(routine.schedule).toLowerCase()}. Próxima vez: ${whenText(routine.nextAt!)}. Ela aparece na tela de Rotinas, onde dá pra mudar ou apagar.`
      }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  }

  // `cancelar_rotina`
  cancel(agent: Agent, id: string): ToolOutcome {
    const r = this.deps.db.routine(id)
    if (r?.agentId !== agent.id) return { reply: `Não achei uma rotina sua com id ${id}.`, error: true }
    this.remove(id)
    return { routine: r, reply: `Rotina "${r.name}" apagada.` }
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
  // `more`: a connector check left new items, so check again when this run ends.
  private fire(id: string, when: { scheduledAt: number; late: boolean; event?: RoutineEvent }, more = false): void {
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
        const latest = this.deps.db.routine(id)
        if (more && latest?.trigger?.kind === 'poll') void this.check(latest)
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
    case 'paused':
      return 'Pausou no teto da resposta. Abra pra continuar.'
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

interface EventItem {
  key: string
  title: string
  body: string
  whole?: boolean // the result isn't a list: the item is the whole result, new when it changes
}

const hash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 16)

// The items in a read tool's result: the first list of objects in its JSON
// (Linear's issues, GitHub's runs, Gmail's messages…), each keyed by its id.
export function eventItems(text: string): EventItem[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return [{ key: hash(text), title: 'a resposta mudou', body: text.slice(0, MAX_EVENT_CHARS), whole: true }]
  }
  const list = findList(data, 0)
  if (!list) return [{ key: hash(text), title: 'a resposta mudou', body: text.slice(0, MAX_EVENT_CHARS), whole: true }]
  return list.map((o) => {
    const pick = (...keys: string[]): string | undefined => keys.map((k) => o[k]).find((v): v is string | number => typeof v === 'string' || typeof v === 'number')?.toString()
    const json = JSON.stringify(o, null, 1)
    const id = pick('id', 'identifier', 'number', 'url', 'key')
    const title = pick('title', 'name', 'subject', 'summary') ?? id ?? json.slice(0, 80)
    // Linear's id is already the readable one (OAB-65); a uuid isn't.
    const ref = pick('identifier', 'number', 'key') ?? (id && id.length <= 20 && !/^[0-9a-f-]+$/i.test(id) ? id : undefined)
    return { key: id ?? hash(json), title: ref && ref !== title ? `${ref} · ${title}` : title, body: json.slice(0, MAX_EVENT_CHARS) }
  })
}

function findList(v: unknown, depth: number): Record<string, unknown>[] | undefined {
  if (Array.isArray(v)) return v.length === 0 || v.every((x) => x && typeof x === 'object' && !Array.isArray(x)) ? (v as Record<string, unknown>[]) : undefined
  if (!v || typeof v !== 'object' || depth > 3) return undefined
  for (const x of Object.values(v)) {
    const found = findList(x, depth + 1)
    if (found) return found
  }
  return undefined
}
