// Memory, short and long term (spec §12). Short term: each conversation keeps
// a summary of what scrolled out of the window. Long term: notes about me (for
// every agent) or about an agent's own work. Both are plain rows the user can
// read, edit and forget; nothing lives inside the CLIs.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { CoreEvent } from '../shared/rpc'
import { ENGINES, modelInfo, SUMMARY_MAX_AFTER, SUMMARY_WINDOW, type Agent, type Conversation, type EngineId, type Memory, type MemoryScope, type Message, type Settings } from '../shared/types'
import type { Db } from './db'
import type { Engine } from './engines/types'
import type { ToolDef } from './gateway'

export const WINDOW = SUMMARY_WINDOW
export const MAX_AFTER = SUMMARY_MAX_AFTER
export const PROMPT_CAP = 40 // memories per scope in a prompt
const MAX_MEMORY_CHARS = 500

export const LEMBRAR: ToolDef = {
  name: 'lembrar',
  description:
    'Guarda uma memória durável: uma preferência, um padrão ou um fato que vai continuar valendo em outras conversas. Uma ideia curta por chamada. Não guarde o que só importa nesta conversa.',
  inputSchema: {
    type: 'object',
    properties: {
      texto: { type: 'string', description: 'A memória, numa frase curta, autossuficiente e na terceira pessoa (ex.: "Prefere PRs pequenos").' },
      sobre: { type: 'string', enum: ['usuario', 'agente'], description: '"usuario": sobre a pessoa com quem você fala (vale pra todos os agentes). "agente": sobre o seu trabalho (só você vê).' },
      substitui: { type: 'string', description: 'Id de uma memória que esta atualiza, quando algo mudou.' }
    },
    required: ['texto', 'sobre']
  }
}

export const MEMORY_SYSTEM = [
  'Você mantém a memória de um chat de trabalho entre uma pessoa e agentes de IA.',
  'Recebe o resumo atual da conversa, um trecho de mensagens numeradas que vai sair da janela, as memórias sobre a pessoa e as que ela mandou esquecer.',
  'Responda SOMENTE com JSON, sem texto em volta, no formato:',
  '{"summary": "...", "memories": [{"op": "add", "text": "...", "evidence": [1]}, {"op": "update", "id": "...", "text": "...", "evidence": [2]}, {"op": "confirm", "id": "..."}]}',
  '- "summary": o resumo novo, que junta o anterior e o trecho. Até 500 palavras, em português. Guarde decisões, pendências, números, nomes e o estado do trabalho; corte conversa fiada. Pode usar tópicos.',
  '- "memories": só o que vale fora desta conversa: preferências, jeito de trabalhar, padrões e fatos duráveis sobre a pessoa e os projetos dela. Lista vazia é o normal.',
  '  - "add" pra algo novo; "update" quando algo já lembrado mudou (use o id); "confirm" quando o trecho reforça uma memória que já existe.',
  '  - "evidence": os números das mensagens que sustentam. Só vale o que a PESSOA disse ou confirmou, nunca o que um agente supôs.',
  '  - Nunca recrie nada parecido com uma memória esquecida.',
  '  - Cada "text" é uma frase curta na terceira pessoa, autossuficiente.'
].join('\n')

type Op = { op: 'add'; text: string; evidence: number[] } | { op: 'update'; id: string; text: string; evidence: number[] } | { op: 'confirm'; id: string }

export function consolidationPrompt(opts: { summary?: string; messages: Message[]; me: string; agents: Agent[]; memories: Memory[]; forgotten: Memory[] }): string {
  const { summary, messages, me, agents, memories, forgotten } = opts
  const author = (m: Message): string =>
    m.author.kind === 'me' ? me : `${agents.find((a) => m.author.kind === 'agent' && a.id === m.author.id)?.name ?? 'agente'} · agente`
  return [
    'Resumo atual:',
    summary?.trim() || '(ainda não há)',
    '',
    'Trecho que vai sair da janela:',
    ...messages.map((m, i) => `(${i + 1}) [${author(m)}] ${m.text.trim().slice(0, 4000)}`),
    '',
    `Memórias sobre ${me}:`,
    ...(memories.length ? memories.map((m) => `- [${m.id}] ${m.text}`) : ['(nenhuma)']),
    '',
    `Esquecidas a pedido de ${me} (não recriar):`,
    ...(forgotten.length ? forgotten.map((m) => `- ${m.text}`) : ['(nenhuma)']),
    '',
    'Responda só com o JSON.'
  ].join('\n')
}

