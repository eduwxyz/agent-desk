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
      peers.length > 0 &&
        '- Se outro agente do canal for mais indicado pra uma parte, mencione-o com @handle na sua resposta: ele responde em seguida. Só mencione quando precisar mesmo.',
      `- Se precisar de uma informação de ${me} pra continuar, use a ferramenta ask_user com uma pergunta curta e encerre a resposta. A resposta chega na próxima mensagem.`,
      `- Suas outras ferramentas são as que ${me} liberou pra você. Ações sensíveis não rodam na hora: viram um pedido de aprovação, e você recebe o resultado depois da decisão.`,
      '- Não tem shell nem acesso a arquivos. Não diga que fez algo que nenhuma ferramenta sua fez; se faltar uma ferramenta, diga o que faria e peça o que falta.'
    ]
      .filter(Boolean)
      .join('\n')
  ]
    .filter(Boolean)
    .join('\n\n')
}

const clock = (at: number): string => new Date(at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

// `task` replaces the closing instruction, e.g. to continue after an approval.
export function transcript(opts: { agent: Agent; conversation: Conversation; messages: Message[]; agents: Agent[]; me: string; task?: string }): string {
  const { agent, conversation, messages, agents, me, task } = opts
  const name = (m: Message): string | null => {
    if (m.author.kind === 'me') return me
    if (m.author.kind === 'system') return null
    const id = m.author.id
    const a = agents.find((x) => x.id === id)
    return a ? `${a.name}${a.id === agent.id ? ' (você)' : ''} · agente` : 'agente removido'
  }

  // A question asked with ask_user is part of what the agent said.
  const body = (m: Message): string =>
    [m.text.trim(), m.run?.question && `(pergunta enviada a ${me} pela ferramenta ask_user: ${m.run.question})`].filter(Boolean).join('\n\n')

  const lines = messages
    .filter((m) => m.author.kind !== 'system' && body(m))
    .map((m) => `[${name(m)} · ${clock(m.at)}]\n${body(m)}`)

  const where = conversation.kind === 'dm' ? `DM com ${me}` : `#${conversation.name}`
  return [`Conversa em ${where}, das mais antigas pras mais novas:`, ...lines, task ?? `Responda à última mensagem como ${agent.name}.`].join('\n\n')
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
