// Builds what a turn sends to the engine: a system prompt (stable per agent)
// and a prompt with the conversation transcript. The CLI keeps no session
// between turns, so everything the agent knows comes from here.
import type { Agent, Conversation, Message, Settings } from '../shared/types'

export const HISTORY_LIMIT = 30

export function systemPrompt(opts: { agent: Agent; settings: Pick<Settings, 'workspaceName' | 'context'>; conversation: Conversation; peers: Agent[] }): string {
  const { agent, settings, conversation, peers } = opts
  const me = settings.workspaceName || 'o usuário'
  const where =
    conversation.kind === 'dm'
      ? `Você está numa conversa direta (DM) com ${me}.`
      : `Você está no canal #${conversation.name}.${peers.length ? ` Outros agentes aqui: ${peers.map((p) => `${p.name} (@${p.handle}${p.role ? `, ${p.role}` : ''})`).join('; ')}.` : ''}`

  return [
    `Você é ${agent.name} (@${agent.handle}), um agente de IA no agent-desk, um app de chat onde ${me} conversa com um time de agentes em canais e DMs.`,
    agent.role && `Seu papel: ${agent.role}.`,
    settings.context.trim() && `## Sobre ${me}\n${settings.context.trim()}`,
    agent.instructions.trim() && `## Suas instruções\n${agent.instructions.trim()}`,
    [
      '## Como responder',
      `- ${where}`,
      '- Escreva só o texto da sua mensagem no chat, em Markdown. Não comece com seu nome nem com prefixos como "[Você]:".',
      '- Seja direto e natural, como num chat de trabalho.',
      '- Por enquanto você não tem ferramentas: não consegue consultar sistemas, abrir PRs, ler arquivos nem rodar comandos. Não diga que fez nem que vai fazer essas coisas; se precisar delas, diga o que faria e peça o que falta.'
    ].join('\n')
  ]
    .filter(Boolean)
    .join('\n\n')
}

const clock = (at: number): string => new Date(at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

export function transcript(opts: { agent: Agent; conversation: Conversation; messages: Message[]; agents: Agent[]; me: string }): string {
  const { agent, conversation, messages, agents, me } = opts
  const name = (m: Message): string | null => {
    if (m.author.kind === 'me') return me
    if (m.author.kind === 'system') return null
    const id = m.author.id
    const a = agents.find((x) => x.id === id)
    return a ? `${a.name}${a.id === agent.id ? ' (você)' : ''} · agente` : 'agente removido'
  }

  const lines = messages
    .filter((m) => m.text.trim() && m.author.kind !== 'system')
    .map((m) => `[${name(m)} · ${clock(m.at)}]\n${m.text.trim()}`)

  const where = conversation.kind === 'dm' ? `DM com ${me}` : `#${conversation.name}`
  return [`Conversa em ${where}, das mais antigas pras mais novas:`, ...lines, `Responda à última mensagem como ${agent.name}.`].join('\n\n')
}

// @handles in the text that belong to the given agents, in order of appearance.
export function mentioned(text: string, agents: Agent[]): Agent[] {
  const found: Agent[] = []
  for (const m of text.matchAll(/(^|[^\w@])@([a-z0-9][a-z0-9_-]{1,31})\b/gi)) {
    const a = agents.find((x) => x.handle.toLowerCase() === m[2]!.toLowerCase())
    if (a && !found.includes(a)) found.push(a)
  }
  return found
}
