// The contract between the renderer and the core, carried over a MessagePort.
import type { Agent, Approval, Connector, ConnectorInput, ConnectorTool, Conversation, EngineId, Message, Settings } from './types'

export interface Snapshot {
  settings: Settings
  agents: Agent[]
  conversations: Conversation[]
  messages: Message[]
  connectors: Connector[]
  approvals: Approval[]
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

export type Request = { id: number; method: Method; params: unknown }
export type Response = { id: number; result?: unknown; error?: string }
export type Wire = Response | { event: CoreEvent }
