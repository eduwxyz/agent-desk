// UI-only store with sample data. The agent "runs" here are simulated so the
// interface can be exercised before the real core (SQLite + engines + MCP) exists.
import { useRef, useSyncExternalStore } from 'react'

export type AgentColor = 'sky' | 'indigo' | 'violet' | 'rose' | 'amber' | 'green' | 'teal' | 'graphite'
export type GrantLevel = 'none' | 'read' | 'read_write'
export type ToolClass = 'read' | 'write' | 'sensitive'

export type EngineId = 'claude' | 'codex'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'

export interface Model {
  id: string // the value passed to the CLI's --model
  engine: EngineId
  label: string
  hint: string
}

export interface EngineStatus {
  installed: boolean
  path?: string
  version?: string
  loggedIn: boolean
  account?: string // how the CLI is logged in, e.g. "Claude Max"
}

export interface Agent {
  id: string
  name: string
  handle: string
  role: string
  color: AgentColor
  instructions: string
  modelId: string
  effort: Effort
  limit: number // tokens per month
  used: number
  grants: Record<string, GrantLevel>
  archived: boolean
}

export interface Connector {
  id: string
  name: string
  kind: 'remote' | 'stdio'
  address: string
  status: 'connected' | 'needs_reconnect'
  tools: { name: string; cls: ToolClass; enabled: boolean; highRisk?: boolean }[]
}

export interface Conversation {
  id: string
  kind: 'channel' | 'dm'
  name: string // channel name, or agent id for a DM
  topic?: string
  members: string[] // agent ids
  unread?: number
}

export type StepStatus = 'running' | 'done' | 'error'
export interface Step {
  id: string
  label: string
  detail?: string
  status: StepStatus
  ms?: number
}

export interface Receipt {
  model: string
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  ms: number
  apiCostUsd?: number // what the same usage would cost on the API, when the CLI reports it
}

export interface Approval {
  id: string
  agentId: string
  conversationId: string
  title: string
  tool: string
  connector: string
  args: Record<string, string | number>
  why: string
  highRisk: boolean
  state: 'pending' | 'approved' | 'refused' | 'expired'
  reason?: string
  decidedAt?: number
  createdAt: number
}

export interface Message {
  id: string
  conversationId: string
  author: { kind: 'me' } | { kind: 'agent'; id: string } | { kind: 'system' }
  text: string
  at: number
  run?: {
    status: 'working' | 'waiting_approval' | 'done' | 'stopped' | 'limit_reached'
    steps: Step[]
    receipt?: Receipt
    approvalId?: string
  }
}

export interface Settings {
  workspaceName: string
  context: string
  engines: Record<EngineId, EngineStatus>
  routerModel: string
  defaultLimit: number
  theme: 'system' | 'light' | 'dark'
}

export type View =
  | { kind: 'conversation'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'new-agent' }
  | { kind: 'approvals' }
  | { kind: 'usage' }
  | { kind: 'connectors' }
  | { kind: 'settings' }

export interface State {
  view: View
  me: { name: string; initials: string }
  settings: Settings
  models: Model[]
  agents: Agent[]
  connectors: Connector[]
  conversations: Conversation[]
  messages: Message[]
  approvals: Approval[]
}

export const ENGINES: Record<EngineId, { label: string; cli: string; login: string }> = {
  claude: { label: 'Claude Code', cli: 'claude', login: 'claude' },
  codex: { label: 'Codex', cli: 'codex', login: 'codex login' }
}

export const MODELS: Model[] = [
  { id: 'sonnet', engine: 'claude', label: 'Sonnet', hint: 'Bom pra maioria' },
  { id: 'opus', engine: 'claude', label: 'Opus', hint: 'Tarefas longas e difíceis' },
  { id: 'haiku', engine: 'claude', label: 'Haiku', hint: 'Rápido, gasta pouco do plano' },
  { id: 'gpt-5.6-luna', engine: 'codex', label: 'GPT-5.6 Luna', hint: 'Bom pra maioria' },
  { id: 'gpt-5.6-terra', engine: 'codex', label: 'GPT-5.6 Terra', hint: 'Problemas difíceis' },
  { id: 'gpt-5.6-sol', engine: 'codex', label: 'GPT-5.6 Sol', hint: 'O mais capaz, mais lento' }
]

