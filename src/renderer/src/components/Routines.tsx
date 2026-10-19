// Routines (spec §14, §17): requests for an agent that run on their own, at a
// time or when something happens (a new item in a connector, a call on the Mac).
import { useState, type ReactNode } from 'react'
import {
  agentById,
  checkTrigger,
  describeSchedule,
  POLL_MINUTES,
  WEBHOOK_PORT,
  dmWith,
  navigate,
  removeRoutine,
  runRoutine,
  saveRoutine,
  useStore,
  type Message,
  type Routine,
  type RoutineInput,
  type RunStatus,
  type Trigger
} from '../store'
import { Card, Field, Page, Toggle } from './Pages'
import { AgentAvatar, Icon } from './ui'

const DAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S']
const DAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
const WEEKDAYS = [1, 2, 3, 4, 5]
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

const EXAMPLES: { name: string; prompt: string; days: number[]; time: string }[] = [
  { name: 'Bom dia', prompt: 'Me dá um resumo do que está aberto no Linear pra mim: o que venceu, o que vence hoje e o que está parado há mais de uma semana.', days: WEEKDAYS, time: '09:00' },
  { name: 'Fechamento da semana', prompt: 'Resume o que a gente fez nesta semana nesta conversa: decisões, o que ficou pendente e o que eu deveria olhar segunda.', days: [5], time: '17:00' },
  { name: 'Notícias de IA', prompt: 'Tira um print da página inicial do news.ycombinator.com e me diz as 5 notícias sobre IA ou agentes que valem meu tempo, com o porquê em uma linha.', days: EVERY_DAY, time: '08:30' }
]

const LAST: Partial<Record<RunStatus, { label: string; tone: string }>> = {
  working: { label: 'rodando agora', tone: 'tag--agent' },
  done: { label: 'respondeu', tone: 'tag--ok' },
  waiting_approval: { label: 'esperando aprovação', tone: 'tag--warn' },
  waiting_input: { label: 'fez uma pergunta', tone: 'tag--warn' },
  limit_reached: { label: 'parou no limite', tone: 'tag--danger' },
  failed: { label: 'falhou', tone: 'tag--danger' },
  stopped: { label: 'interrompida', tone: '' },
  interrupted: { label: 'interrompida', tone: '' }
}

export const webhookUrl = (token: string): string => `http://127.0.0.1:${WEBHOOK_PORT}/gatilho/${token}`

// "Todo dia às 9h", "A cada 5 min, quando aparecer algo novo em Linear · list_issues"
function describeRoutine(r: Pick<Routine, 'schedule' | 'trigger'>, connectorName?: string): string {
  const t = r.trigger
  if (!t) return describeSchedule(r.schedule)
  if (t.kind === 'webhook') return 'Quando chamada no Mac'
  return `A cada ${t.everyMinutes} min, quando aparecer algo novo em ${connectorName ?? 'um conector'} · ${t.tool}`
}

// "hoje 9:00", "amanhã 9:00", "seg, 20/10 9:00"
export function when(at: number): string {
  const d = new Date(at)
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toDateString()
  if (d.toDateString() === day(0)) return `hoje ${hm}`
  if (d.toDateString() === day(1)) return `amanhã ${hm}`
  if (d.toDateString() === day(-1)) return `ontem ${hm}`
  return `${d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.', '')} ${hm}`
}

type Draft = RoutineInput & { conversationId: string } // '' while the agent's DM doesn't exist yet: created on save