// Lenient like the router's: models sometimes wrap the JSON in a code fence.
export function parseConsolidation(text: string): { summary: string; ops: Op[] } | null {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  if (!json) return null
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return null
  }
  const { summary, memories } = (data ?? {}) as { summary?: unknown; memories?: unknown }
  if (typeof summary !== 'string' || !summary.trim()) return null
  const ops: Op[] = []
  for (const raw of Array.isArray(memories) ? memories : []) {
    const o = (raw ?? {}) as Record<string, unknown>
    const text = typeof o['text'] === 'string' ? o['text'].trim().slice(0, MAX_MEMORY_CHARS) : ''
    const id = typeof o['id'] === 'string' ? o['id'] : ''
    const evidence = Array.isArray(o['evidence']) ? o['evidence'].filter((n): n is number => Number.isInteger(n)) : []
    if (o['op'] === 'add' && text) ops.push({ op: 'add', text, evidence })
    else if (o['op'] === 'update' && id && text) ops.push({ op: 'update', id, text, evidence })
    else if (o['op'] === 'confirm' && id) ops.push({ op: 'confirm', id })
  }
  return { summary: summary.trim(), ops }
}

// For matching a new memory against forgotten and existing ones.
export const normalize = (t: string): string =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

export interface MemoryDeps {
  db: Db
  engines: Record<EngineId, Engine>
  settings: () => Promise<Settings>
  emit: (e: CoreEvent) => void
  workDir: string
}

export class Memories {
  private running = new Map<string, Promise<void>>()

  constructor(private deps: MemoryDeps) {}

  // ---------- reading ----------

  forPrompt(agent: Agent): { aboutMe: Memory[]; own: Memory[] } {
    const pick = (scope: MemoryScope): Memory[] =>
      this.deps.db
        .memories({ scope, state: 'active' })
        .sort((a, b) => b.confirmedAt - a.confirmedAt)
        .slice(0, PROMPT_CAP)
    return { aboutMe: pick('me'), own: pick(agent.id) }
  }

  // What a turn sees of the conversation: the summary and every message after it.
  window(conv: Conversation, before: Message): { summary?: string; messages: Message[] } {
    const until = conv.summaryUntil ?? 0
    const messages = this.deps.db
      .recentMessages(conv.id, MAX_AFTER + 40)
      .filter((m) => m.id !== before.id && m.at <= before.at && m.at > until)
      .slice(-MAX_AFTER)
    return { summary: conv.summary, messages }
  }

  // ---------- short term: consolidation ----------

  // Folds what is about to leave the window into the summary and extracts
  // memories about me from it. One at a time per conversation.
  consolidate(conversationId: string, force = false): Promise<void> {
    const current = this.running.get(conversationId)
    if (current) return current
    const p = this.doConsolidate(conversationId, force)
      .catch((e: unknown) => console.error('[memory]', e))
      .finally(() => this.running.delete(conversationId))
    this.running.set(conversationId, p)
    return p
  }

  async idle(): Promise<void> {
    while (this.running.size) await Promise.all(this.running.values())
  }

