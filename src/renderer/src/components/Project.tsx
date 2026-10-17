// A channel's project (spec §15): the folder, the context every agent gets,
// and who gets the folder on their computer.
import { useEffect, useState, type ReactNode } from 'react'
import { navigate, projectScope, setProject, useStore, type Agent, type Conversation, type Project } from '../store'
import { AgentAvatar, Icon } from './ui'

const ACCESS: { value: 'none' | 'read_only' | 'read_write'; label: string }[] = [
  { value: 'none', label: 'Sem pasta' },
  { value: 'read_only', label: 'Só ler' },
  { value: 'read_write', label: 'Pode mudar' }
]

export function ProjectPanel({ conv, members, onClose }: { conv: Conversation; members: Agent[]; onClose: () => void }): ReactNode {
  const p = conv.project
  const memories = useStore((s) => s.memories.filter((m) => m.scope === projectScope(conv.id) && m.state === 'active').length)
  const [files, setFiles] = useState(p?.files.join('\n') ?? '')
  const [brief, setBrief] = useState(p?.brief ?? '')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setFiles(p?.files.join('\n') ?? '')
    setBrief(p?.brief ?? '')
  }, [p?.folder, p?.files.join('\n'), p?.brief])

  const save = (patch: Partial<Project>, pick = false): void =>
    void setProject(conv.id, p ? { ...p, ...patch } : null, pick).then(setError)
  const changed = !!p && (files.trim() !== p.files.join('\n') || brief.trim() !== p.brief)

  return (
    <div className="summary project">
      <div className="summary__head">
        <strong>Projeto</strong>
        {p && <code className="project__folder">{p.folder.replace(/^\/Users\/[^/]+/, '~')}</code>}
        <span className="grow" />
        <button className="btn btn--sm" onClick={() => save({}, true)}>
          {p ? 'Trocar pasta…' : 'Escolher pasta…'}
        </button>
        {p && (
          <button className="btn btn--sm btn--ghost" onClick={() => void setProject(conv.id, null).then(setError)}>
            Desligar
          </button>
        )}
        <button className="icon-btn" title="Fechar" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {error && <p className="field__error">{error}</p>}

      {!p ? (
        <p className="muted small">
          Ligue este canal a uma pasta do Mac e ele vira um projeto: todo agente daqui passa a receber os arquivos de contexto do projeto (CLAUDE.md, AGENTS.md, README.md…) e as decisões guardadas, e quem tem computador pode receber a própria pasta.
        </p>
      ) : (
        <>
          <div className="grid2">
            <label className="field">
              <span className="field__label">Arquivos de contexto</span>
              <textarea rows={4} value={files} placeholder={'CLAUDE.md\nAGENTS.md\nREADME.md'} onChange={(e) => setFiles(e.target.value)} />
              <span className="hint">Um por linha, relativos à pasta. Lidos de novo a cada resposta, então o repositório continua sendo a fonte.</span>
            </label>
            <label className="field">
              <span className="field__label">O momento</span>
              <textarea rows={4} value={brief} placeholder="Objetivo atual, prioridades, prazos: o que não está no repositório." onChange={(e) => setBrief(e.target.value)} />
              <span className="hint">
                {memories > 0 ? (
                  <>
                    Mais {memories} decisões na{' '}
                    <button className="link" onClick={() => navigate({ kind: 'memory' })}>
                      memória do projeto
                    </button>
                    .
                  </>
                ) : (
                  'Decisões que os agentes guardarem aparecem na memória do projeto.'
                )}
              </span>
            </label>
          </div>
          {changed && (
            <div className="row row--between">
              <span className="hint">Vale a partir da próxima resposta.</span>
              <button className="btn btn--sm btn--primary" onClick={() => save({ files: files.split('\n'), brief })}>
                Salvar contexto
              </button>
            </div>
          )}
          <div className="table project__access">
            {members.map((a) => {
              const access = p.access[a.id] ?? 'none'
              return (
                <div key={a.id} className="table__row">
                  <AgentAvatar agent={a} size={20} />
                  <span className="grow">
                    <strong>{a.name}</strong> <span className="muted small">{a.role}</span>
                  </span>
                  {a.computer ? (
                    <div className="segmented" role="radiogroup" aria-label={`Pasta pra ${a.name}`}>
                      {ACCESS.map((o) => (
                        <button
                          key={o.value}
                          role="radio"
                          aria-checked={access === o.value}
                          className={access === o.value ? 'is-active' : ''}
                          onClick={() => {
                            const { [a.id]: _, ...rest } = p.access
                            save({ access: o.value === 'none' ? rest : { ...rest, [a.id]: o.value } })
                          }}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="muted small">sem computador · recebe o contexto</span>
                  )}
                </div>
              )
            })}
          </div>
          <p className="hint">Mudar a pasta de alguém reinicia o computador dele: os serviços param, o que ele instalou fica.</p>
        </>
      )}
    </div>
  )
}