export function RoutinesPage(): ReactNode {
  const routines = useStore((s) => s.routines)
  const agents = useStore((s) => s.agents.filter((a) => !a.archived))
  const [draft, setDraft] = useState<Draft | null>(null)

  const blank = (example?: (typeof EXAMPLES)[number]): Draft => ({
    name: example?.name ?? '',
    prompt: example?.prompt ?? '',
    agentId: agents[0]?.id ?? '',
    conversationId: '',
    schedule: { days: example?.days ?? WEEKDAYS, time: example?.time ?? '09:00' },
    enabled: true
  })

  return (
    <Page
      title="Rotinas"
      subtitle="Agentes que trabalham sozinhos, no horário que você marcar. O resultado aparece na conversa e chega uma notificação. Fechar a janela não para as rotinas; sair do app, sim."
      actions={
        !draft && (
          <button className="btn btn--primary btn--sm" disabled={agents.length === 0} onClick={() => setDraft(blank())}>
            <Icon name="plus" size={14} /> Nova rotina
          </button>
        )
      }
    >
      {draft && <RoutineForm key={draft.id ?? 'new'} draft={draft} onChange={setDraft} onClose={() => setDraft(null)} />}

      {routines.length === 0 && !draft && (
        <div className="empty empty--card">
          <Icon name="clock" size={22} />
          <p>Nenhuma rotina ainda.</p>
          <p className="muted">Comece por um destes exemplos e ajuste:</p>
          <div className="routine-examples">
            {EXAMPLES.map((ex) => (
              <button key={ex.name} className="routine-example" disabled={agents.length === 0} onClick={() => setDraft(blank(ex))}>
                <strong>{ex.name}</strong>
                <span className="muted small">{describeSchedule(ex)}</span>
                <span className="small">{ex.prompt}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {routines.length > 0 && (
        <div className="table routines">
          {routines.map((r) => (
            <RoutineRow key={r.id} routine={r} editing={draft?.id === r.id} onEdit={() => setDraft({ ...r })} />
          ))}
        </div>
      )}
    </Page>
  )
}

// The routine's latest run: its request in the conversation and the agent's reply after it.
function lastRun(messages: Message[], r: Routine): Message | undefined {
  const asks = messages.filter((m) => m.author.kind === 'routine' && m.author.id === r.id)
  const ask = asks[asks.length - 1]
  if (!ask) return undefined
  return messages.find((m) => m.conversationId === ask.conversationId && m.at >= ask.at && m.author.kind === 'agent' && m.author.id === r.agentId)
}

function RoutineRow({ routine: r, editing, onEdit }: { routine: Routine; editing: boolean; onEdit: () => void }): ReactNode {
  const agent = useStore((s) => agentById(s, r.agentId))
  const conv = useStore((s) => s.conversations.find((c) => c.id === r.conversationId))
  const reply = useStore((s) => lastRun(s.messages, r))
  const creator = useStore((s) => (r.createdBy ? agentById(s, r.createdBy) : undefined))
  const connector = useStore((s) => (r.trigger?.kind === 'poll' ? s.connectors.find((c) => c.id === (r.trigger as { connectorId: string }).connectorId) : undefined))
  const [confirm, setConfirm] = useState(false)
  const [copied, setCopied] = useState(false)
  const t = r.trigger
  const status = reply?.run ? LAST[reply.run.status] : undefined
  const where = conv?.kind === 'channel' ? `#${conv.name}` : 'na DM'

  return (
    <div className={`table__row routine ${r.enabled ? '' : 'is-off'} ${editing ? 'is-editing' : ''}`}>
      <Toggle on={r.enabled} onChange={(enabled) => void saveRoutine({ ...r, enabled })} />
      <div className="grow routine__body">
        <div className="row row--center routine__title">
          <strong>{r.name}</strong>
          <span className="muted small">
            {describeRoutine(r, connector?.name)} · {where}
          </span>
        </div>
        <div className="row row--center muted small routine__meta">
          {agent && (
            <button className="link row row--center" onClick={() => navigate({ kind: 'agent', id: agent.id })}>
              <AgentAvatar agent={agent} size={16} /> {agent.name}
            </button>
          )}
          <span>
            ·{' '}
            {!r.enabled
              ? 'desligada'
              : t?.kind === 'poll'
                ? t.checkedAt
                  ? `olhou ${when(t.checkedAt)}`
                  : 'olhando…'
                : t?.kind === 'webhook'
                  ? 'esperando chamada'
                  : r.nextAt
                    ? `próxima ${when(r.nextAt)}`
                    : r.schedule.once && r.lastAt
                      ? 'já rodou'
                      : 'desligada'}
          </span>
          {t?.kind === 'poll' && t.error && <span className="tag tag--danger" title={t.error}>a última olhada falhou</span>}
          {creator && <span>· agendada por {creator.name}</span>}
          {reply && (
            <>
              <span>· última {when(reply.at)}</span>
              {status && <span className={`tag ${status.tone}`}>{status.label}</span>}
              <button className="link" onClick={() => navigate({ kind: 'conversation', id: reply.conversationId })}>
                ver
              </button>
            </>
          )}
        </div>
        <p className="routine__prompt small">{r.prompt}</p>
        {t?.kind === 'webhook' && (
          <div className="row row--center routine__hook">
            <code className="small grow truncate">curl -d "o que aconteceu" {webhookUrl(t.token)}</code>
            <button
              className="btn btn--xs"
              onClick={() => void navigator.clipboard.writeText(`curl -d "o que aconteceu" ${webhookUrl(t.token)}`).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
            >
              {copied ? 'Copiado' : 'Copiar'}
            </button>
          </div>
        )}
      </div>
      <div className="memory__actions">
        {confirm ? (
          <>
            <button className="btn btn--sm btn--danger" onClick={() => removeRoutine(r.id)}>
              Apagar
            </button>
            <button className="btn btn--sm btn--ghost" onClick={() => setConfirm(false)}>
              Cancelar
            </button>
          </>
        ) : (
          <>
            <button className="btn btn--sm" disabled={reply?.run?.status === 'working'} onClick={() => runRoutine(r.id)}>
              Rodar agora
            </button>
            <button className="icon-btn" title="Editar" onClick={onEdit}>
              <Icon name="edit" size={14} />
            </button>
            <button className="icon-btn" title="Apagar" onClick={() => setConfirm(true)}>
              <Icon name="x" size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function RoutineForm({ draft, onChange, onClose }: { draft: Draft; onChange: (d: Draft) => void; onClose: () => void }): ReactNode {
  const agents = useStore((s) => s.agents.filter((a) => !a.archived))
  const conversations = useStore((s) => s.conversations)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const agent = agents.find((a) => a.id === draft.agentId)
  const dm = conversations.find((c) => c.kind === 'dm' && c.name === draft.agentId)
  const channels = conversations.filter((c) => c.kind === 'channel' && c.members.includes(draft.agentId))
  // An empty or stale choice means the agent's DM.
  const target = channels.some((c) => c.id === draft.conversationId) ? draft.conversationId : ''
  const set = (patch: Partial<Draft>): void => onChange({ ...draft, ...patch })
  const days = draft.schedule.days
  const toggleDay = (d: number): void => set({ schedule: { ...draft.schedule, days: days.includes(d) ? days.filter((x) => x !== d) : [...days, d] } })
  const connectors = useStore((s) => s.connectors.filter((c) => c.tools.some((t) => t.cls === 'read' && t.enabled)))
  const t = draft.trigger
  const [argsText, setArgsText] = useState(t?.kind === 'poll' ? JSON.stringify(t.args, null, 1) : '{}')
  const [preview, setPreview] = useState<string | null>(null)
  const pollTrigger = (patch: Partial<Extract<Trigger, { kind: 'poll' }>> = {}): Trigger => {
    const c = connectors.find((x) => x.id === (patch.connectorId ?? (t?.kind === 'poll' ? t.connectorId : ''))) ?? connectors[0]
    const tools = c?.tools.filter((x) => x.cls === 'read' && x.enabled) ?? []
    const prev = t?.kind === 'poll' ? t : undefined
    const tool = tools.some((x) => x.name === (patch.tool ?? prev?.tool)) ? (patch.tool ?? prev!.tool) : (tools.find((x) => /list|search/.test(x.name))?.name ?? tools[0]?.name ?? '')
    return { kind: 'poll', connectorId: c?.id ?? '', tool, args: prev?.args ?? {}, everyMinutes: prev?.everyMinutes ?? 5, ...patch, ...(patch.connectorId ? { tool } : {}) }
  }
  let argsError = ''
  try {
    const parsed: unknown = JSON.parse(argsText || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) argsError = 'Use um objeto JSON, ex.: {"label": "agente"}'
  } catch {
    argsError = 'JSON inválido'
  }
  const withArgs = (x: Trigger | undefined): Trigger | undefined => (x?.kind === 'poll' && !argsError ? { ...x, args: JSON.parse(argsText || '{}') as Record<string, unknown> } : x)
  const test = (): void => {
    const x = withArgs(t)
    if (!x) return
    setPreview('Olhando…')
    checkTrigger(x).then(setPreview, (e: unknown) => setPreview(`Falhou: ${e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e)}`))
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const conversationId = target || dm?.id || (await dmWith(draft.agentId))
      await saveRoutine({ ...draft, trigger: withArgs(draft.trigger), conversationId })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="agent-form routine-form">
      <Card title={draft.id ? 'Editar rotina' : 'Nova rotina'}>
        <div className="grid2">
          <Field label="Nome">
            <input autoFocus value={draft.name} placeholder="Bom dia" onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Agente">
            <select value={draft.agentId} onChange={(e) => set({ agentId: e.target.value, conversationId: '' })}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.role ? ` · ${a.role}` : ''}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="O que fazer" hint="Como você escreveria numa mensagem. Ele usa as ferramentas, os conectores e o computador que já tem.">
          <textarea rows={4} value={draft.prompt} placeholder="Ex.: Me dá um resumo do que está aberto no Linear pra mim." onChange={(e) => set({ prompt: e.target.value })} />
        </Field>
        <Field label="Quando roda">
          <div className="segmented segmented--wide" role="radiogroup" aria-label="Quando roda">
            {(
              [
                ['clock', 'Num horário'],
                ['poll', 'Quando aparece algo novo'],
                ['webhook', 'Quando chamada no Mac']
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={(t?.kind ?? 'clock') === k}
                className={(t?.kind ?? 'clock') === k ? 'is-active' : ''}
                onClick={() => (setPreview(null), set({ trigger: k === 'clock' ? undefined : k === 'poll' ? pollTrigger() : { kind: 'webhook', token: '' } }))}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>
        {t?.kind === 'poll' &&
          (connectors.length === 0 ? (
            <p className="hint">Conecte um conector (Linear, GitHub, Gmail…) primeiro: a rotina olha uma ferramenta de leitura dele.</p>
          ) : (
            <>
              <div className="grid2">
                <Field label="Conector">
                  <select value={t.connectorId} onChange={(e) => (setPreview(null), set({ trigger: pollTrigger({ connectorId: e.target.value }) }))}>
                    {connectors.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Ferramenta de leitura">
                  <select value={t.tool} onChange={(e) => (setPreview(null), set({ trigger: pollTrigger({ tool: e.target.value }) }))}>
                    {connectors
                      .find((c) => c.id === t.connectorId)
                      ?.tools.filter((x) => x.cls === 'read' && x.enabled)
                      .map((x) => (
                        <option key={x.name} value={x.name}>
                          {x.name}
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
              <div className="grid2">
                <Field label="Argumentos (JSON)" hint={argsError || 'O filtro da busca, ex.: {"label": "agente", "state": "Todo"}.'}>
                  <textarea rows={2} className="mono" value={argsText} onChange={(e) => (setPreview(null), setArgsText(e.target.value))} />
                </Field>
                <Field label="Olhar a cada">
                  <select value={t.everyMinutes} onChange={(e) => set({ trigger: pollTrigger({ everyMinutes: Number(e.target.value) }) })}>
                    {POLL_MINUTES.map((m) => (
                      <option key={m} value={m}>
                        {m < 60 ? `${m} min` : '1 hora'}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="row row--center">
                <button type="button" className="btn btn--sm" disabled={!!argsError || !t.tool} onClick={test}>
                  Testar agora
                </button>
                {preview && <span className="small muted grow">{preview}</span>}
              </div>
            </>
          ))}
        {t?.kind === 'webhook' && (
          <p className="hint">
            Depois de salvar, a rotina ganha um endereço no seu Mac (só o próprio Mac acessa). Um script, um hook do git ou uma fase de build do Xcode chama com{' '}
            <code>curl -d "o que aconteceu" …</code>, e o texto enviado chega pro agente.
          </p>
        )}
        {!t && (
          <div className="grid2">
            <Field label="Dias">
              <div className="segmented routine-once" role="radiogroup" aria-label="Repetição">
                {[false, true].map((v) => (
                  <button
                    key={String(v)}
                    type="button"
                    role="radio"
                    aria-checked={!!draft.schedule.once === v}
                    className={!!draft.schedule.once === v ? 'is-active' : ''}
                    onClick={() => set({ schedule: { ...draft.schedule, once: v || undefined, days: v ? EVERY_DAY : draft.schedule.days } })}
                  >
                    {v ? 'Uma vez' : 'Repete'}
                  </button>
                ))}
              </div>
              <div className="row row--center routine-days">
                <div className="days" role="group" aria-label="Dias da semana">
                  {DAYS.map((label, d) => (
                    <button key={d} type="button" title={DAY_NAMES[d]} aria-pressed={days.includes(d)} className={days.includes(d) ? 'is-on' : ''} onClick={() => toggleDay(d)}>
                      {label}
                    </button>
                  ))}
                </div>
                <button type="button" className="link small" onClick={() => set({ schedule: { ...draft.schedule, days: WEEKDAYS } })}>
                  seg a sex
                </button>
                <button type="button" className="link small" onClick={() => set({ schedule: { ...draft.schedule, days: EVERY_DAY } })}>
                  todo dia
                </button>
              </div>
            </Field>
            <Field label="Horário" hint={draft.schedule.once ? 'No próximo dia marcado em que esse horário ainda não passou.' : 'Hora do seu Mac.'}>
              <input type="time" value={draft.schedule.time} onChange={(e) => set({ schedule: { ...draft.schedule, time: e.target.value } })} />
            </Field>
          </div>
        )}
        <Field label="Onde postar">
          <select value={target} onChange={(e) => set({ conversationId: e.target.value })}>
            <option value="">DM com {agent?.name ?? 'o agente'}</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="row row--between">
          <span className="hint">
            {t?.kind === 'poll'
              ? 'O que já existe agora não dispara: ela roda uma vez pra cada item novo, um de cada vez. O agente recebe o item, marcado como vindo de fora.'
              : t?.kind === 'webhook'
                ? 'Roda uma vez por chamada; se ainda estiver rodando, a chamada é recusada.'
                : `${days.length > 0 ? `${describeSchedule(draft.schedule)}.` : 'Escolha pelo menos um dia.'}${draft.schedule.once ? ' Depois de rodar, desliga sozinha.' : ''} Se o app estiver fechado no horário, roda quando abrir (até 12 h depois).`}
          </span>
          <div className="row">
            {error && <span className="field__error">{error}</span>}
            <button className="btn btn--sm btn--ghost" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn btn--sm btn--primary" disabled={saving || !draft.name.trim() || !draft.prompt.trim() || (!t && days.length === 0) || (t?.kind === 'poll' && (!!argsError || !t.tool))} onClick={() => void save()}>
              {draft.id ? 'Salvar' : 'Criar rotina'}
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}