  private async doConsolidate(conversationId: string, force: boolean): Promise<void> {
    const { db, engines, emit } = this.deps
    const conv = db.conversation(conversationId)
    if (!conv) return
    const after = db.messagesAfter(conv.id, conv.summaryUntil ?? 0).filter((m) => m.author.kind !== 'system' && m.text.trim())
    if (!force && after.length <= MAX_AFTER) return
    const chunk = after.slice(0, Math.max(0, after.length - WINDOW))
    if (chunk.length === 0) return

    const settings = await this.deps.settings()
    const model = modelInfo(settings.memoryModel) ?? modelInfo('haiku')!
    const status = settings.engines[model.engine]
    if (!status.installed || !status.loggedIn) return console.log(`[memory] skipped: ${ENGINES[model.engine].label} not ready`)

    const cwd = join(this.deps.workDir, '_memory')
    mkdirSync(cwd, { recursive: true })
    const memories = db.memories({ scope: 'me', state: 'active' })
    const prompt = consolidationPrompt({
      summary: conv.summary,
      messages: chunk,
      me: settings.workspaceName,
      agents: db.agents(),
      memories,
      forgotten: db.memories({ scope: 'me', state: 'forgotten' }).slice(-50)
    })

    const started = Date.now()
    let text = ''
    let error: string | undefined
    for await (const ev of engines[model.engine].run({ model: model.id, effort: 'low', system: MEMORY_SYSTEM, prompt, cwd, signal: AbortSignal.timeout(120_000) })) {
      if (ev.type === 'text') text += ev.delta
      else if (ev.type === 'done') {
        text = ev.text || text
        db.addReceipt({ ...ev.usage, model: model.id, ms: Date.now() - started, messageId: conv.id, agentId: 'memory', engine: model.engine, at: Date.now() })
      } else if (ev.type === 'error') error = ev.message
    }
    const parsed = error ? null : parseConsolidation(text)
    if (!parsed) return console.log(`[memory] consolidation failed: ${error ?? 'resposta fora do formato'}`)

    db.setSummary(conv.id, parsed.summary, chunk.at(-1)!.at)
    emit({ type: 'conversation', conversation: db.conversation(conv.id)! })
    if (settings.memoryLearning !== 'off') this.applyExtraction(parsed.ops, chunk, conv.id, settings.memoryLearning)
  }

  private applyExtraction(ops: Op[], chunk: Message[], conversationId: string, learning: 'approve' | 'auto'): void {
    const known = new Map(this.deps.db.memories({ scope: 'me', state: 'active' }).map((m) => [m.id, m]))
    // Only what I said counts as evidence about me (an agent's guess never does).
    const evidence = (nums: number[]): string[] =>
      nums
        .map((n) => chunk[n - 1])
        .filter((m): m is Message => m?.author.kind === 'me')
        .map((m) => m.id)
    for (const op of ops) {
      if (op.op === 'confirm') {
        const m = known.get(op.id)
        if (m) this.save({ ...m, confirmedAt: Date.now() })
        continue
      }
      const ids = evidence(op.evidence)
      if (ids.length === 0) continue
      const replaces = op.op === 'update' ? known.get(op.id) : undefined
      if (op.op === 'update' && !replaces) continue
      this.propose({ scope: 'me', text: op.text, origin: 'extraction', conversationId, messageIds: ids, replaces: replaces?.id, active: learning === 'auto' })
    }
  }

  // ---------- long term ----------

  // The one way memories come in, so every path gets the same checks.
  private propose(p: { scope: MemoryScope; text: string; origin: Memory['origin']; agentId?: string; conversationId?: string; messageIds: string[]; replaces?: string; active: boolean }):
    | { kind: 'forgotten' }
    | { kind: 'duplicate'; memory: Memory }
    | { kind: 'saved'; memory: Memory } {
    const { db } = this.deps
    const key = normalize(p.text)
    if (db.memories({ scope: p.scope, state: 'forgotten' }).some((m) => normalize(m.text) === key)) return { kind: 'forgotten' }
    const same = db.memories({ scope: p.scope }).find((m) => (m.state === 'active' || m.state === 'pending') && normalize(m.text) === key)
    if (same) {
      if (same.state === 'active') this.save({ ...same, confirmedAt: Date.now() })
      return { kind: 'duplicate', memory: same }
    }
    const now = Date.now()
    const memory: Memory = {
      id: this.newId(),
      scope: p.scope,
      text: p.text,
      state: p.active ? 'active' : 'pending',
      origin: p.origin,
      agentId: p.agentId,
      conversationId: p.conversationId,
      messageIds: p.messageIds,
      replaces: p.replaces,
      createdAt: now,
      confirmedAt: now
    }
    this.save(memory)
    if (p.active) this.archiveReplaced(memory)
    return { kind: 'saved', memory }
  }

