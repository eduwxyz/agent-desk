// The router picks who answers a channel message nobody was mentioned in. It
// only chooses speakers: it grants nothing and never sees tools, just which
// connectors each agent may use, so a question about Linear goes to whoever
// can read Linear.
import type { Agent, Connector, Message } from '../shared/types'
import type { Engine, Usage } from './engines/types'

export const ROUTER_HISTORY = 10
export const MAX_ROUTED = 2

export const ROUTER_SYSTEM = [
  'Você decide quais agentes de um chat de trabalho devem responder à última mensagem humana.',
  'Responda SOMENTE com JSON, sem texto em volta, no formato {"handles": ["..."], "reason": "..."}:',
  `- "handles": de 0 a ${MAX_ROUTED} handles, só da lista de agentes; prefira 1.`,
  '- "reason": um motivo de até 12 palavras, em português.',
  'Se a mensagem depende de um sistema externo (ex.: Linear, GitHub), prefira quem tem acesso a ele; se ninguém tem, escolha pelo papel.',
  'Lista vazia quando ninguém precisa responder: cumprimento solto, agradecimento, recado, conversa já encerrada.'
].join('\n')

const GRANT_LABEL = { read: 'só leitura', read_write: 'leitura e escrita' } as const

export function routerPrompt(opts: { messages: Message[]; agents: Agent[]; me: string; connectors?: Connector[] }): string {
  const { messages, agents, me, connectors = [] } = opts
  const roster = agents.map((a) => {
    const about = a.instructions.split('\n')[0]?.slice(0, 140)
    const access = connectors.flatMap((c) => {
      const g = a.grants[c.id]
      return g === 'read' || g === 'read_write' ? [`${c.name} (${GRANT_LABEL[g]})`] : []
    })
    return `- ${a.handle} (${a.name}${a.role ? `, ${a.role}` : ''})${about ? `: ${about}` : ''} · acessa: ${access.join(', ') || 'nenhum sistema externo'}`
  })
  const lines = messages
    .filter((m) => m.text.trim() && m.author.kind !== 'system')
    .slice(-ROUTER_HISTORY)
    .map((m) => {
      const author = m.author.kind === 'me' ? me : (agents.find((a) => m.author.kind === 'agent' && a.id === m.author.id)?.name ?? 'agente')
      return `[${author}] ${m.text.trim().slice(0, 600)}`
    })
  return ['Agentes no canal:', ...roster, '', 'Conversa (a última é a que precisa de resposta):', ...lines, '', 'Responda só com o JSON.'].join('\n')
}

// Lenient: models sometimes wrap JSON in a code fence or add a line around it.
export function parseRoute(text: string, agents: Agent[]): { agents: Agent[]; reason: string } | null {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  if (!json) return null
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const { handles, reason } = data as { handles?: unknown; reason?: unknown }
  if (!Array.isArray(handles)) return null
  const picked: Agent[] = []
  for (const h of handles) {
    if (typeof h !== 'string') continue
    const a = agents.find((x) => x.handle.toLowerCase() === h.replace(/^@/, '').toLowerCase())
    if (a && !picked.includes(a)) picked.push(a)
  }
  return { agents: picked.slice(0, MAX_ROUTED), reason: typeof reason === 'string' ? reason.trim() : '' }
}

export async function route(opts: {
  engine: Engine
  model: string
  messages: Message[]
  agents: Agent[]
  me: string
  connectors?: Connector[]
  cwd: string
}): Promise<{ agents: Agent[]; reason: string; usage?: Usage; ms: number } | { error: string; usage?: Usage; ms: number }> {
  const started = Date.now()
  let text = ''
  let usage: Usage | undefined
  let error: string | undefined
  for await (const ev of opts.engine.run({
    model: opts.model,
    effort: 'low',
    system: ROUTER_SYSTEM,
    prompt: routerPrompt(opts),
    cwd: opts.cwd,
    signal: AbortSignal.timeout(60_000)
  })) {
    if (ev.type === 'text') text += ev.delta
    else if (ev.type === 'done') {
      text = ev.text || text
      usage = ev.usage
    } else if (ev.type === 'error') error = ev.message
  }
  const ms = Date.now() - started
  if (error) return { error, usage, ms }
  const parsed = parseRoute(text, opts.agents)
  return parsed ? { ...parsed, usage, ms } : { error: 'resposta do router fora do formato', usage, ms }
}
