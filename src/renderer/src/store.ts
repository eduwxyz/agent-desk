// Renderer state. Everything except the current view comes from the core and
// is kept in sync by its events; actions go to the core over RPC.
import { useRef, useSyncExternalStore } from 'react'
import type { CoreEvent } from '../../shared/rpc'
import {
  MODELS,
  type Agent,
  type Approval,
  type Artifact,
  type ComputerInfo,
  type Connector,
  type ConnectorInput,
  type ConnectorTool,
  type Conversation,
  type GrantLevel,
  type Memory,
  type MemoryScope,
  type Message,
  type Model,
  type Project,
  type Routine,
  type RoutineInput,
  type Settings
} from '../../shared/types'
import { call, connect } from './rpc'

export * from '../../shared/types'

export type View =
  | { kind: 'conversation'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'new-agent' }
  | { kind: 'approvals' }
  | { kind: 'usage' }
  | { kind: 'connectors' }
  | { kind: 'memory' }
  | { kind: 'routines' }
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
  memories: Memory[]
  artifacts: Artifact[]
  computers: ComputerInfo[]
  routines: Routine[]
  packaged: boolean
  panel: Panel | null // the side panel next to a conversation
  demoServer?: { command: string; args: string[] }
}

export type Panel = { kind: 'artifact'; id: string } | { kind: 'service'; agentId: string; name: string }

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
    memoryModel: 'haiku',
    memoryLearning: 'approve',
    defaultLimit: 2_000_000,
    approvalTtlHours: 24,
    theme: 'system'
  },
  models: MODELS,
  agents: [],
  connectors: [],
  conversations: [],
  messages: [],
  approvals: [],
  memories: [],
  artifacts: [],
  computers: [],
  routines: [],
  packaged: false,
  panel: null
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
          !known && !viewing && (e.message.author.kind === 'agent' || e.message.author.kind === 'routine')
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
      case 'connector':
        return { ...s, connectors: upsert(s.connectors, e.connector) }
      case 'connector_removed':
        return { ...s, connectors: s.connectors.filter((c) => c.id !== e.id) }
      case 'approval':
        return { ...s, approvals: upsert(s.approvals, e.approval) }
      case 'memory':
        return { ...s, memories: upsert(s.memories, e.memory) }
      case 'memory_removed':
        return { ...s, memories: s.memories.filter((m) => m.id !== e.id) }
      case 'artifact':
        return { ...s, artifacts: upsert(s.artifacts, e.artifact) }
      case 'computer': {
        const others = s.computers.filter((c) => c.agentId !== e.computer.agentId)
        return { ...s, computers: [...others, e.computer] }
      }
      case 'routine':
        return { ...s, routines: upsert(s.routines, e.routine) }
      case 'routine_removed':
        return { ...s, routines: s.routines.filter((r) => r.id !== e.id) }
    }
  })
}

export async function start(): Promise<void> {
  window.agentDesk.onNavigate((id) => navigate({ kind: 'conversation', id }))
  await connect(apply)
  const snap = await call('snapshot')
  set((s) => {
    const first = snap.conversations.find((c) => c.kind === 'channel') ?? snap.conversations[0]
    const view = s.view ?? (first ? { kind: 'conversation' as const, id: first.id } : { kind: 'new-agent' as const })
    return {
      ...withSettings(s, snap.settings),
      ready: true,
      view,
      agents: snap.agents,
      conversations: snap.conversations,
      messages: snap.messages,
      connectors: snap.connectors,
      approvals: snap.approvals,
      memories: snap.memories,
      artifacts: snap.artifacts,
      computers: snap.computers,
      routines: snap.routines,
      packaged: snap.packaged,
      demoServer: snap.demoServer
    }
  })
}

// ---------- selectors ----------

export const agentById = (s: State, id: string): Agent | undefined => s.agents.find((a) => a.id === id)
export const modelById = (s: State, id: string): Model | undefined => s.models.find((m) => m.id === id)
export const pendingApprovals = (s: State): Approval[] => s.approvals.filter((a) => a.state === 'pending')
export const computerOf = (s: State, agentId: string): ComputerInfo | undefined => s.computers.find((c) => c.agentId === agentId)
export const pendingMemories = (s: State): Memory[] => s.memories.filter((m) => m.state === 'pending')

export function conversationTitle(s: State, c: Conversation): string {
  if (c.kind === 'channel') return c.name
  return agentById(s, c.name)?.name ?? 'Agente'
}

