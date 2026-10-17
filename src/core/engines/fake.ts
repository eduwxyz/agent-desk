import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ROUTER_SYSTEM } from '../router'
import type { Engine, EngineEvent, Turn } from './types'

// Deterministic engine for tests and screenshots. Never spawns anything, but
// behaves like the real ones where it matters: it routes when given the
// router prompt, and calls ask_user through the gateway when asked to ask.
export function fakeEngine(id: Engine['id'], opts: { delayMs?: number; reply?: (turn: Turn) => string } = {}): Engine {
  const delay = opts.delayMs ?? 25
  return {
    id,
    async *run(turn): AsyncIterable<EngineEvent> {
      const last = lastMessage(turn.prompt)
      let reply: string
      if (turn.system === ROUTER_SYSTEM) {
        reply = JSON.stringify(fakeRoute(turn.prompt))
      } else if (opts.reply) {
        reply = opts.reply(turn)
      } else if (/pe[çc]a pr[oa] (\w+)/i.test(last)) {
        reply = `@${/pe[çc]a pr[oa] (\w+)/i.exec(last)![1]!.toLowerCase()}, pode ajudar aqui?`
      } else if (/pergunt/i.test(last) && turn.mcpUrl) {
        await callTool(turn.mcpUrl, 'ask_user', { question: 'Pra quando você precisa disso?' })
        reply = 'Te mandei uma pergunta.'
      } else {
        reply = `Resposta de teste (${id} · ${turn.model}). Recebi ${turn.prompt.length} caracteres de contexto.`
      }

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

// The text of the last message in a transcript or router prompt.
function lastMessage(prompt: string): string {
  const blocks = prompt.split(/\n\n|\n(?=\[)/).filter((b) => b.startsWith('['))
  return blocks.at(-1)?.replace(/^\[[^\]]*\]\s*/, '') ?? ''
}

const ROLE_WORDS: [RegExp, RegExp][] = [
  [/engenharia/i, /build|bug|erro|código|deploy|teste|pr\b/i],
  [/dados/i, /métrica|dados|sql|média|mediana|quantos|receita/i],
  [/conteúdo/i, /post|texto|anúncio|linkedin|escrev/i]
]

function fakeRoute(prompt: string): { handles: string[]; reason: string } {
  const last = lastMessage(prompt)
  if (/^(bom dia|boa tarde|boa noite|obrigad|valeu|ok)\b/i.test(last.trim())) return { handles: [], reason: 'cumprimento, ninguém precisa responder' }
  const roster = [...prompt.matchAll(/^- ([a-z0-9_-]+) \(([^)]*)\)/gim)].map((m) => ({ handle: m[1]!, about: m[2]! }))
  const fit = roster.find((r) => ROLE_WORDS.some(([role, words]) => role.test(r.about) && words.test(last)))
  const pick = fit ?? roster[0]
  return pick ? { handles: [pick.handle], reason: fit ? 'assunto da área dele' : 'primeiro do canal' } : { handles: [], reason: 'sem agentes' }
}

export async function callTool(url: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const client = new Client({ name: 'fake-engine', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  try {
    return await client.callTool({ name, arguments: args })
  } finally {
    await client.close()
  }
}
