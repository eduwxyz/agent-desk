import type { Engine, EngineEvent } from './types'

// Deterministic engine for tests and screenshots: streams a canned reply word
// by word and reports usage proportional to the prompt. Never spawns anything.
export function fakeEngine(id: Engine['id'], opts: { delayMs?: number; reply?: (prompt: string) => string } = {}): Engine {
  const delay = opts.delayMs ?? 25
  return {
    id,
    async *run(turn): AsyncIterable<EngineEvent> {
      const reply = opts.reply?.(turn.prompt) ?? `Resposta de teste (${id} · ${turn.model}). Recebi ${turn.prompt.length} caracteres de contexto.`
      const inputTokens = Math.ceil((turn.system.length + turn.prompt.length) / 4)
      yield { type: 'progress', tokens: inputTokens }
      let text = ''
      for (const word of reply.split(/(\s+)/)) {
        if (turn.signal.aborted) return
        await new Promise((r) => setTimeout(r, delay))
        text += word
        yield { type: 'text', delta: word }
      }
      const outputTokens = Math.ceil(reply.length / 4)
      yield {
        type: 'done',
        text,
        usage: { inputTokens, cacheReadTokens: 0, outputTokens, apiCostUsd: id === 'claude' ? 0.001 : undefined }
      }
    }
  }
}
