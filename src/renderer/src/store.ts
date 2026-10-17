// Renderer state. Agents, conversations, messages and settings come from the
// core and are kept in sync by its events; actions go to the core over RPC.
// Connectors and approvals are still sample data until the gateway exists (M3).
import { useRef, useSyncExternalStore } from 'react'
import type { CoreEvent } from '../../shared/rpc'
import { MODELS, type Agent, type Conversation, type GrantLevel, type Message, type Model, type Settings, type ToolClass } from '../../shared/types'
import { call, connect } from './rpc'

export * from '../../shared/types'

export interface Connector {
  id: string
  name: string
  kind: 'remote' | 'stdio'
  address: string
  status: 'connected' | 'needs_reconnect'
  tools: { name: string; cls: ToolClass; enabled: boolean; highRisk?: boolean }[]
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

export type View =
  | { kind: 'conversation'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'new-agent' }
  | { kind: 'approvals' }
  | { kind: 'usage' }
  | { kind: 'connectors' }
  | { kind: 'settings' }

export interface State {
  ready: boolean
  view: View | null
  me: { name: string; initials: string }
  settings: Settings
  models: Model[]
  agents: Agent[]
  connectors: Connector[]
  conversations: Conversation[]
  messages: Message[]
  approvals: Approval[]
}

const SAMPLE_CONNECTORS: Connector[] = [
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
]

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || 'EU'

let state: State = {
  ready: false,
  view: null,
  me: { name: 'Eu', initials: 'EU' },
  settings: {
    workspaceName: '',
    context: '',
    engines: { claude: { installed: false, loggedIn: false }, codex: { installed: false, loggedIn: false } },
    routerModel: 'haiku',
    defaultLimit: 2_000_000,
    theme: 'system'
  },
  models: MODELS,
  agents: [],
  connectors: SAMPLE_CONNECTORS,
  conversations: [],
  messages: [],
  approvals: []
}

// ---------- store plumbing ----------

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

const upsert = <T extends { id: string }>(list: T[], item: T): T[] =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]

// ---------- core sync ----------

function withSettings(s: State, settings: Settings): State {
  const name = settings.workspaceName || 'Eu'
  return { ...s, settings, me: { name, initials: initials(name) } }
}

function apply(e: CoreEvent): void {
  set((s) => {
    switch (e.type) {
      case 'message': {
        const known = s.messages.some((m) => m.id === e.message.id)
        const viewing = s.view?.kind === 'conversation' && s.view.id === e.message.conversationId
        const conversations =
          !known && !viewing && e.message.author.kind === 'agent'
            ? s.conversations.map((c) => (c.id === e.message.conversationId ? { ...c, unread: (c.unread ?? 0) + 1 } : c))
            : s.conversations
        return { ...s, conversations, messages: upsert(s.messages, e.message) }
      }
      case 'delta':
        return { ...s, messages: s.messages.map((m) => (m.id === e.id ? { ...m, text: m.text + e.text } : m)) }
      case 'agent':
        return { ...s, agents: upsert(s.agents, e.agent) }
      case 'conversation': {
        const prev = s.conversations.find((c) => c.id === e.conversation.id)
        return { ...s, conversations: upsert(s.conversations, { ...e.conversation, unread: prev?.unread }) }
      }
      case 'settings':
        return withSettings(s, e.settings)
    }
  })
}

export async function start(): Promise<void> {
  await connect(apply)
  const snap = await call('snapshot')
  set((s) => {
    const first = snap.conversations.find((c) => c.kind === 'channel') ?? snap.conversations[0]
    const view = s.view ?? (first ? { kind: 'conversation' as const, id: first.id } : { kind: 'new-agent' as const })
    return { ...withSettings(s, snap.settings), ready: true, view, agents: snap.agents, conversations: snap.conversations, messages: snap.messages }
  })
}

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

export function updateSettings(patch: Partial<Omit<Settings, 'engines'>>): void {
  set((s) => withSettings(s, { ...s.settings, ...patch })) // optimistic, so typing stays instant
  void call('updateSettings', { patch })
}

export const refreshEngines = (): void => void call('refreshEngines')
export const loginEngine = (engine: keyof Settings['engines']): void => void call('loginEngine', { engine })

export function saveAgent(agent: Agent, channelIds: string[]): Promise<void> {
  return call('saveAgent', { agent, channelIds })
}

export function newAgentDraft(): Agent {
  return {
    id: crypto.randomUUID(),
    name: '',
    handle: '',
    role: '',
    color: 'teal',
    instructions: '',
    modelId: 'sonnet',
    effort: 'medium',
    limit: state.settings.defaultLimit,
    used: 0,
    grants: {},
    archived: false
  }
}

export async function createChannel(name: string): Promise<void> {
  const id = await call('createChannel', { name })
  navigate({ kind: 'conversation', id })
}

export async function openDm(agentId: string): Promise<void> {
  const id = await call('openDm', { agentId })
  navigate({ kind: 'conversation', id })
}

export function setGrant(agentId: string, connectorId: string, level: GrantLevel): void {
  const agent = agentById(state, agentId)
  if (!agent) return
  const channelIds = state.conversations.filter((c) => c.kind === 'channel' && c.members.includes(agentId)).map((c) => c.id)
  void saveAgent({ ...agent, grants: { ...agent.grants, [connectorId]: level } }, channelIds)
}

export function setToolClass(connectorId: string, toolName: string, patch: Partial<Connector['tools'][number]>): void {
  set((s) => ({
    ...s,
    connectors: s.connectors.map((c) =>
      c.id === connectorId ? { ...c, tools: c.tools.map((t) => (t.name === toolName ? { ...t, ...patch } : t)) } : c
    )
  }))
}

export const sendMessage = (conversationId: string, text: string): void => {
  if (text.trim()) void call('sendMessage', { conversationId, text })
}

export const stopRun = (messageId: string): void => void call('stopRun', { messageId })

// Approvals arrive with the gateway in M3; until then there are none to decide.
export function decideApproval(id: string, decision: 'approved' | 'refused', reason?: string): void {
  set((s) => ({
    ...s,
    approvals: s.approvals.map((a) => (a.id === id && a.state === 'pending' ? { ...a, state: decision, reason, decidedAt: Date.now() } : a))
  }))
}
