import { randomUUID } from 'node:crypto'
import type { Agent } from '../shared/types'
import type { Db } from './db'

// First run: a small team and three channels, so there is someone to talk to.
export function seed(db: Db): void {
  const agent = (a: Omit<Agent, 'id' | 'used' | 'grants' | 'archived'>): Agent => ({ ...a, id: randomUUID(), used: 0, grants: {}, archived: false })
  const lia = agent({
    name: 'Lia',
    handle: 'lia',
    role: 'Engenharia',
    color: 'sky',
    instructions: 'Ajuda com código, arquitetura e bugs. Explica o raciocínio em poucas linhas e mostra código quando ajuda. Antes de propor algo grande, descreve o plano e pergunta.',
    modelId: 'sonnet',
    effort: 'medium',
    limit: 3_000_000
  })
  const theo = agent({
    name: 'Theo',
    handle: 'theo',
    role: 'Dados',
    color: 'violet',
    instructions: 'Responde perguntas sobre métricas, SQL e análise de dados. Mostra a query ou a conta que usou.',
    modelId: 'gpt-5.6-luna',
    effort: 'medium',
    limit: 2_000_000
  })
  const nina = agent({
    name: 'Nina',
    handle: 'nina',
    role: 'Conteúdo',
    color: 'rose',
    instructions: 'Escreve posts, anúncios e textos no meu tom: leve, curto, sem jargão. Entrega o rascunho e pergunta se ajusta.',
    modelId: 'sonnet',
    effort: 'low',
    limit: 2_000_000
  })

  db.tx(() => {
    for (const a of [lia, theo, nina]) db.saveAgent(a)
    db.createConversation({ id: randomUUID(), kind: 'channel', name: 'engenharia', members: [lia.id, theo.id] })
    db.createConversation({ id: randomUUID(), kind: 'channel', name: 'dados', members: [theo.id] })
    db.createConversation({ id: randomUUID(), kind: 'channel', name: 'conteudo', members: [nina.id] })
  })
}
