// Skills (spec §18): recipes the agents follow. Agents propose; I approve,
// edit, and undo any change from the history.
import { useEffect, useState, type ReactNode } from 'react'
import {
  agentById,
  archiveSkill,
  decideSkill,
  linkSkill,
  localSkills,
  navigate,
  removeSkill,
  restoreSkill,
  saveSkill,
  skillVersions,
  useStore,
  type LocalSkill,
  type Skill,
  type SkillInput,
  type SkillVersion
} from '../store'
import { Card, Field, Page } from './Pages'
import { AgentAvatar, Icon, time } from './ui'

export function SkillsPage(): ReactNode {
  const skills = useStore((s) => s.skills)
  const [draft, setDraft] = useState<SkillInput | null>(null)
  const pending = skills.filter((k) => k.state === 'pending')
  const active = skills.filter((k) => k.state === 'active')
  const archived = skills.filter((k) => k.state === 'archived')

  return (
    <Page
      title="Skills"
      subtitle="Receitas que os agentes seguem pra um tipo de tarefa: como rodar os testes, como abrir uma PR, como revisar. Cada agente vê o nome e quando usar, e lê a receita quando a tarefa bate. O que um agente propõe só vale depois que você aprovar."
      actions={
        !draft && (
          <button className="btn btn--primary btn--sm" onClick={() => setDraft({ name: '', description: '', body: '', agents: [] })}>
            <Icon name="plus" size={14} /> Nova skill
          </button>
        )
      }
    >
      {draft && <SkillForm key={draft.id ?? 'new'} draft={draft} onChange={setDraft} onClose={() => setDraft(null)} />}

      {pending.length > 0 && (
        <section className="memory-section">
          <h3 className="section-title">Propostas</h3>
          <p className="muted small memory-section__lead">Dos agentes. Só entram em uso se você aprovar.</p>
          {pending.map((k) => (
            <Proposal key={k.id} proposal={k} />
          ))}
        </section>
      )}

      {active.length === 0 && pending.length === 0 && !draft && (
        <div className="empty empty--card">
          <Icon name="layers" size={22} />
          <p>Nenhuma skill ainda.</p>
          <p className="muted">Escreva uma, ou deixe os agentes proporem: quando resolverem algo em vários passos, eles sugerem guardar o caminho.</p>
        </div>
      )}

      {active.length > 0 && (
        <section className="memory-section">
          <h3 className="section-title">Em uso</h3>
          <div className="table">
            {active.map((k) => (
              <SkillRow key={k.id} skill={k} onEdit={() => setDraft({ id: k.id, name: k.name, description: k.description, body: k.body, agents: k.agents, source: k.source })} />
            ))}
          </div>
        </section>
      )}

      <LocalSkills />

      {archived.length > 0 && (
        <section className="memory-section">
          <h3 className="section-title">Arquivadas</h3>
          <div className="table">
            {archived.map((k) => (
              <div key={k.id} className="table__row memory is-off">
                <div className="grow memory__body">
                  <strong>{k.name}</strong>
                  <span className="muted small">{k.description}</span>
                </div>
                <div className="memory__actions">
                  <button className="btn btn--sm" onClick={() => archiveSkill(k.id, false)}>
                    Reativar
                  </button>
                  <button className="btn btn--sm btn--ghost" onClick={() => removeSkill(k.id)}>
                    Apagar
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </Page>
  )
}

// The skills of the user's Claude Code (and its plugins) and Codex, to link.
function LocalSkills(): ReactNode {
  const skills = useStore((s) => s.skills)
  const [found, setFound] = useState<LocalSkill[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void localSkills().then(setFound, () => setFound([]))
  }, [])
  if (!found || found.length === 0) return null
  return (
    <section className="memory-section">
      <h3 className="section-title">Do seu Claude Code e do Codex</h3>
      <p className="muted small memory-section__lead">
        As skills que você já usa no terminal. Ligada, a skill fica com os agentes que você escolher e é lida direto do arquivo: o que você mudar nela vale na próxima vez.
      </p>
      {error && <p className="note note--error">{error}</p>}
      <div className="table">
        {found.map((l) => {
          const linked = skills.find((k) => k.source === l.source && k.state === 'active')
          return (
            <div key={l.source} className="table__row skill">
              <div className="grow memory__body">
                <div className="row row--center">
                  <strong>{l.name}</strong>
                  <span className="tag">{l.origin}</span>
                  {l.files.length > 0 && <span className="muted small">+ {l.files.length} {l.files.length === 1 ? 'arquivo' : 'arquivos'} de apoio</span>}
                </div>
                <span className="small skill__desc">{l.description}</span>
                {l.scripts && (
                  <span className="small warn-text">
                    <Icon name="terminal" size={12} /> Tem scripts: só roda com um agente que tenha computador (Linux ou este Mac).
                  </span>
                )}
              </div>
              <div className="memory__actions">
                {linked ? (
                  <span className="tag tag--ok">em uso</span>
                ) : (
                  <button className="btn btn--sm" onClick={() => linkSkill(l.source).catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e)))}>
                    Usar
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Agents({ ids }: { ids: string[] }): ReactNode {
  const agents = useStore((s) => ids.map((id) => agentById(s, id)).filter((a) => !!a))
  if (ids.length === 0) return <span className="muted small">todos os agentes</span>
  return (
    <span className="row row--center skill__agents">
      {agents.map((a) => (
        <button key={a.id} className="link row row--center small" onClick={() => navigate({ kind: 'agent', id: a.id })}>
          <AgentAvatar agent={a} size={16} /> {a.name}
        </button>
      ))}
    </span>
  )
}

function SkillRow({ skill: k, onEdit }: { skill: Skill; onEdit: () => void }): ReactNode {
  const [open, setOpen] = useState<'body' | 'history' | null>(null)
  return (
    <div className="table__row skill">
      <div className="grow memory__body">
        <div className="row row--center">
          <strong>{k.name}</strong>
          <Agents ids={k.agents} />
          {k.source ? <span className="tag" title={k.source}>do seu {k.source.includes('/.codex/') ? 'Codex' : 'Claude Code'}</span> : <span className="muted small">· mudou {time(k.updatedAt)}</span>}
        </div>
        <span className="small">{k.description}</span>
        {open === 'body' && <pre className="skill__body">{k.body}</pre>}
        {open === 'history' && <History skill={k} />}
      </div>
      <div className="memory__actions">
        <button className="btn btn--sm btn--ghost" onClick={() => setOpen(open === 'body' ? null : 'body')}>
          {open === 'body' ? 'Fechar' : 'Ver receita'}
        </button>
        {!k.source && (
          <button className="btn btn--sm btn--ghost" onClick={() => setOpen(open === 'history' ? null : 'history')}>
            Histórico
          </button>
        )}
        <button className="icon-btn" title="Editar" onClick={onEdit}>
          <Icon name="edit" size={14} />
        </button>
        <button className="icon-btn" title="Arquivar" onClick={() => archiveSkill(k.id, true)}>
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  )
}

function History({ skill }: { skill: Skill }): ReactNode {
  const [versions, setVersions] = useState<SkillVersion[] | null>(null)
  const [showing, setShowing] = useState<number | null>(null)
  const who = useStore((s) => (by: string) => (by === 'me' ? s.me.name : (agentById(s, by)?.name ?? 'agente')))
  useEffect(() => {
    void skillVersions(skill.id).then(setVersions)
  }, [skill.id, skill.updatedAt])
  if (!versions) return <p className="muted small">Carregando…</p>
  if (versions.length === 0) return <p className="muted small">Nenhuma mudança ainda: esta é a primeira versão.</p>
  return (
    <div className="skill__history">
      {versions.map((v) => (
        <div key={v.id}>
          <div className="row row--center small">
            <span className="grow">
              Antes de {time(v.at)} <span className="muted">· {v.by === 'me' ? `mudada por ${who(v.by)}` : `mudada por uma proposta de ${who(v.by)}`}</span>
            </span>
            <button className="link small" onClick={() => setShowing(showing === v.id ? null : v.id)}>
              {showing === v.id ? 'esconder' : 'o que mudou'}
            </button>
            <button className="btn btn--xs" onClick={() => restoreSkill(skill.id, v.id)}>
              Voltar a esta
            </button>
          </div>
          {showing === v.id && <Diff before={`${v.description}\n\n${v.body}`} after={`${skill.description}\n\n${skill.body}`} />}
        </div>
      ))}
    </div>
  )
}

function Proposal({ proposal: p }: { proposal: Skill }): ReactNode {
  const agent = useStore((s) => (p.proposedBy ? agentById(s, p.proposedBy) : undefined))
  const current = useStore((s) => (p.replaces ? s.skills.find((k) => k.id === p.replaces) : undefined))
  return (
    <Card
      title={current ? `Mudar ${p.name}` : `Nova: ${p.name}`}
      lead={`${agent?.name ?? 'Um agente'} propôs ${time(p.createdAt)}${p.reason ? `: "${p.reason}"` : '.'}`}
      action={
        <div className="row">
          <button className="btn btn--sm btn--primary" onClick={() => decideSkill(p.id, true)}>
            Aprovar
          </button>
          <button className="btn btn--sm btn--ghost" onClick={() => decideSkill(p.id, false)}>
            Recusar
          </button>
        </div>
      }
    >
      {current ? (
        <Diff before={`${current.description}\n\n${current.body}`} after={`${p.description}\n\n${p.body}`} />
      ) : (
        <>
          <p className="small">
            <strong>Quando usar:</strong> {p.description}
          </p>
          <pre className="skill__body">{p.body}</pre>
          <p className="muted small">
            Vale pra: <Agents ids={p.agents} />. Depois de aprovar, dá pra liberar pra outros agentes editando.
          </p>
        </>
      )}
    </Card>
  )
}

// Line by line: what was removed and what was added.
function Diff({ before, after }: { before: string; after: string }): ReactNode {
  const a = before.split('\n')
  const b = after.split('\n')
  // Longest common subsequence, enough for recipes of a few hundred lines.
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const lines: { kind: ' ' | '-' | '+'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    // Removed lines before the ones that replace them.
    if (i < n && j < m && a[i] === b[j]) lines.push({ kind: ' ', text: a[i++]! }), j++
    else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) lines.push({ kind: '-', text: a[i++]! })
    else lines.push({ kind: '+', text: b[j++]! })
  }
  return (
    <pre className="diff">
      {lines.map((l, k) => (
        <div key={k} className={l.kind === '+' ? 'diff__add' : l.kind === '-' ? 'diff__del' : 'diff__same'}>
          {l.kind} {l.text}
        </div>
      ))}
    </pre>
  )
}

function SkillForm({ draft, onChange, onClose }: { draft: SkillInput; onChange: (d: SkillInput) => void; onClose: () => void }): ReactNode {
  const agents = useStore((s) => s.agents.filter((a) => !a.archived))
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<SkillInput>): void => onChange({ ...draft, ...patch })
  const toggle = (id: string): void => set({ agents: draft.agents.includes(id) ? draft.agents.filter((x) => x !== id) : [...draft.agents, id] })
  const save = (): void => {
    setError(null)
    saveSkill(draft).then(onClose, (e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e)))
  }
  return (
    <div className="agent-form">
      <Card title={draft.id ? `Editar ${draft.name}` : 'Nova skill'}>
        <div className="grid2">
          <Field label="Nome" hint="Curto, vira algo como testes-do-core.">
            <input autoFocus value={draft.name} placeholder="testes do core" onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Quando usar" hint="Uma frase. Vai no prompt de cada agente.">
            <input value={draft.description} placeholder="Ao rodar ou consertar os testes do Core" onChange={(e) => set({ description: e.target.value })} />
          </Field>
        </div>
        {draft.source ? (
          <p className="hint">
            Ligada a <span className="mono">{draft.source}</span>: a receita muda lá, e os agentes leem sempre a versão de agora. Aqui você escolhe quem usa.
          </p>
        ) : (
          <Field label="Receita" hint="Os passos, em Markdown: comandos exatos, armadilhas, como conferir.">
            <textarea rows={10} className="mono" value={draft.body} onChange={(e) => set({ body: e.target.value })} />
          </Field>
        )}
        <Field label="Pra quem">
          <div className="row row--center skill__pick">
            <button type="button" className={`chip ${draft.agents.length === 0 ? 'is-on' : ''}`} onClick={() => set({ agents: [] })}>
              Todos
            </button>
            {agents.map((a) => (
              <button key={a.id} type="button" className={`chip ${draft.agents.includes(a.id) ? 'is-on' : ''}`} onClick={() => toggle(a.id)}>
                {a.name}
              </button>
            ))}
          </div>
        </Field>
        <div className="row row--between">
          <span className="hint">{draft.id ? 'A versão de agora fica no histórico: dá pra voltar.' : ''}</span>
          <div className="row">
            {error && <span className="field__error">{error}</span>}
            <button className="btn btn--sm btn--ghost" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn btn--sm btn--primary" disabled={!draft.source && (!draft.name.trim() || !draft.description.trim() || !draft.body.trim())} onClick={save}>
              {draft.id ? 'Salvar' : 'Criar skill'}
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}
