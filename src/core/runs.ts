import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CoreEvent } from '../shared/rpc'
import { ENGINES, modelInfo, type Agent, type Conversation, type EngineId, type Message, type Receipt, type Run, type Settings } from '../shared/types'
import { HISTORY_LIMIT, mentioned, systemPrompt, transcript } from './context'
import type { Db } from './db'
import type { Engine } from './engines/types'

const MAX_CONCURRENT = 4
const MAX_MENTIONS = 3
const DELTA_FLUSH_MS = 40

export interface RunnerDeps {
  db: Db
  engines: Record<EngineId, Engine>
  settings: () => Promise<Settings> // resolves once engine detection is done
  emit: (e: CoreEvent) => void
  workDir: string // per-agent empty directories live here
}

export class Runner {
  private queue: (() => Promise<void>)[] = []
  private active = 0
  private controllers = new Map<string, { ctl: AbortController; reason?: 'stopped' | 'limit' }>()
  private idleWaiters: (() => void)[] = []

  constructor(private deps: RunnerDeps) {}

  // Saves the human message and starts a run for each agent that should answer.
  async send(conversationId: string, text: string): Promise<void> {
    const { db, emit } = this.deps
    const conv = db.conversation(conversationId)
    const body = text.trim()
    if (!conv || !body) return

    const mine: Message = { id: randomUUID(), conversationId, author: { kind: 'me' }, text: body, at: Date.now() }
    db.saveMessage(mine)
    emit({ type: 'message', message: mine })

    const members = conv.members.map((id) => db.agent(id)).filter((a): a is Agent => !!a && !a.archived)
    let responders: Agent[]
    if (conv.kind === 'dm' || members.length === 1) {
      responders = members
    } else {
      responders = mentioned(body, members).slice(0, MAX_MENTIONS)
      if (responders.length === 0 && members.length > 0) {
        this.system(conversationId, 'Ninguém foi mencionado. Use **@nome** pra chamar um agente. O router, que escolhe sozinho quem responde, chega na próxima etapa.')
      }
    }
    for (const agent of responders) this.enqueue(() => this.execute(agent, conv))
  }

  stop(messageId: string): void {
    const c = this.controllers.get(messageId)
    if (!c) return
    c.reason = 'stopped'
    c.ctl.abort()
  }

