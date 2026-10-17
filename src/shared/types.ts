// Domain types shared by the core (utility process) and the renderer.

export type AgentColor = 'sky' | 'indigo' | 'violet' | 'rose' | 'amber' | 'green' | 'teal' | 'graphite'
export type GrantLevel = 'none' | 'read' | 'read_write'
export type ToolClass = 'read' | 'write' | 'sensitive'
export type EngineId = 'claude' | 'codex'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'
export type MemoryMode = 'auto' | 'approve' | 'read' // how an agent's `lembrar` calls land

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
  account?: string // how the CLI is logged in, e.g. "Assinatura Claude"
  warning?: string // e.g. logged in with an API key instead of a subscription
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
  used: number // tokens used this month, computed from receipts
  grants: Record<string, GrantLevel>
  memory: MemoryMode
  computer: boolean // has its own Linux computer (spec §13)
  archived: boolean
}

export interface Conversation {
  id: string
  kind: 'channel' | 'dm'
  name: string // channel name, or agent id for a DM
  topic?: string
  members: string[] // agent ids
  summary?: string // what the conversation covered before its recent messages
  summaryUntil?: number // `at` of the last message the summary covers
  summaryAt?: number
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
  inputTokens: number // everything sent, including cache reads
  cacheReadTokens: number
  outputTokens: number
  ms: number
  apiCostUsd?: number // what the same usage would cost on the API, when the CLI reports it
}

export type RunStatus = 'working' | 'waiting_input' | 'waiting_approval' | 'done' | 'stopped' | 'limit_reached' | 'failed' | 'interrupted'

export interface Run {
  status: RunStatus
  steps: Step[]
  receipt?: Receipt
  approvalId?: string
  error?: string
  depth?: number // 1 when a human message triggered it, +1 for each agent-to-agent hop
  question?: string // asked with ask_user; answered by the next human message here
  memoryIds?: string[] // memories saved or proposed with `lembrar` in this reply
  artifactIds?: string[] // files and screenshots shown in this reply
  services?: string[] // services started in this reply, by name, on the author's computer
}

export type Author = { kind: 'me' } | { kind: 'agent'; id: string } | { kind: 'system' }

export interface Message {
  id: string
  conversationId: string
  author: Author
  text: string
  at: number
  run?: Run
}

export interface Settings {
  workspaceName: string
  context: string
  engines: Record<EngineId, EngineStatus>
  routerModel: string
  memoryModel: string // summarizes conversations and extracts memories
  memoryLearning: 'approve' | 'auto' | 'off' // what extracted memories about me become
  defaultLimit: number
  approvalTtlHours: number
  theme: 'system' | 'light' | 'dark'
}

export const ENGINES: Record<EngineId, { label: string; cli: string; login: string }> = {
  claude: { label: 'Claude Code', cli: 'claude', login: 'claude auth login' },
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

export const modelInfo = (id: string): Model | undefined => MODELS.find((m) => m.id === id)

export interface ConnectorTool {
  name: string
  description: string
  cls: ToolClass
  enabled: boolean
  highRisk: boolean
  isNew: boolean // appeared after the first sync; starts disabled until reviewed
}

export type ConnectorAuth = 'none' | 'token' | 'oauth'
export type ConnectorStatus = 'connected' | 'connecting' | 'needs_auth' | 'error' | 'disconnected'

export interface Connector {
  id: string
  name: string
  kind: 'remote' | 'stdio'
  url?: string // remote
  command?: string // stdio
  args?: string[]
  envKeys?: string[] // names only; values are secrets
  auth: ConnectorAuth
  status: ConnectorStatus
  error?: string
  tools: ConnectorTool[]
}

export interface ConnectorInput {
  name: string
  kind: 'remote' | 'stdio'
  url?: string
  auth?: ConnectorAuth
  token?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

export type ApprovalState = 'pending' | 'approved' | 'refused' | 'expired'

export interface Approval {
  id: string
  hash: string // sha256 of connector, tool and canonical arguments
  agentId: string
  conversationId: string
  messageId: string
  connectorId: string
  connectorName: string
  tool: string
  args: Record<string, unknown>
  why: string
  highRisk: boolean
  state: ApprovalState
  reason?: string
  outcome?: string // short summary of what happened when it ran
  createdAt: number
  expiresAt: number
  decidedAt?: number
}

// 'me' memories go to every agent; otherwise the scope is the id of the one agent they belong to.
export type MemoryScope = 'me' | string
export type MemoryState = 'active' | 'pending' | 'archived' | 'forgotten'

export interface Memory {
  id: string
  scope: MemoryScope
  text: string
  state: MemoryState
  origin: 'agent' | 'extraction' | 'me'
  agentId?: string // the agent that saved it, when origin is 'agent'
  conversationId?: string
  messageIds: string[] // evidence
  replaces?: string // the memory this one supersedes; it becomes archived when this one is active
  reason?: string // why it was forgotten
  createdAt: number
  confirmedAt: number // creation, edit, "still valid", or reinforced by a later conversation
}

export const SUMMARY_WINDOW = 30 // messages kept verbatim after a consolidation
export const SUMMARY_MAX_AFTER = 50 // more than this after the summary triggers one
export const STALE_DAYS = 60
export const isStale = (m: Memory, now = Date.now()): boolean => m.state === 'active' && now - m.confirmedAt > STALE_DAYS * 86_400_000

// ---------- the agent's computer ----------

export type ComputerState = 'off' | 'starting' | 'running' | 'stopped' | 'no_docker' | 'error'

export interface Service {
  name: string
  command: string
  port: number // inside the computer
  url?: string // on the Mac (127.0.0.1), while the computer runs
  running: boolean
  startedAt: number
}

export interface ComputerInfo {
  agentId: string
  state: ComputerState
  detail?: string // what is happening, or what went wrong
  folder: string // /work, on the Mac
  services: Service[]
}

export type ArtifactKind = 'image' | 'markdown' | 'html' | 'pdf' | 'csv' | 'text' | 'file'

export interface Artifact {
  id: string
  agentId: string
  conversationId: string
  messageId: string
  kind: ArtifactKind
  name: string // file name, also its path in the app's artifact store
  title: string
  source: string // where it came from: a path in the computer, or a URL for screenshots
  size: number
  createdAt: number
}

export const artifactUrl = (a: Pick<Artifact, 'id' | 'name'>): string => `agentdesk://artifact/${a.id}/${encodeURIComponent(a.name)}`
