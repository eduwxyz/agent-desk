import type { Effort, EngineId } from '../../shared/types'

export interface Turn {
  model: string
  effort: Effort
  system: string
  prompt: string
  cwd: string // an empty per-agent directory; the CLI gets no project files
  signal: AbortSignal
  mcpUrl?: string // the app's gateway for this turn: the only tools the CLI gets, besides the web ones
  web?: boolean // the CLI's own web search and page reading
}

export interface Usage {
  inputTokens: number // everything sent, including cache reads
  cacheReadTokens: number
  outputTokens: number
  apiCostUsd?: number
}

export type EngineEvent =
  | { type: 'text'; delta: string }
  // Running total for the turn so far, used to enforce the usage limit mid-turn.
  | { type: 'progress'; tokens: number }
  // A web search or page read the CLI did on its own (not through the gateway).
  | { type: 'web'; action: 'search' | 'fetch'; detail: string }
  | { type: 'done'; text: string; usage: Usage }
  | { type: 'error'; message: string }

export interface Engine {
  id: EngineId
  run(turn: Turn): AsyncIterable<EngineEvent>
}