  private system(conversationId: string, text: string): void {
    const m: Message = { id: randomUUID(), conversationId, author: { kind: 'system' }, text, at: Date.now() }
    this.deps.db.saveMessage(m)
    this.deps.emit({ type: 'message', message: m })
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue.push(job)
    this.pump()
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT && this.queue.length > 0) {
      const job = this.queue.shift()!
      this.active++
      void job()
        .catch((e: unknown) => console.error('[runner]', e))
        .finally(() => {
          this.active--
          this.pump()
          if (this.active === 0 && this.queue.length === 0) this.idleWaiters.splice(0).forEach((w) => w())
        })
    }
  }

  // Resolves when no run is active or queued (used by tests and shutdown).
  idle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
  }

  private async execute(agent: Agent, conv: Conversation): Promise<void> {
    const { db, emit, engines } = this.deps
    const settings = await this.deps.settings()
    const model = modelInfo(agent.modelId)
    const engineId: EngineId = model?.engine ?? 'claude'
    const engineLabel = `${ENGINES[engineId].label} · ${model?.label ?? agent.modelId}`

    const msg: Message = {
      id: randomUUID(),
      conversationId: conv.id,
      author: { kind: 'agent', id: agent.id },
      text: '',
      at: Date.now(),
      run: { status: 'working', steps: [{ id: 'turn-1', label: 'Pensando', detail: engineLabel, status: 'running' }] }
    }
    const started = Date.now()
    const save = (patch: Partial<Message> & { run?: Run }): void => {
      Object.assign(msg, patch)
      db.saveMessage(msg)
      emit({ type: 'message', message: { ...msg } })
    }
    const finishStep = (status: 'done' | 'error', label: string): Run['steps'] =>
      msg.run!.steps.map((s) => (s.status === 'running' ? { ...s, status, label, ms: Date.now() - started } : s))

    // Checked before anything is spawned: no tokens are spent past the limit.
    const used = db.usedThisMonth(agent.id)
    if (used >= agent.limit) {
      save({
        text: 'Parei: usei todo o meu limite de tokens deste mês. Dá pra aumentar na minha página.',
        run: { status: 'limit_reached', steps: [] }
      })
      return
    }

    const status = settings.engines[engineId]
    if (!status.installed || !status.loggedIn) {
      save({
        run: {
          status: 'failed',
          steps: [],
          error: `O ${ENGINES[engineId].label} ${status.installed ? 'não está logado' : 'não está instalado'}. Resolva em Configurações e mande de novo.`
        }
      })
      return
    }

    save({})

    const cwd = join(this.deps.workDir, agent.id)
    mkdirSync(cwd, { recursive: true })
    const peers = conv.members.filter((id) => id !== agent.id).map((id) => db.agent(id)).filter((a): a is Agent => !!a && !a.archived)
    const history = db.recentMessages(conv.id, HISTORY_LIMIT + 1).filter((m) => m.id !== msg.id)

    const control = { ctl: new AbortController() } as { ctl: AbortController; reason?: 'stopped' | 'limit' }
    this.controllers.set(msg.id, control)

    let pending = ''
    let timer: NodeJS.Timeout | null = null
    const flush = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      if (!pending) return
      emit({ type: 'delta', id: msg.id, text: pending })
      pending = ''
    }

    let turnTokens = 0
    let result: { text: string; usage: Omit<Receipt, 'model' | 'ms'> } | null = null
    let error: string | null = null

    try {
      const events = engines[engineId].run({
        model: agent.modelId,
        effort: agent.effort,
        system: systemPrompt({ agent, settings, conversation: conv, peers }),
        prompt: transcript({ agent, conversation: conv, messages: history, agents: db.agents(), me: settings.workspaceName }),
        cwd,
        signal: control.ctl.signal
      })
      for await (const ev of events) {
        if (ev.type === 'text') {
          msg.text += ev.delta
          pending += ev.delta
          timer ??= setTimeout(flush, DELTA_FLUSH_MS)
        } else if (ev.type === 'progress') {
          turnTokens = ev.tokens
          if (used + turnTokens > agent.limit && !control.reason) {
            control.reason = 'limit'
            control.ctl.abort()
          }
        } else if (ev.type === 'done') {
          result = ev
        } else if (ev.type === 'error') {
          error = ev.message
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      flush()
      this.controllers.delete(msg.id)
    }

    const ms = Date.now() - started
    const receipt: Receipt | undefined = result
      ? { model: agent.modelId, ms, ...result.usage }
      : turnTokens > 0
        ? { model: agent.modelId, ms, inputTokens: turnTokens, cacheReadTokens: 0, outputTokens: 0 } // partial: what the stream reported before it ended
        : undefined
    if (receipt) db.addReceipt({ ...receipt, messageId: msg.id, agentId: agent.id, engine: engineId, at: Date.now() })

    if (control.reason === 'stopped') {
      save({ run: { status: 'stopped', steps: finishStep('error', 'Parado'), receipt } })
    } else if (control.reason === 'limit') {
      save({
        text: msg.text ? `${msg.text} …` : '',
        run: { status: 'limit_reached', steps: finishStep('error', 'Parou no limite de tokens'), receipt, error: 'Cheguei no meu limite de tokens deste mês no meio da resposta.' }
      })
    } else if (result) {
      // The final text is authoritative; streamed deltas may miss formatting.
      save({ text: result.text || msg.text, run: { status: 'done', steps: finishStep('done', 'Respondeu'), receipt } })
    } else {
      save({ run: { status: 'failed', steps: finishStep('error', 'Falhou'), receipt, error: error ?? 'O motor terminou sem resposta.' } })
    }

    const updated = db.agent(agent.id)
    if (updated) emit({ type: 'agent', agent: updated })
  }
}
