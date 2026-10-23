// Skills (spec §18): recipes an agent follows for a kind of task. Each agent
// sees the names and when to use them in its prompt, and reads a body with
// ler_skill when a task matches. Agents propose new skills and changes with
// propor_skill; those wait for me, with a diff, and every change keeps the
// version before it, so any can be undone.
import { randomUUID } from 'node:crypto'
import type { CoreEvent } from '../shared/rpc'
import { skillApplies, type Agent, type Skill, type SkillInput } from '../shared/types'
import type { Db } from './db'
import type { ToolDef } from './gateway'
import { frontmatter, readLinked } from './local-skills'
import { readdirSync, readFileSync } from 'node:fs'

const MAX_BODY = 20_000
const MAX_PENDING = 5 // per agent, so an agent can't flood the review

export const LER_SKILL: ToolDef = {
  name: 'ler_skill',
  description: 'Lê a receita completa de uma das suas skills. Leia antes de uma tarefa que bate com o "quando usar" dela, e siga.',
  inputSchema: {
    type: 'object',
    properties: {
      nome: { type: 'string', description: 'O nome da skill, como na lista.' },
      arquivo: { type: 'string', description: 'Um dos arquivos de apoio que a receita lista (ex.: "estilo.md"). Sem ele, lê a receita.' }
    },
    required: ['nome']
  }
}

export const PROPOR_SKILL: ToolDef = {
  name: 'propor_skill',
  description:
    'Propõe uma skill nova, ou uma mudança numa sua, quando descobrir um jeito de fazer algo que vale repetir: resolveu em vários passos, saiu de um beco sem saída, ou foi corrigido. Ela só vale depois que o usuário aprovar.',
  inputSchema: {
    type: 'object',
    properties: {
      nome: { type: 'string', description: 'Curto, com hífens (ex.: "testes-do-core"). O nome de uma skill existente propõe uma mudança nela.' },
      quando_usar: { type: 'string', description: 'Em uma frase, em que tipo de tarefa usar.' },
      receita: { type: 'string', description: 'Os passos, em Markdown: comandos exatos, armadilhas, como conferir. A receita inteira, não só o que muda: ao mudar uma skill, leia antes com ler_skill e mantenha cada passo, comando e flag que continua valendo.' },
      motivo: { type: 'string', description: 'Por que, em uma frase. Aparece pro usuário na revisão.' }
    },
    required: ['nome', 'quando_usar', 'receita']
  }
}

// The files next to a linked skill's SKILL.md, for the agent to open with ler_skill.
function filesNote(source: string): string {
  try {
    const dir = source.slice(0, source.lastIndexOf('/'))
    const files = readdirSync(dir).filter((f) => /\.(md|txt|json|ya?ml|csv)$/.test(f) && f !== 'SKILL.md')
    return files.length ? `\n\n---\nArquivos de apoio desta skill (leia com ler_skill e o campo arquivo quando a receita mandar): ${files.join(', ')}` : ''
  } catch {
    return ''
  }
}

export const SKILL_TOOL_NAMES = new Set([LER_SKILL.name, PROPOR_SKILL.name])

export const skillName = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

type Outcome = { reply: string; error?: boolean; skill?: Skill }

export class Skills {
  constructor(private deps: { db: Db; emit: (e: CoreEvent) => void; notify?: (title: string, body: string) => void; now?: () => number }) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private store(k: Skill): Skill {
    this.deps.db.saveSkill(k)
    this.deps.emit({ type: 'skill', skill: k })
    return k
  }

  private drop(id: string): void {
    this.deps.db.removeSkill(id)
    this.deps.emit({ type: 'skill_removed', id })
  }

  // Active skills this agent follows, for its prompt.
  forAgent(agentId: string): Skill[] {
    return this.deps.db.skills().filter((s) => skillApplies(s, agentId))
  }

