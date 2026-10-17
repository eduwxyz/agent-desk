import { describe, expect, it } from 'vitest'
import { mentioned, systemPrompt, transcript } from '../src/core/context'
import type { Agent, Conversation, Message } from '../src/shared/types'

const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  name: handle[0]!.toUpperCase() + handle.slice(1),
  handle,
  role: '',
  color: 'sky',
  instructions: '',
  modelId: 'sonnet',
  effort: 'medium',
  limit: 1000,
  used: 0,
  grants: {},
  memory: 'auto',
  computer: false,
  archived: false,
  ...extra
})

const lia = agent('a1', 'lia', { role: 'Engenharia', instructions: 'Mostra código quando ajuda.' })
const theo = agent('a2', 'theo', { role: 'Dados' })
const channel: Conversation = { id: 'c1', kind: 'channel', name: 'engenharia', members: ['a1', 'a2'] }
const dm: Conversation = { id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] }

describe('mentioned', () => {
  it('finds handles in order, once each, ignoring case and unknown handles', () => {
    expect(mentioned('@Theo e @lia, olhem isso. @lia de novo. @ninguem', [lia, theo]).map((a) => a.id)).toEqual(['a2', 'a1'])
  })

  it('does not match emails', () => {
    expect(mentioned('manda pra eu@lia.com', [lia])).toEqual([])
  })
})

describe('systemPrompt', () => {
  it('includes identity, workspace context, instructions and the room', () => {
    const s = systemPrompt({ agent: lia, settings: { workspaceName: 'Edu', context: 'Trabalho com agentes.' }, conversation: channel, peers: [theo] })
    expect(s).toContain('Você é Lia (@lia)')
    expect(s).toContain('Seu papel: Engenharia.')
    expect(s).toContain('## Sobre Edu\nTrabalho com agentes.')
    expect(s).toContain('## Suas instruções\nMostra código quando ajuda.')
    expect(s).toContain('canal #engenharia')
    expect(s).toContain('Theo (@theo, Dados)')
  })

  it('leaves out empty sections and describes a DM', () => {
    const s = systemPrompt({ agent: theo, settings: { workspaceName: 'Edu', context: '  ' }, conversation: dm, peers: [] })
    expect(s).not.toContain('## Sobre')
    expect(s).not.toContain('## Suas instruções')
    expect(s).toContain('conversa direta (DM) com Edu')
  })
})

describe('transcript', () => {
  const at = new Date(2026, 9, 17, 14, 2).getTime()
  const messages: Message[] = [
    { id: 'm1', conversationId: 'c1', author: { kind: 'me' }, text: 'Oi, time', at },
    { id: 'm2', conversationId: 'c1', author: { kind: 'system' }, text: 'Router chamou Lia', at },
    { id: 'm3', conversationId: 'c1', author: { kind: 'agent', id: 'a2' }, text: 'Oi!', at },
    { id: 'm4', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: 'Olá', at },
    { id: 'm5', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: '', at }
  ]

  it('labels authors, marks the agent itself, skips system lines and empty messages', () => {
    const t = transcript({ agent: lia, conversation: channel, messages, agents: [lia, theo], me: 'Edu' })
    expect(t).toContain('[Edu · 17/10, 14:02]\nOi, time')
    expect(t).toContain('[Theo · agente · 17/10, 14:02]\nOi!')
    expect(t).toContain('[Lia (você) · agente · 17/10, 14:02]\nOlá')
    expect(t).not.toContain('Router chamou')
    expect(t.endsWith('Responda à última mensagem como Lia.')).toBe(true)
  })
})
