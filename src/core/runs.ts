import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CoreEvent } from '../shared/rpc'
import { ENGINES, modelInfo, type Agent, type Conversation, type EngineId, type Message, type Receipt, type Run, type RunStatus, type Settings, type Step } from '../shared/types'
import { HISTORY_LIMIT, mentioned, systemPrompt, transcript } from './context'
import type { Db } from './db'
import type { Engine } from './engines/types'
import { textResult, type Gateway, type ToolDef } from './gateway'
import { route } from './router'

const MAX_CONCURRENT = 4
const MAX_MENTIONS = 3
const MAX_DEPTH = 3 // agent replies chained from one human message
const DELTA_FLUSH_MS = 40
const RETRYABLE: RunStatus[] = ['failed', 'stopped', 'interrupted', 'limit_reached']

export const ASK_USER: ToolDef = {
  name: 'ask_user',
  description: 'Faz uma pergunta curta ao usuário quando falta uma informação pra continuar. Depois de chamar, encerre a resposta: a resposta do usuário chega na próxima mensagem.',
  inputSchema: {
    type: 'object',
    properties: { question: { type: 'string', description: 'A pergunta, curta e direta.' } },
    required: ['question']
  }
}

export interface RunnerDeps {
  db: Db
  engines: Record<EngineId, Engine>
  settings: () => Promise<Settings> // resolves once engine detection is done
  emit: (e: CoreEvent) => void
  workDir: string // per-agent empty directories live here
  gateway?: Gateway // without it, agents get no tools at all
}

type Control = { ctl: AbortController; reason?: 'stopped' | 'limit' }

export class Runner {
  private queue: (() => Promise<void>)[] = []
  private active = 0
  private routing = 0
  private controllers = new Map<string, Control>()
  private idleWaiters: (() => void)[] = []

  constructor(private deps: RunnerDeps) {}

  // Saves the human message and decides who answers it: mentioned agents
  // first, then whoever asked a pending question, then the DM agent or the
  // only agent in the channel, and otherwise the router.
  async send(conversationId: string, text: string): Promise<void> {
    const { db, emit } = this.deps
    const conv = db.conversation(conversationId)
    const body = text.trim()
    if (!conv || !body) return

    const mine: Message = { id: randomUUID(), conversationId, author: { kind: 'me' }, text: body, at: Date.now() }
    db.saveMessage(mine)
    emit({ type: 'message', message: mine })

    const members = this.members(conv)
    let responders = mentioned(body, members).slice(0, MAX_MENTIONS)

    const asked = this.pendingQuestion(conv.id)
    if (asked) {
      this.update(asked, { run: { ...asked.run!, status: 'done' } })
      const asker = members.find((a) => asked.author.kind === 'agent' && a.id === asked.author.id)
      if (asker && responders.length === 0) responders = [asker]
    }

    if (responders.length === 0) {
      if (conv.kind === 'dm' || members.length === 1) responders = members
      else if (members.length > 1) {
        void this.routeAndRun(conv, members)
        return
      }
    }
    for (const agent of responders) this.enqueue(() => this.execute(agent, conv, { depth: 1 }))
  }

  stop(messageId: string): void {
    const c = this.controllers.get(messageId)
    if (!c) return
    c.reason = 'stopped'
    c.ctl.abort()
  }

  // Runs the same agent again in place of a reply that didn't finish.
  retry(messageId: string): void {
    const { db } = this.deps
    const msg = db.message(messageId)
    if (!msg?.run || msg.author.kind !== 'agent' || !RETRYABLE.includes(msg.run.status)) return
    const agent = db.agent(msg.author.id)
    const conv = db.conversation(msg.conversationId)
    if (!agent || !conv) return
    this.enqueue(() => this.execute(agent, conv, { depth: msg.run!.depth ?? 1, existing: msg }))
  }

