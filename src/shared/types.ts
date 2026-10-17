// Domain types shared by the core (utility process) and the renderer.

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
  archived: boolean
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
  defaultLimit: number
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