  private active(name: string, except?: string): Skill | undefined {
    return this.deps.db.skills().find((s) => s.state === 'active' && s.name === name && s.id !== except)
  }

  // Me, from the Skills page: takes effect right away, keeping the version before.
  save(input: SkillInput): Skill {
    const name = skillName(input.name)
    const prev = input.id ? this.deps.db.skill(input.id) : undefined
    // A linked skill is edited in Claude Code or Codex; here only who uses it changes.
    if (prev?.source) return this.store({ ...prev, agents: [...new Set(input.agents)], updatedAt: this.now() })
    const description = input.description.trim()
    const body = input.body.trim()
    if (!name) throw new Error('Dê um nome pra skill.')
    if (!description) throw new Error('Diga quando usar.')
    if (!body) throw new Error('Escreva a receita.')
    if (body.length > MAX_BODY) throw new Error(`A receita passou de ${MAX_BODY} caracteres.`)
    if (this.active(name, input.id)) throw new Error(`Já existe uma skill chamada ${name}.`)
    if (prev && prev.state === 'active' && (prev.name !== name || prev.description !== description || prev.body !== body)) this.keep(prev, 'me')
    const at = this.now()
    return this.store({ ...prev, id: prev?.id ?? randomUUID(), name, description, body, agents: [...new Set(input.agents)], state: 'active', replaces: undefined, proposedBy: undefined, reason: undefined, createdAt: prev?.createdAt ?? at, updatedAt: at })
  }

  private keep(k: Skill, by: string): void {
    this.deps.db.addSkillVersion({ skillId: k.id, name: k.name, description: k.description, body: k.body, by, at: this.now() })
  }

  // Me: a skill of my Claude Code or Codex, linked to its file (for all agents unless I pick some).
  link(source: string, agents: string[]): Skill {
    const linked = this.deps.db.skills().find((s) => s.source === source && s.state !== 'pending')
    if (linked) return this.store({ ...linked, state: 'active', agents: [...new Set(agents)], updatedAt: this.now() })
    let text: string
    try {
      text = readFileSync(source, 'utf8')
    } catch {
      throw new Error('Não consegui ler essa skill.')
    }
    const fm = frontmatter(text)
    const name = skillName(fm.name || source.split('/').at(-2) || '')
    if (!name) throw new Error('Essa skill não tem nome.')
    if (this.active(name)) throw new Error(`Já existe uma skill chamada ${name}.`)
    const at = this.now()
    return this.store({ id: randomUUID(), name, description: fm.description || name, body: fm.body.trim().slice(0, MAX_BODY), agents: [...new Set(agents)], state: 'active', source, createdAt: at, updatedAt: at })
  }

  // `ler_skill`: a linked one is read from its file now, and can open its other files.
  read(agent: Agent, args: Record<string, unknown>): Outcome {
    const name = skillName(String(args['nome'] ?? ''))
    const k = this.forAgent(agent.id).find((s) => s.name === name)
    if (!k) return { reply: `Você não tem uma skill chamada "${name}".`, error: true }
    if (!k.source) return { reply: `# ${k.name}\nQuando usar: ${k.description}\n\n${k.body}`, skill: k }
    const file = typeof args['arquivo'] === 'string' && args['arquivo'].trim() ? args['arquivo'].trim() : undefined
    try {
      if (file) return { reply: `# ${k.name} · ${file}\n\n${readLinked(k.source, file)}`, skill: k }
      const body = readLinked(k.source)
      if (body !== k.body) this.store({ ...k, body: body.slice(0, MAX_BODY) }) // the page shows the version the agents read
      return { reply: `# ${k.name}\nQuando usar: ${k.description}\n\n${body}${filesNote(k.source)}`, skill: k }
    } catch (e) {
      return { reply: file ? `Não consegui ler ${file}: ${e instanceof Error ? e.message : String(e)}` : `O arquivo dessa skill não está mais em ${k.source}.`, error: true }
    }
  }

