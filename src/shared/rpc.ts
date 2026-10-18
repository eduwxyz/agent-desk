// The contract between the renderer and the core, carried over a MessagePort.
import type { Agent, Approval, Artifact, ComputerInfo, Connector, ConnectorInput, ConnectorTool, Conversation, EngineId, Memory, MemoryScope, Message, Project, Routine, RoutineInput, Settings } from './types'

export interface Snapshot {
  settings: Settings
  agents: Agent[]
  conversations: Conversation[]
  messages: Message[]
  connectors: Connector[]
  approvals: Approval[]
  memories: Memory[]
  artifacts: Artifact[]
  computers: ComputerInfo[]
  routines: Routine[]
  packaged: boolean // installed app, not `npm run dev` (opening at login only works there)
  demoServer?: { command: string; args: string[] } // the bundled demo connector, when available
}

export interface Api {
  snapshot(): Snapshot
  sendMessage(p: { conversationId: string; text: string }): void
  stopRun(p: { messageId: string }): void
  retryRun(p: { messageId: string }): void
  saveAgent(p: { agent: Agent; channelIds: string[] }): void
  createChannel(p: { name: string }): string
  openDm(p: { agentId: string }): string
  updateSettings(p: { patch: Partial<Omit<Settings, 'engines'>> }): void
  refreshEngines(): void
  loginEngine(p: { engine: EngineId }): void
  addConnector(p: { input: ConnectorInput }): Promise<string>
  removeConnector(p: { id: string }): void
  reconnectConnector(p: { id: string }): void
  authorizeConnector(p: { id: string }): void
  updateTool(p: { connectorId: string; name: string; patch: Partial<Pick<ConnectorTool, 'cls' | 'enabled' | 'highRisk'>> }): void
  decideApproval(p: { id: string; decision: 'approved' | 'refused'; reason?: string }): void
  addMemory(p: { scope: MemoryScope; text: string }): void
  editMemory(p: { id: string; text: string }): void
  confirmMemory(p: { id: string }): void // "still valid"
  decideMemory(p: { id: string; accept: boolean }): void // a pending one
  forgetMemory(p: { id: string; reason?: string }): void
  purgeMemory(p: { id: string }): void // removes even the record that it was forgotten
  editSummary(p: { conversationId: string; text: string }): void
  summarizeNow(p: { conversationId: string }): void
  computerAction(p: { agentId: string; action: 'start' | 'restart' | 'erase' | 'open_folder' | 'refresh' }): void
  stopService(p: { agentId: string; name: string }): void
  lendFolder(p: { agentId: string; path: string }): void // throws why it can't, for the page
  setProject(p: { conversationId: string; project: Project | null }): void // throws why the folder can't be used
  folderAction(p: { agentId: string; name: string; action: 'read_only' | 'read_write' | 'return' }): void
  openExternal(p: { url: string }): void
  saveRoutine(p: { routine: RoutineInput }): Routine // throws a message for the form
  setJevKey(p: { key: string | null }): Promise<void> // checks the key with TypeSafe; throws why it's refused
  removeRoutine(p: { id: string }): void
  runRoutine(p: { id: string }): void
}

export type Method = keyof Api
export type Params<M extends Method> = Parameters<Api[M]>[0]
export type Result<M extends Method> = Awaited<ReturnType<Api[M]>>

export type CoreEvent =
  | { type: 'message'; message: Message }
  | { type: 'delta'; id: string; text: string } // appended to message text while streaming
  | { type: 'agent'; agent: Agent }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'settings'; settings: Settings }
  | { type: 'connector'; connector: Connector }
  | { type: 'connector_removed'; id: string }
  | { type: 'approval'; approval: Approval }
  | { type: 'memory'; memory: Memory }
  | { type: 'memory_removed'; id: string }
  | { type: 'computer'; computer: ComputerInfo }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'routine'; routine: Routine }
  | { type: 'routine_removed'; id: string }

export type Request = { id: number; method: Method; params: unknown }
export type Response = { id: number; result?: unknown; error?: string }
export type Wire = Response | { event: CoreEvent }