export const EFFORTS: { id: Effort; label: string }[] = [
  { id: 'low', label: 'Baixo' },
  { id: 'medium', label: 'Médio' },
  { id: 'high', label: 'Alto' },
  { id: 'xhigh', label: 'Máximo' }
]

const now = Date.now()
const min = 60_000

const initial: State = {
  view: { kind: 'conversation', id: 'c-eng' },
  me: { name: 'Eduardo', initials: 'ED' },
  settings: {
    workspaceName: 'Eduardo',
    context:
      'Sou engenheiro de IA. Trabalho com agentes, evals e produtos em TypeScript e Elixir. Respostas em português, diretas. Nunca faça deploy sem me perguntar.',
    engines: {
      claude: { installed: true, path: '/opt/homebrew/bin/claude', version: '2.1.286', loggedIn: true, account: 'Assinatura Claude' },
      codex: { installed: true, path: '~/.local/bin/codex', version: '0.153.4', loggedIn: true, account: 'Assinatura ChatGPT' }
    },
    routerModel: 'haiku',
    defaultLimit: 2_000_000,
    theme: 'system'
  },
  models: MODELS,
  agents: [
    {
      id: 'a-lia',
      name: 'Lia',
      handle: 'lia',
      role: 'Engenharia',
      color: 'sky',
      instructions:
        'Codifica em branches e abre PRs pequenos, com teste pra cada correção. Antes de mexer em algo grande, descreve o plano no canal e espera um ok. Nunca faz merge sozinha.',
      modelId: 'sonnet',
      effort: 'high',
      limit: 3_000_000,
      used: 1_240_000,
      grants: { github: 'read_write', sentry: 'read' },
      archived: false
    },
    {
      id: 'a-theo',
      name: 'Theo',
      handle: 'theo',
      role: 'Dados',
      color: 'violet',
      instructions: 'Responde perguntas sobre métricas consultando o banco em modo leitura. Sempre mostra a query que usou.',
      modelId: 'gpt-5.6-luna',
      effort: 'medium',
      limit: 1_000_000,
      used: 862_000,
      grants: { postgres: 'read' },
      archived: false
    },
    {
      id: 'a-nina',
      name: 'Nina',
      handle: 'nina',
      role: 'Conteúdo',
      color: 'rose',
      instructions: 'Escreve posts e anúncios no meu tom: leve, curto, sem jargão. Mostra o rascunho antes de publicar qualquer coisa.',
      modelId: 'opus',
      effort: 'medium',
      limit: 2_000_000,
      used: 214_000,
      grants: { linear: 'read' },
      archived: false
    }
  ],
  connectors: [
    {
      id: 'github',
      name: 'GitHub',
      kind: 'remote',
      address: 'https://api.githubcopilot.com/mcp/',
      status: 'connected',
      tools: [
        { name: 'search_code', cls: 'read', enabled: true },
        { name: 'get_pull_request', cls: 'read', enabled: true },
        { name: 'list_issues', cls: 'read', enabled: true },
        { name: 'create_branch', cls: 'write', enabled: true },
        { name: 'create_pull_request', cls: 'write', enabled: true },
        { name: 'merge_pull_request', cls: 'sensitive', enabled: true, highRisk: true },
        { name: 'run_workflow', cls: 'sensitive', enabled: true, highRisk: true }
      ]
    },
    {
      id: 'sentry',
      name: 'Sentry',
      kind: 'remote',
      address: 'https://mcp.sentry.dev/mcp',
      status: 'connected',
      tools: [
        { name: 'search_issues', cls: 'read', enabled: true },
        { name: 'get_issue_details', cls: 'read', enabled: true },
        { name: 'update_issue', cls: 'write', enabled: true }
      ]
    },
    {
      id: 'linear',
      name: 'Linear',
      kind: 'remote',
      address: 'https://mcp.linear.app/mcp',
      status: 'needs_reconnect',
      tools: [
        { name: 'list_issues', cls: 'read', enabled: true },
        { name: 'create_issue', cls: 'write', enabled: true }
      ]
    },
    {
      id: 'postgres',
      name: 'Postgres (métricas)',
      kind: 'stdio',
      address: 'npx @modelcontextprotocol/server-postgres postgres://localhost/metrics',
      status: 'connected',
      tools: [{ name: 'query', cls: 'read', enabled: true }]
    }
  ],
  conversations: [
    { id: 'c-eng', kind: 'channel', name: 'engenharia', topic: 'Bugs, PRs e deploys', members: ['a-lia', 'a-theo'] },
    { id: 'c-data', kind: 'channel', name: 'dados', topic: 'Métricas e relatórios', members: ['a-theo'], unread: 2 },
    { id: 'c-content', kind: 'channel', name: 'conteudo', topic: 'Posts, anúncios e newsletter', members: ['a-nina'] },
    { id: 'd-lia', kind: 'dm', name: 'a-lia', members: ['a-lia'] },
    { id: 'd-nina', kind: 'dm', name: 'a-nina', members: ['a-nina'] }
  ],
  messages: [
    {
      id: 'm1',
      conversationId: 'c-eng',
      author: { kind: 'me' },
      text: '@lia o checkout está dando erro 500 desde o deploy das 14h. Consegue olhar?',
      at: now - 18 * min
    },
    {
      id: 'm2',
      conversationId: 'c-eng',
      author: { kind: 'agent', id: 'a-lia' },
      text:
        'Achei. O PR #212 renomeou o campo `amount_cents` para `amount`, e o checkout ainda manda o nome antigo.\n\nAbri o **PR #213**, que volta a enviar `amount_cents`. Os testes de pagamento passaram. Pra mergear, preciso da sua aprovação.',
      at: now - 17 * min,
      run: {
        status: 'waiting_approval',
        approvalId: 'ap1',
        steps: [
          { id: 's1', label: 'Leu 38 eventos de erro', detail: 'sentry · search_issues', status: 'done', ms: 2100 },
          { id: 's2', label: 'Comparou o diff do PR #212', detail: 'github · get_pull_request', status: 'done', ms: 1400 },
          { id: 's3', label: 'Abriu o PR #213', detail: 'github · create_pull_request', status: 'done', ms: 3200 },
          { id: 's4', label: 'Pediu aprovação para merge', detail: 'github · merge_pull_request', status: 'running' }
        ],
        receipt: { model: 'sonnet', inputTokens: 18420, cacheReadTokens: 12880, outputTokens: 1630, ms: 41_000, apiCostUsd: 0.0558 }
      }
    },
    {
      id: 'm3',
      conversationId: 'c-data',
      author: { kind: 'system' },
      text: 'Rotina **Relatório semanal** · toda segunda às 9h',
      at: now - 3 * 60 * min
    },
    {
      id: 'm4',
      conversationId: 'c-data',
      author: { kind: 'agent', id: 'a-theo' },
      text:
        'Bom dia. Resumo da semana:\n\n| Métrica | Semana | Variação |\n|---|---|---|\n| Receita | R$ 184,2 mil | +8,2% |\n| Churn | 2,1% | −0,4 p.p. |\n| Contas novas | 214 | +14 |\n\nQuase todo o ganho veio da página de preços nova.',
      at: now - 3 * 60 * min + 18_000,
      run: {
        status: 'done',
        steps: [
          { id: 's1', label: 'Consultou o banco de métricas', detail: 'postgres · query (leitura)', status: 'done', ms: 900 },
          { id: 's2', label: 'Comparou com a semana anterior', status: 'done', ms: 300 }
        ],
        receipt: { model: 'gpt-5.6-luna', inputTokens: 6210, cacheReadTokens: 4100, outputTokens: 410, ms: 18_000 }
      }
    },
    {
      id: 'm5',
      conversationId: 'd-lia',
      author: { kind: 'me' },
      text: 'Me lembra o que ficou pendente no PR de pagamentos?',
      at: now - 26 * 60 * min
    },
    {
      id: 'm6',
      conversationId: 'd-lia',
      author: { kind: 'agent', id: 'a-lia' },
      text: 'Faltam dois pontos: o teste de reembolso parcial e revisar o nome da migration. O resto está aprovado.',
      at: now - 26 * 60 * min + 9000,
      run: {
        status: 'done',
        steps: [],
        receipt: { model: 'sonnet', inputTokens: 3110, cacheReadTokens: 2400, outputTokens: 96, ms: 4100, apiCostUsd: 0.0025 }
      }
    }
  ],
  approvals: [
    {
      id: 'ap1',
      agentId: 'a-lia',
      conversationId: 'c-eng',
      title: 'Mergear o PR #213 em acme/checkout',
      tool: 'merge_pull_request',
      connector: 'github',
      args: { repo: 'acme/checkout', pull_number: 213, merge_method: 'squash' },
      why: 'Corrige o erro 500 do checkout. Os testes de pagamento passaram.',
      highRisk: true,
      state: 'pending',
      createdAt: now - 17 * min
    }
  ]
}