  // `propor_skill`: a new skill, or a change to one of its own, waiting for me.
  propose(agent: Agent, args: Record<string, unknown>): Outcome {
    const text = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string).trim() : '')
    const name = skillName(text('nome'))
    const description = text('quando_usar')
    const body = text('receita')
    if (!name || !description || !body) return { reply: 'Faltou nome, quando_usar ou receita.', error: true }
    if (body.length > MAX_BODY) return { reply: `A receita passou de ${MAX_BODY} caracteres: resuma.`, error: true }
    const all = this.deps.db.skills()
    if (all.filter((s) => s.state === 'pending' && s.proposedBy === agent.id).length >= MAX_PENDING)
      return { reply: `Você já tem ${MAX_PENDING} propostas esperando revisão. Espere o usuário decidir.`, error: true }
    const current = this.active(name)
    if (current?.source) return { reply: `A skill "${name}" vem de um arquivo do usuário (${current.source}): ela muda lá, não aqui. Diga a ele o que mudaria.`, error: true }
    if (current && !skillApplies(current, agent.id)) return { reply: `Já existe uma skill "${name}" que não é sua: escolha outro nome.`, error: true }
    if (current && current.description === description && current.body === body) return { reply: 'Essa skill já está assim.' }
    // A second proposal for the same thing replaces the first one still waiting.
    const waiting = all.find((s) => s.state === 'pending' && s.proposedBy === agent.id && s.name === name)
    const at = this.now()
    const k = this.store({
      id: waiting?.id ?? randomUUID(),
      name,
      description,
      body,
      agents: current ? current.agents : [agent.id],
      state: 'pending',
      replaces: current?.id,
      proposedBy: agent.id,
      reason: text('motivo') || undefined,
      createdAt: waiting?.createdAt ?? at,
      updatedAt: at
    })
    this.deps.notify?.(`${agent.name} propõe ${current ? 'mudar a skill' : 'uma skill'}`, `${name}: ${description}`)
    return { reply: `Proposta enviada (${current ? 'mudança na skill' : 'skill nova'} "${name}"). Ela só vale depois que o usuário aprovar, na tela de Skills.`, skill: k }
  }

  // A pending proposal becomes the skill (the old version is kept), or goes away.
  decide(id: string, approve: boolean): Skill | undefined {
    const p = this.deps.db.skill(id)
    if (p?.state !== 'pending') return undefined
    if (!approve) return void this.drop(id)
    const target = p.replaces ? this.deps.db.skill(p.replaces) : undefined
    if (target?.state === 'active') {
      this.keep(target, p.proposedBy ?? 'me') // replaced by that agent's proposal
      this.drop(id)
      return this.store({ ...target, description: p.description, body: p.body, updatedAt: this.now() })
    }
    if (this.active(p.name)) throw new Error(`Já existe uma skill chamada ${p.name}.`)
    return this.store({ ...p, state: 'active', replaces: undefined, updatedAt: this.now() })
  }

  // Back to how it was in that version; the current one is kept, so this can be undone too.
  restore(skillId: string, versionId: number): Skill | undefined {
    const k = this.deps.db.skill(skillId)
    const v = this.deps.db.skillVersions(skillId).find((x) => x.id === versionId)
    if (!k || !v) return undefined
    this.keep(k, 'me')
    return this.store({ ...k, name: this.active(v.name, k.id) ? k.name : v.name, description: v.description, body: v.body, updatedAt: this.now() })
  }

  archive(id: string, archived: boolean): Skill | undefined {
    const k = this.deps.db.skill(id)
    if (!k || k.state === 'pending') return undefined
    if (!archived && this.active(k.name, k.id)) throw new Error(`Já existe uma skill chamada ${k.name}.`)
    return this.store({ ...k, state: archived ? 'archived' : 'active', updatedAt: this.now() })
  }

  remove(id: string): void {
    this.drop(id)
  }
}