// ---------- actions ----------

export const navigate = (view: View): void =>
  set((s) => ({
    ...s,
    view,
    panel: s.view?.kind === view.kind && JSON.stringify(s.view) === JSON.stringify(view) ? s.panel : null,
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
    memory: 'auto',
    computer: false,
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
  if (agent) patchAgent(agentId, { grants: { ...agent.grants, [connectorId]: level } })
}

export const updateTool = (connectorId: string, name: string, patch: Partial<Pick<ConnectorTool, 'cls' | 'enabled' | 'highRisk'>>): void =>
  void call('updateTool', { connectorId, name, patch })

export const addConnector = (input: ConnectorInput): Promise<string> => call('addConnector', { input })
export const removeConnector = (id: string): void => void call('removeConnector', { id })
export const reconnectConnector = (id: string): void => void call('reconnectConnector', { id })
export const authorizeConnector = (id: string): void => void call('authorizeConnector', { id })

export const sendMessage = (conversationId: string, text: string): void => {
  if (text.trim()) void call('sendMessage', { conversationId, text })
}

export const stopRun = (messageId: string): void => void call('stopRun', { messageId })
export const retryRun = (messageId: string): void => void call('retryRun', { messageId })

export const decideApproval = (id: string, decision: 'approved' | 'refused', reason?: string): void =>
  void call('decideApproval', { id, decision, reason })

export const addMemory = (scope: MemoryScope, text: string): void => void call('addMemory', { scope, text })
export const editMemory = (id: string, text: string): void => void call('editMemory', { id, text })
export const confirmMemory = (id: string): void => void call('confirmMemory', { id })
export const decideMemory = (id: string, accept: boolean): void => void call('decideMemory', { id, accept })
export const forgetMemory = (id: string, reason?: string): void => void call('forgetMemory', { id, reason })
export const purgeMemory = (id: string): void => void call('purgeMemory', { id })
export const editSummary = (conversationId: string, text: string): void => void call('editSummary', { conversationId, text })
export const summarizeNow = (conversationId: string): void => void call('summarizeNow', { conversationId })

// Saves one field of a stored agent without touching the rest of its page.
export function patchAgent(agentId: string, patch: Partial<Agent>): void {
  const agent = agentById(state, agentId)
  if (!agent) return
  const channelIds = state.conversations.filter((c) => c.kind === 'channel' && c.members.includes(agentId)).map((c) => c.id)
  void saveAgent({ ...agent, ...patch }, channelIds)
}

export const openPanel = (panel: Panel | null): void => set((s) => ({ ...s, panel }))
export const computerAction = (agentId: string, action: 'start' | 'restart' | 'erase' | 'open_folder' | 'refresh'): void =>
  void call('computerAction', { agentId, action })
export const stopService = (agentId: string, name: string): void => void call('stopService', { agentId, name })
export const openExternal = (url: string): void => void call('openExternal', { url })

export const saveRoutine = (routine: RoutineInput): Promise<Routine> => call('saveRoutine', { routine })
export const setJevKey = (key: string | null): Promise<void> => call('setJevKey', { key })
export const removeRoutine = (id: string): void => void call('removeRoutine', { id })
export const runRoutine = (id: string): void => void call('runRoutine', { id })
// The id of the DM with an agent, created if it doesn't exist yet, without opening it.
export const dmWith = (agentId: string): Promise<string> => call('openDm', { agentId })

// Opens the Mac's folder picker; resolves with why it couldn't be lent, if so.
export async function lendFolder(agentId: string): Promise<string | null> {
  const path = await window.agentDesk.pickFolder()
  if (!path) return null
  try {
    await call('lendFolder', { agentId, path })
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
export const folderAction = (agentId: string, name: string, action: 'read_only' | 'read_write' | 'return'): void => void call('folderAction', { agentId, name, action })

// Ties a channel to a folder (picked on the Mac when `pick`), or changes or removes its project.
export async function setProject(conversationId: string, project: Project | null, pick = false): Promise<string | null> {
  if (pick) {
    const folder = await window.agentDesk.pickFolder()
    if (!folder) return null
    const conv = state.conversations.find((c) => c.id === conversationId)
    project = { files: [], brief: '', access: {}, ...conv?.project, ...project, folder }
    if (conv?.project?.folder !== folder) project.files = []
  }
  try {
    await call('setProject', { conversationId, project })
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