  // Called by the runner when an agent uses `lembrar`.
  remember(agent: Agent, conv: Conversation, args: Record<string, unknown>): { memory?: Memory; reply: string; label?: string; error?: boolean } {
    const text = typeof args['texto'] === 'string' ? args['texto'].trim() : ''
    if (!text) return { reply: 'Faltou o texto da memória.', error: true }
    if (text.length > MAX_MEMORY_CHARS) return { reply: `Memória longa demais: use até ${MAX_MEMORY_CHARS} caracteres, uma ideia só.`, error: true }
    const scope: MemoryScope = args['sobre'] === 'agente' ? agent.id : 'me'
    let replaces: string | undefined
    if (typeof args['substitui'] === 'string' && args['substitui'].trim()) {
      const old = this.deps.db.memory(args['substitui'].trim())
      if (!old || old.state !== 'active' || (old.scope !== 'me' && old.scope !== agent.id)) return { reply: `Não achei a memória ${args['substitui']} pra substituir.`, error: true }
      if (old.scope !== scope) return { reply: `A memória ${old.id} é de outro escopo; use "sobre" igual ao dela.`, error: true }
      replaces = old.id
    }
    const lastMine = this.deps.db
      .recentMessages(conv.id, 20)
      .reverse()
      .find((m) => m.author.kind === 'me')
    const active = agent.memory === 'auto'
    const r = this.propose({ scope, text, origin: 'agent', agentId: agent.id, conversationId: conv.id, messageIds: lastMine ? [lastMine.id] : [], replaces, active })
    if (r.kind === 'forgotten') return { reply: 'Isso foi esquecido a pedido do usuário. Não guarde de novo nem mencione.' }
    if (r.kind === 'duplicate') return { reply: 'Isso já está na memória.' }
    return active
      ? { memory: r.memory, label: 'Guardou na memória', reply: 'Guardado. Siga com a resposta sem anunciar que guardou.' }
      : { memory: r.memory, label: 'Quer guardar na memória', reply: 'Virou um pedido: o usuário decide se guarda. Siga com a resposta.' }
  }

  add(scope: MemoryScope, text: string): void {
    const clean = text.trim().slice(0, MAX_MEMORY_CHARS)
    if (clean) this.propose({ scope, text: clean, origin: 'me', messageIds: [], active: true })
  }

  edit(id: string, text: string): void {
    const m = this.deps.db.memory(id)
    const clean = text.trim().slice(0, MAX_MEMORY_CHARS)
    if (m && clean && (m.state === 'active' || m.state === 'pending')) this.save({ ...m, text: clean, confirmedAt: Date.now() })
  }

  confirm(id: string): void {
    const m = this.deps.db.memory(id)
    if (m?.state === 'active') this.save({ ...m, confirmedAt: Date.now() })
  }

  decide(id: string, accept: boolean): void {
    const m = this.deps.db.memory(id)
    if (m?.state !== 'pending') return
    if (!accept) return this.remove(id) // a discarded suggestion was never a memory
    const memory: Memory = { ...m, state: 'active', confirmedAt: Date.now() }
    this.save(memory)
    this.archiveReplaced(memory)
  }

  // Keeps the text as a record, so it is not learned again.
  forget(id: string, reason?: string): void {
    const m = this.deps.db.memory(id)
    if (m && m.state !== 'forgotten') this.save({ ...m, state: 'forgotten', reason })
  }

  purge(id: string): void {
    if (this.deps.db.memory(id)?.state === 'forgotten') this.remove(id)
  }

  editSummary(conversationId: string, text: string): void {
    this.deps.db.setSummary(conversationId, text.trim())
    const conv = this.deps.db.conversation(conversationId)
    if (conv) this.deps.emit({ type: 'conversation', conversation: conv })
  }

  private archiveReplaced(m: Memory): void {
    const old = m.replaces ? this.deps.db.memory(m.replaces) : undefined
    if (old?.state === 'active') this.save({ ...old, state: 'archived' })
  }

  private save(m: Memory): void {
    this.deps.db.saveMemory(m)
    this.deps.emit({ type: 'memory', memory: m })
  }

  private remove(id: string): void {
    this.deps.db.deleteMemory(id)
    this.deps.emit({ type: 'memory_removed', id })
  }

  // Short ids: the model reads and writes them back (`substitui`, `update`).
  private newId(): string {
    for (;;) {
      const id = randomBytes(4).toString('hex')
      if (!this.deps.db.memory(id)) return id
    }
  }
}