  // Resolves when nothing is routing, running or queued (tests and shutdown).
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
  }

  private isIdle(): boolean {
    return this.active === 0 && this.queue.length === 0 && this.routing === 0
  }

  private checkIdle(): void {
    if (this.isIdle()) this.idleWaiters.splice(0).forEach((w) => w())
  }

  private members(conv: Conversation): Agent[] {
    return conv.members.map((id) => this.deps.db.agent(id)).filter((a): a is Agent => !!a && !a.archived)
  }

  private pendingQuestion(conversationId: string): Message | undefined {
    return this.deps.db
      .recentMessages(conversationId, 50)
      .reverse()
      .find((m) => m.run?.status === 'waiting_input')
  }

  private post(conversationId: string, text: string, run?: Run): Message {
    const m: Message = { id: randomUUID(), conversationId, author: { kind: 'system' }, text, at: Date.now(), run }
    this.deps.db.saveMessage(m)
    this.deps.emit({ type: 'message', message: m })
    return m
  }

  private update(m: Message, patch: Partial<Message>): void {
    Object.assign(m, patch)
    this.deps.db.saveMessage(m)
    this.deps.emit({ type: 'message', message: { ...m } })
  }

  private async routeAndRun(conv: Conversation, members: Agent[]): Promise<void> {
    const { db, engines } = this.deps
    this.routing++
    const note = this.post(conv.id, 'Escolhendo quem responde…', { status: 'working', steps: [] })
    const fail = (why: string): void =>
      this.update(note, { text: `Não consegui escolher quem responde (${why}). Mencione um agente com **@nome**.`, run: undefined })
    try {
      const settings = await this.deps.settings()
      const model = modelInfo(settings.routerModel) ?? modelInfo('haiku')!
      const status = settings.engines[model.engine]
      if (!status.installed || !status.loggedIn) return fail(`o ${ENGINES[model.engine].label} não está pronto`)

      const cwd = join(this.deps.workDir, '_router')
      mkdirSync(cwd, { recursive: true })
      const r = await route({ engine: engines[model.engine], model: model.id, messages: db.recentMessages(conv.id, 20), agents: members, me: settings.workspaceName, cwd })
      if (r.usage) db.addReceipt({ ...r.usage, model: model.id, ms: r.ms, messageId: note.id, agentId: 'router', engine: model.engine, at: Date.now() })
      if ('error' in r) return fail(r.error)

      const why = r.reason ? ` · ${r.reason}` : ''
      if (r.agents.length === 0) return this.update(note, { text: `Ninguém precisa responder${why}`, run: undefined })
      this.update(note, { text: `Chamei ${r.agents.map((a) => `**${a.name}**`).join(' e ')}${why}`, run: undefined })
      for (const agent of r.agents) this.enqueue(() => this.execute(agent, conv, { depth: 1 }))
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e))
    } finally {
      this.routing--
      this.checkIdle()
    }
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
          this.checkIdle()
        })
    }
  }

  private async execute(agent: Agent, conv: Conversation, opts: { depth: number; existing?: Message }): Promise<void> {
    const { db, emit, engines } = this.deps
    const settings = await this.deps.settings()
    agent = db.agent(agent.id) ?? agent // limits or instructions may have changed while queued
    const model = modelInfo(agent.modelId)
    const engineId: EngineId = model?.engine ?? 'claude'
    const engineLabel = `${ENGINES[engineId].label} · ${model?.label ?? agent.modelId}`

    const msg: Message = opts.existing ?? { id: randomUUID(), conversationId: conv.id, author: { kind: 'agent', id: agent.id }, text: '', at: Date.now() }
    const started = Date.now()
    let stepStarted = started
    const thinking = (): Step => ({ id: randomUUID(), label: 'Pensando', detail: engineLabel, status: 'running' })
    msg.text = ''
    msg.run = { status: 'working', depth: opts.depth, steps: [thinking()] }
    const save = (patch: Partial<Message> = {}): void => this.update(msg, patch)
    const closeThinking = (status: 'done' | 'error', label: string): Step[] =>
      msg.run!.steps.map((s) => (s.status === 'running' ? { ...s, status, label, ms: Date.now() - stepStarted } : s))

    // Checked before anything is spawned: no tokens are spent past the limit.
    const used = db.usedThisMonth(agent.id)
    if (used >= agent.limit) {
      save({
        text: 'Parei: usei todo o meu limite de tokens deste mês. Dá pra aumentar na minha página.',
        run: { status: 'limit_reached', depth: opts.depth, steps: [] }
      })
      return
    }

    const status = settings.engines[engineId]
    if (!status.installed || !status.loggedIn) {
      save({
        run: {
          status: 'failed',
          depth: opts.depth,
          steps: [],
          error: `O ${ENGINES[engineId].label} ${status.installed ? 'não está logado' : 'não está instalado'}. Resolva em Configurações e mande de novo.`
        }
      })
      return
    }

    save()

    const cwd = join(this.deps.workDir, agent.id)
    mkdirSync(cwd, { recursive: true })
    const members = this.members(conv)
    const peers = members.filter((a) => a.id !== agent.id)
    const history = db
      .recentMessages(conv.id, HISTORY_LIMIT + 40)
      .filter((m) => m.id !== msg.id && m.at <= msg.at)
      .slice(-HISTORY_LIMIT)

    const control: Control = { ctl: new AbortController() }
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

    // Tools for this turn, served by the gateway under a URL only this turn knows.
    let question: string | undefined
    const session = this.deps.gateway?.open({
      tools: [ASK_USER],
      call: async (name, args) => {
        if (name !== ASK_USER.name) return textResult(`Ferramenta desconhecida: ${name}`, true)
        const q = typeof args['question'] === 'string' ? args['question'].trim() : ''
        if (!q) return textResult('Faltou a pergunta.', true)
        if (question) return textResult('Você já fez uma pergunta nesta resposta. Encerre agora.', true)
        question = q
        flush() // keep streamed text and the full-message event in order
        msg.run = {
          ...msg.run!,
          steps: [...closeThinking('done', 'Pensou'), { id: randomUUID(), label: 'Perguntou a você', detail: q, status: 'done' }, thinking()]
        }
        stepStarted = Date.now()
        save()
        return textResult(`Pergunta enviada a ${settings.workspaceName}. Encerre sua resposta agora com no máximo uma frase, sem repetir a pergunta. A resposta chega na próxima mensagem.`)
      }
    })

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
        signal: control.ctl.signal,
        mcpUrl: session?.url
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
      session?.close()
      this.controllers.delete(msg.id)
    }

    const ms = Date.now() - started
    const receipt: Receipt | undefined = result
      ? { model: agent.modelId, ms, ...result.usage }
      : turnTokens > 0
        ? { model: agent.modelId, ms, inputTokens: turnTokens, cacheReadTokens: 0, outputTokens: 0 } // partial: what the stream reported before it ended
        : undefined
    if (receipt) db.addReceipt({ ...receipt, messageId: msg.id, agentId: agent.id, engine: engineId, at: Date.now() })

    const base = { depth: opts.depth, receipt, question }
    if (control.reason === 'stopped') {
      save({ run: { ...base, status: 'stopped', steps: closeThinking('error', 'Parado') } })
    } else if (control.reason === 'limit') {
      save({
        text: msg.text ? `${msg.text} …` : '',
        run: { ...base, status: 'limit_reached', steps: closeThinking('error', 'Parou no limite de tokens'), error: 'Cheguei no meu limite de tokens deste mês no meio da resposta.' }
      })
    } else if (result) {
      // Streamed text keeps every model call of the turn; the final result may hold only the last one.
      save({
        text: msg.text.trim() ? msg.text : result.text,
        run: { ...base, status: question ? 'waiting_input' : 'done', steps: closeThinking('done', 'Respondeu') }
      })
      if (!question) this.chain(agent, conv, msg, opts.depth)
    } else {
      save({ run: { ...base, status: 'failed', steps: closeThinking('error', 'Falhou'), error: error ?? 'O motor terminou sem resposta.' } })
    }

    const updated = db.agent(agent.id)
    if (updated) emit({ type: 'agent', agent: updated })
  }

  // An agent that mentions another agent of the conversation hands it the turn,
  // up to MAX_DEPTH replies in a row without a human message in between.
  private chain(agent: Agent, conv: Conversation, msg: Message, depth: number): void {
    const next = mentioned(msg.text, this.members(conv).filter((a) => a.id !== agent.id)).slice(0, MAX_MENTIONS)
    if (next.length === 0) return
    if (depth >= MAX_DEPTH) {
      this.post(conv.id, `Parei a conversa entre agentes aqui: foram ${MAX_DEPTH} respostas seguidas. Mande uma mensagem pra continuar.`)
      return
    }
    for (const a of next) this.enqueue(() => this.execute(a, conv, { depth: depth + 1 }))
  }
}
