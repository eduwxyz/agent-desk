// The report (spec §20): is each agent doing well, is each skill helping,
// and what each piece of work cost. From the last six weeks.
import { useEffect, useState, type ReactNode } from 'react'
import { agentById, loadReport, navigate, useStore, type AgentReport, type Rate, type Report } from '../store'
import { Page } from './Pages'
import { AgentAvatar, Icon, time, tokens } from './ui'

const pct = (r: Rate): string => (r.replies ? `${Math.round((r.ok / r.replies) * 100)}%` : '—')
const seconds = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)

export function ReportPage(): ReactNode {
  const [report, setReport] = useState<Report | null>(null)
  const refresh = (): void => void loadReport().then(setReport)
  useEffect(refresh, [])

  return (
    <Page
      title="Boletim"
      subtitle="Como cada agente está indo nas últimas 6 semanas: quanto termina bem, quanto custa, quantas vezes travou ou teve uma ação recusada por você. E se as skills estão ajudando."
      actions={
        <button className="btn btn--sm" onClick={refresh}>
          Atualizar
        </button>
      }
    >
      {!report ? (
        <p className="muted">Calculando…</p>
      ) : (
        <>
          <div className="report-agents">
            {report.agents.filter((a) => a.total.replies > 0).map((a) => (
              <AgentCard key={a.agentId} report={a} />
            ))}
            {report.agents.every((a) => a.total.replies === 0) && <p className="muted">Nenhuma resposta nas últimas 6 semanas.</p>}
          </div>

          <section className="memory-section">
            <h3 className="section-title">Skills</h3>
            <p className="muted small memory-section__lead">Das respostas que leram a skill, quantas terminaram bem. Depois de uma mudança, o antes e o depois.</p>
            {report.skills.length === 0 ? (
              <p className="muted small">Nenhuma skill em uso.</p>
            ) : (
              <div className="table">
                {report.skills.map((k) => (
                  <div key={k.skillId} className="table__row">
                    <strong className="grow">{k.name}</strong>
                    <span className="small muted">{k.reads.replies} leituras</span>
                    <span className="small">{pct(k.reads)} terminaram bem</span>
                    {k.changedAt && k.before && k.since && k.before.replies + k.since.replies > 0 && (
                      <span className={`small tag ${k.since.replies && k.before.replies ? (k.since.ok / k.since.replies >= k.before.ok / k.before.replies ? 'tag--ok' : 'tag--danger') : ''}`}>
                        mudou {time(k.changedAt)}: {pct(k.before)} → {pct(k.since)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="memory-section">
            <h3 className="section-title">Por tarefa</h3>
            <p className="muted small memory-section__lead">Respostas sobre uma issue (OAB-65, por exemplo, citada na mensagem ou vinda de um gatilho) contam pra ela, inclusive as dos agentes que ela chamou.</p>
            {report.work.length === 0 ? (
              <p className="muted small">Nenhuma resposta ligada a uma issue ainda. Cite a issue na mensagem (ex.: "@staff olha a OAB-65").</p>
            ) : (
              <div className="table">
                {report.work.map((w) => (
                  <div key={w.work} className="table__row">
                    <strong className="mono">{w.work}</strong>
                    <span className="grow row row--center">
                      <Agents ids={w.agents} />
                    </span>
                    <span className="small muted">{w.replies} respostas</span>
                    <span className="small mono">{tokens(w.tokens)} tokens</span>
                    <span className="small muted">{time(w.last)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </Page>
  )
}

function Agents({ ids }: { ids: string[] }): ReactNode {
  const agents = useStore((s) => ids.map((id) => agentById(s, id)).filter((a) => !!a))
  return (
    <>
      {agents.map((a) => (
        <AgentAvatar key={a.id} agent={a} size={18} />
      ))}
    </>
  )
}

function AgentCard({ report: r }: { report: AgentReport }): ReactNode {
  const agent = useStore((s) => agentById(s, r.agentId))
  if (!agent) return null
  const top = Math.max(1, ...r.weeks.map((w) => w.rate.replies))
  return (
    <div className="card report-agent">
      <button className="link row row--center" onClick={() => navigate({ kind: 'agent', id: agent.id })}>
        <AgentAvatar agent={agent} size={22} /> <strong>{agent.name}</strong>
      </button>
      <div className="report-agent__big">
        <strong>{pct(r.total)}</strong>
        <span className="muted small">das {r.total.replies} respostas terminaram bem</span>
      </div>
      <div className="report-agent__weeks" title="Respostas por semana; a parte cheia terminou bem">
        {r.weeks.map((w) => (
          <div key={w.start} className="report-agent__week" title={`Semana de ${new Date(w.start).toLocaleDateString('pt-BR')}: ${w.rate.ok} de ${w.rate.replies} bem, ${tokens(w.avgTokens)} tokens em média`}>
            <i style={{ height: `${(w.rate.replies / top) * 100}%` }}>
              <b style={{ height: w.rate.replies ? `${(w.rate.ok / w.rate.replies) * 100}%` : 0 }} />
            </i>
          </div>
        ))}
      </div>
      <dl className="report-agent__facts small">
        <dt>Custo médio</dt>
        <dd>{tokens(r.avgTokens)} tokens</dd>
        <dt>Tempo médio</dt>
        <dd>{seconds(r.avgMs)}</dd>
        <dt>
          <Icon name="x" size={11} /> Falharam
        </dt>
        <dd>{r.failed}</dd>
        <dt>Cortadas (loop, travou)</dt>
        <dd>{r.cut}</dd>
        <dt>Pausadas no teto</dt>
        <dd>{r.paused}</dd>
        <dt>Aprovações recusadas</dt>
        <dd>
          {r.approvals.refused} de {r.approvals.asked}
        </dd>
      </dl>
    </div>
  )
}