// ---------- store plumbing ----------

let state: State = initial
const listeners = new Set<() => void>()

function set(update: (s: State) => State): void {
  state = update(state)
  listeners.forEach((l) => l())
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

// Selectors may build new arrays (filter/map); the snapshot is cached and kept
// referentially stable while the result is shallow-equal, so React doesn't loop.
export function useStore<T>(select: (s: State) => T): T {
  const cache = useRef<{ state: State; select: (s: State) => T; value: T } | null>(null)
  const getSnapshot = (): T => {
    const c = cache.current
    if (c && c.state === state && c.select === select) return c.value
    const next = select(state)
    const value = c && shallowEqual(c.value, next) ? c.value : next
    cache.current = { state, select, value }
    return value
  }
  return useSyncExternalStore(subscribe, getSnapshot)
}

export const getState = (): State => state

let seq = 0
const uid = (p: string): string => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`

// ---------- selectors ----------

export const agentById = (s: State, id: string): Agent | undefined => s.agents.find((a) => a.id === id)
export const modelById = (s: State, id: string): Model | undefined => s.models.find((m) => m.id === id)
export const pendingApprovals = (s: State): Approval[] => s.approvals.filter((a) => a.state === 'pending')

export function conversationTitle(s: State, c: Conversation): string {
  if (c.kind === 'channel') return c.name
  return agentById(s, c.name)?.name ?? 'Agente'
}

// ---------- actions ----------

export const navigate = (view: View): void =>
  set((s) => ({
    ...s,
    view,
    conversations:
      view.kind === 'conversation' ? s.conversations.map((c) => (c.id === view.id ? { ...c, unread: 0 } : c)) : s.conversations
  }))

export const updateSettings = (patch: Partial<Settings>): void => set((s) => ({ ...s, settings: { ...s.settings, ...patch } }))

export function saveAgent(agent: Agent): void {
  set((s) => {
    const exists = s.agents.some((a) => a.id === agent.id)
    return { ...s, agents: exists ? s.agents.map((a) => (a.id === agent.id ? agent : a)) : [...s.agents, agent] }
  })
}

export function setAgentChannels(agentId: string, channelIds: string[]): void {
  set((s) => ({
    ...s,
    conversations: s.conversations.map((c) => {
      if (c.kind !== 'channel') return c
      const has = c.members.includes(agentId)
      const want = channelIds.includes(c.id)
      if (has === want) return c
      return { ...c, members: want ? [...c.members, agentId] : c.members.filter((m) => m !== agentId) }
    })
  }))
}

export function newAgentDraft(): Agent {
  return {
    id: uid('a'),
    name: '',
    handle: '',
    role: '',
    color: 'teal',
    instructions: '',
    modelId: 'sonnet',
    effort: 'high',
    limit: state.settings.defaultLimit,
    used: 0,
    grants: {},
    archived: false
  }
}

export function createChannel(name: string): string {
  const id = uid('c')
  set((s) => ({ ...s, conversations: [...s.conversations, { id, kind: 'channel', name, members: [] }] }))
  return id
}

export function openDm(agentId: string): void {
  const existing = state.conversations.find((c) => c.kind === 'dm' && c.name === agentId)
  if (existing) return navigate({ kind: 'conversation', id: existing.id })
  const id = uid('d')
  set((s) => ({ ...s, conversations: [...s.conversations, { id, kind: 'dm', name: agentId, members: [agentId] }] }))
  navigate({ kind: 'conversation', id })
}

export function setGrant(agentId: string, connectorId: string, level: GrantLevel): void {
  set((s) => ({
    ...s,
    agents: s.agents.map((a) => (a.id === agentId ? { ...a, grants: { ...a.grants, [connectorId]: level } } : a))
  }))
}

export function setToolClass(connectorId: string, toolName: string, patch: Partial<Connector['tools'][number]>): void {
  set((s) => ({
    ...s,
    connectors: s.connectors.map((c) =>
      c.id === connectorId ? { ...c, tools: c.tools.map((t) => (t.name === toolName ? { ...t, ...patch } : t)) } : c
    )
  }))
}

function patchMessage(id: string, patch: (m: Message) => Message): void {
  set((s) => ({ ...s, messages: s.messages.map((m) => (m.id === id ? patch(m) : m)) }))
}

function addMessage(m: Message): void {
  set((s) => ({ ...s, messages: [...s.messages, m] }))
}

// ---------- simulated runs ----------

const running = new Map<string, { cancelled: boolean }>()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function stopRun(messageId: string): void {
  const r = running.get(messageId)
  if (r) r.cancelled = true
}

export function sendMessage(conversationId: string, text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  addMessage({ id: uid('m'), conversationId, author: { kind: 'me' }, text: trimmed, at: Date.now() })

  const conv = state.conversations.find((c) => c.id === conversationId)
  if (!conv) return
  const members = conv.members.map((id) => agentById(state, id)).filter((a): a is Agent => !!a && !a.archived)

  let responders: Agent[]
  let routed = false
  if (conv.kind === 'dm') {
    responders = members
  } else {
    const mentioned = members.filter((a) => new RegExp(`@${a.handle}\\b`, 'i').test(trimmed))
    if (mentioned.length > 0) {
      responders = mentioned.slice(0, 3)
    } else {
      routed = true
      responders = routeByKeywords(trimmed, members)
    }
  }

  if (routed) {
    addMessage({
      id: uid('m'),
      conversationId,
      author: { kind: 'system' },
      text:
        responders.length > 0
          ? `Router chamou ${responders.map((a) => `**${a.name}**`).join(' e ')}`
          : 'Router: ninguém precisa responder a essa mensagem',
      at: Date.now()
    })
  }

  responders.forEach((a, i) => void simulateRun(conversationId, a, trimmed, i * 700))
}

function routeByKeywords(text: string, members: Agent[]): Agent[] {
  const t = text.toLowerCase()
  const rules: [RegExp, string][] = [
    [/erro|bug|pr\b|deploy|código|teste|build/, 'Engenharia'],
    [/métrica|receita|churn|dados|relatório|query|quantos/, 'Dados'],
    [/post|anúncio|texto|linkedin|newsletter|escrev/, 'Conteúdo']
  ]
  const roles = rules.filter(([re]) => re.test(t)).map(([, role]) => role)
  return members.filter((a) => roles.includes(a.role)).slice(0, 2)
}

const CANNED: Record<string, string> = {
  Engenharia:
    'Olhei rapidinho. Isso é uma simulação da interface, então ainda não li o repositório de verdade. Quando o núcleo estiver ligado, eu investigo com o GitHub e o Sentry e respondo aqui com o que encontrei.',
  Dados:
    'Esta é uma resposta simulada. Com o núcleo ligado, eu consulto o banco de métricas em modo leitura e mostro a query que usei.',
  Conteúdo:
    'Rascunho simulado: “Agora seus agentes trabalham onde a conversa acontece.” Quando o núcleo estiver ligado, eu escrevo de verdade, no seu tom.'
}

async function simulateRun(conversationId: string, agent: Agent, prompt: string, delay: number): Promise<void> {
  await sleep(delay)
  const model = modelById(state, agent.modelId)
  const engineDetail = model ? `${ENGINES[model.engine].label} · ${model.label}` : undefined
  const msgId = uid('m')
  const ctl = { cancelled: false }
  running.set(msgId, ctl)
  const started = Date.now()

  // The usage limit is checked before the turn: the real core never spawns the CLI, the mock mirrors it.
  if (agent.used >= agent.limit) {
    addMessage({
      id: msgId,
      conversationId,
      author: { kind: 'agent', id: agent.id },
      text: 'Parei: usei todo o meu limite de tokens deste mês. Peça pra aumentar na minha página.',
      at: Date.now(),
      run: { status: 'limit_reached', steps: [] }
    })
    return
  }

  addMessage({
    id: msgId,
    conversationId,
    author: { kind: 'agent', id: agent.id },
    text: '',
    at: Date.now(),
    run: { status: 'working', steps: [{ id: 's1', label: 'Lendo a conversa', status: 'running' }] }
  })

  await sleep(900)
  if (ctl.cancelled) return finishStopped(msgId)
  patchMessage(msgId, (m) => ({
    ...m,
    run: { ...m.run!, steps: [{ id: 's1', label: 'Leu as últimas 30 mensagens', detail: engineDetail, status: 'done', ms: 880 }] }
  }))

  const reply = CANNED[agent.role] ?? `Recebi: “${prompt.slice(0, 80)}”. Esta é uma resposta simulada da interface.`
  let shown = ''
  for (const word of reply.split(/(\s+)/)) {
    if (ctl.cancelled) return finishStopped(msgId)
    shown += word
    patchMessage(msgId, (m) => ({ ...m, text: shown }))
    await sleep(28)
  }

  const inputTokens = 2800 + Math.round(Math.random() * 1500)
  const cacheReadTokens = Math.round(inputTokens * 0.7)
  const outputTokens = Math.round(reply.length / 3.6)
  const modelId = model?.id ?? MODELS[0]!.id
  // Only Claude Code reports an API-equivalent cost; this is a rough stand-in.
  const apiCostUsd = model?.engine === 'claude' ? (inputTokens * 0.4 + outputTokens * 10) / 1_000_000 : undefined

  patchMessage(msgId, (m) => ({
    ...m,
    run: {
      ...m.run!,
      status: 'done',
      receipt: { model: modelId, inputTokens, cacheReadTokens, outputTokens, ms: Date.now() - started, apiCostUsd }
    }
  }))
  set((s) => ({ ...s, agents: s.agents.map((a) => (a.id === agent.id ? { ...a, used: a.used + inputTokens + outputTokens } : a)) }))
  running.delete(msgId)
}

function finishStopped(msgId: string): void {
  running.delete(msgId)
  patchMessage(msgId, (m) => ({
    ...m,
    text: m.text ? `${m.text} …` : '',
    run: { ...m.run!, status: 'stopped', steps: m.run!.steps.map((st) => (st.status === 'running' ? { ...st, status: 'error' } : st)) }
  }))
}

export function decideApproval(id: string, decision: 'approved' | 'refused', reason?: string): void {
  const ap = state.approvals.find((a) => a.id === id)
  if (!ap || ap.state !== 'pending') return // the first decision wins
  set((s) => ({
    ...s,
    approvals: s.approvals.map((a) => (a.id === id ? { ...a, state: decision, reason, decidedAt: Date.now() } : a))
  }))

  const msg = state.messages.find((m) => m.run?.approvalId === id)
  if (msg) {
    patchMessage(msg.id, (m) => ({
      ...m,
      run: {
        ...m.run!,
        status: 'done',
        steps: m.run!.steps.map((st) =>
          st.status === 'running'
            ? { ...st, status: decision === 'approved' ? 'done' : 'error', label: decision === 'approved' ? 'Merge aprovado' : 'Merge recusado' }
            : st
        )
      }
    }))
  }

  void (async () => {
    await sleep(1200)
    addMessage({
      id: uid('m'),
      conversationId: ap.conversationId,
      author: { kind: 'agent', id: ap.agentId },
      text:
        decision === 'approved'
          ? 'Merge feito. O checkout voltou: nenhum erro nos últimos 2 minutos.'
          : `Entendido, não mexi em nada.${reason ? ` Sobre “${reason}”: ajusto o plano e te mostro antes de pedir de novo.` : ''}`,
      at: Date.now(),
      run: {
        status: 'done',
        steps:
          decision === 'approved'
            ? [
                { id: 's1', label: 'Mergeou o PR #213', detail: 'github · merge_pull_request', status: 'done', ms: 2300 },
                { id: 's2', label: 'Conferiu os erros no Sentry', detail: 'sentry · search_issues', status: 'done', ms: 1700 }
              ]
            : [],
        receipt: { model: 'sonnet', inputTokens: 4120, cacheReadTokens: 3600, outputTokens: 120, ms: 5200, apiCostUsd: 0.0036 }
      }
    })
  })()
}
