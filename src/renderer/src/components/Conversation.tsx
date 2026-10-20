import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  agentById,
  conversationTitle,
  decideApproval,
  decideMemory,
  describeSchedule,
  editSummary,
  ENGINES,
  forgetMemory,
  modelById,
  navigate,
  openDm,
  removeRoutine,
  retryRun,
  continueRun,
  ACCESS_REQUEST,
  countedTokens,
  sendMessage,
  stopRun,
  summarizeNow,
  useStore,
  SUMMARY_MAX_AFTER,
  SUMMARY_WINDOW,
  type Agent,
  type Approval,
  type Conversation,
  type Message,
  type Step
} from '../store'
import { AgentAvatar, Icon, MeAvatar, duration, time, tokens, usd } from './ui'
import { ArtifactCard, BrowserCard, ServiceCard, SidePanel } from './Panel'
import { when } from './Routines'
import { ProjectPanel } from './Project'

export function ConversationView({ id }: { id: string }): ReactNode {
  const conv = useStore((s) => s.conversations.find((c) => c.id === id))
  const title = useStore((s) => (conv ? conversationTitle(s, conv) : ''))
  const members = useStore((s) => (conv ? conv.members.map((m) => agentById(s, m)).filter((a): a is Agent => !!a) : []))
  const messages = useStore((s) => s.messages.filter((m) => m.conversationId === id))
  const [showSummary, setShowSummary] = useState(false)
  const [showProject, setShowProject] = useState(false)

  if (!conv) return <div className="empty">Conversa não encontrada.</div>
  const dmAgent = conv.kind === 'dm' ? members[0] : undefined

  return (
    <div className="split">
      <section className="conversation">
        <header className="topbar">
          <div className="topbar__title">
            {dmAgent ? <AgentAvatar agent={dmAgent} size={22} /> : <Icon name="hash" />}
            <h1>{title}</h1>
            {dmAgent && <span className="tag">{dmAgent.role}</span>}
            {conv.topic && <span className="topbar__topic">{conv.topic}</span>}
            {conv.project && <span className="tag tag--agent">projeto</span>}
          </div>
          <div className="topbar__actions">
            {conv.kind === 'channel' && (
              <div className="stack" title="Agentes no canal">
                {members.map((a) => (
                  <button key={a.id} className="stack__item" onClick={() => navigate({ kind: 'agent', id: a.id })} title={a.name}>
                    <AgentAvatar agent={a} size={24} />
                  </button>
                ))}
                <span className="stack__count">{members.length} agente{members.length === 1 ? '' : 's'}</span>
              </div>
            )}
            {conv.kind === 'channel' && (
              <button className={`btn btn--ghost ${showProject ? 'is-active' : ''}`} title="Pasta e contexto do projeto deste canal" onClick={() => setShowProject(!showProject)}>
                <Icon name="folder" size={14} /> Projeto
              </button>
            )}
            <button className={`btn btn--ghost ${showSummary ? 'is-active' : ''}`} title="O que esta conversa já cobriu" onClick={() => setShowSummary(!showSummary)}>
              <Icon name="book" size={14} /> Resumo
            </button>
            {dmAgent && (
              <button className="btn btn--ghost" onClick={() => navigate({ kind: 'agent', id: dmAgent.id })}>
                Ver perfil
              </button>
            )}
          </div>
        </header>

        {showProject && <ProjectPanel conv={conv} members={members} onClose={() => setShowProject(false)} />}
        {showSummary && <SummaryPanel conv={conv} messages={messages} onClose={() => setShowSummary(false)} />}

        <MessageList messages={messages} conversationId={id} />
        <Composer conversationId={id} members={members} placeholder={dmAgent ? `Mensagem para ${dmAgent.name}` : `Mensagem em #${title}`} />
      </section>
      <SidePanel />
    </div>
  )
}

function MessageList({ messages, conversationId }: { messages: Message[]; conversationId: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    stick.current = true
  }, [conversationId])

  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  if (messages.length === 0) {
    return (
      <div className="messages messages--empty">
        <div className="empty">
          <Icon name="spark" size={22} />
          <p>Nada por aqui ainda.</p>
          <p className="muted">Mencione um agente com @ ou escreva e deixe o router decidir quem responde.</p>
        </div>
      </div>
    )
  }

  return (
    <div
      className="messages"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      }}
    >
      {messages.map((m, i) => {
        const prev = messages[i - 1]
        const grouped =
          !!prev &&
          prev.author.kind === m.author.kind &&
          (m.author.kind !== 'agent' || (prev.author.kind === 'agent' && prev.author.id === m.author.id)) &&
          m.at - prev.at < 5 * 60_000 &&
          !m.run &&
          m.author.kind !== 'system' &&
          m.author.kind !== 'routine'
        return <MessageRow key={m.id} message={m} grouped={grouped} />
      })}
    </div>
  )
}

function MessageRow({ message, grouped }: { message: Message; grouped: boolean }): ReactNode {
  const me = useStore((s) => s.me)
  const agent = useStore((s) => (message.author.kind === 'agent' ? agentById(s, message.author.id) : undefined))
  const approval = useStore((s) => (message.run?.approvalId ? s.approvals.find((a) => a.id === message.run!.approvalId) : undefined))
  // The browser shows live on the agent's latest message that used it, unless it's open on the side.
  const liveBrowser = useStore(
    (s) =>
      !!message.run?.browser &&
      !(s.panel?.kind === 'browser' && s.panel.agentId === agent?.id) &&
      s.messages.findLast((m) => m.conversationId === message.conversationId && m.run?.browser && m.author.kind === 'agent' && m.author.id === agent?.id)?.id === message.id
  )

  if (message.author.kind === 'system') {
    return (
      <div className={`system-line ${message.run?.status === 'working' ? 'is-pending' : ''}`}>
        <Icon name="spark" size={13} />
        <Markdown>{message.text}</Markdown>
        <span className="muted">{time(message.at)}</span>
      </div>
    )
  }

  if (message.author.kind === 'routine') return <RoutineMessage message={message} />

  const name = agent ? agent.name : me.name
  return (
    <article className={`msg ${grouped ? 'msg--grouped' : ''}`}>
      <div className="msg__gutter">
        {!grouped && (agent ? <AgentAvatar agent={agent} size={34} /> : <MeAvatar initials={me.initials} size={34} />)}
      </div>
      <div className="msg__body">
        {!grouped && (
          <div className="msg__head">
            {agent ? (
              <button className="msg__author link" onClick={() => navigate({ kind: 'agent', id: agent.id })}>
                {name}
              </button>
            ) : (
              <span className="msg__author">{name}</span>
            )}
            {agent && <span className="tag tag--agent">agente</span>}
            {agent?.computer && agent.computerKind === 'mac' && (
              <span className="tag tag--warn" title="Os comandos deste agente rodam direto no seu Mac">
                no seu Mac
              </span>
            )}
            <span className="msg__time">{time(message.at)}</span>
          </div>
        )}
        {message.run && <RunSteps message={message} />}
        {message.text ? (
          <div className="md">
            <Markdown remarkPlugins={[remarkGfm]}>{highlightMentions(message.text)}</Markdown>
          </div>
        ) : message.run?.status === 'working' ? (
          <div className="typing">
            <i />
            <i />
            <i />
          </div>
        ) : null}
        {message.run?.question && <QuestionCard question={message.run.question} answered={message.run.status !== 'waiting_input'} />}
        {approval && <ApprovalCard approval={approval} />}
        {message.run?.memoryIds?.map((mid) => <MemoryChip key={mid} id={mid} />)}
        {message.run?.routineIds?.map((rid) => <RoutineChip key={rid} id={rid} />)}
        {message.run?.artifactIds && (
          <div className="artifacts">
            {message.run.artifactIds.map((aid) => (
              <ArtifactCard key={aid} id={aid} />
            ))}
          </div>
        )}
        {agent && message.run?.services?.map((name) => <ServiceCard key={name} agentId={agent.id} name={name} />)}
        {agent && message.run?.browser && <BrowserCard agentId={agent.id} big={liveBrowser} />}
        {message.run?.status === 'stopped' && <div className="note">Interrompido por você.</div>}
        {message.run?.status === 'interrupted' && <div className="note">Interrompido: o app fechou no meio da resposta.</div>}
        {message.run?.error && <div className="note note--error">{message.run.error}</div>}
        {message.run?.status === 'paused' && (
          <>
            <div className="note">Pausei: cheguei no teto desta resposta ({tokens(message.run.budget ?? 0)} tokens). Continuo de onde parei?</div>
            <button className="btn btn--xs retry" onClick={() => continueRun(message.id)}>
              Continuar
            </button>
          </>
        )}
        {message.run && ['failed', 'stopped', 'interrupted', 'limit_reached'].includes(message.run.status) && (
          <button className="btn btn--xs retry" onClick={() => retryRun(message.id)}>
            Tentar de novo
          </button>
        )}
        {message.run?.receipt && <ReceiptLine receipt={message.run.receipt} />}
      </div>
    </article>
  )
}

// What a routine asked, posted at its time; the agent's reply comes next.
function RoutineMessage({ message }: { message: Message }): ReactNode {
  const exists = useStore((s) => s.routines.some((r) => message.author.kind === 'routine' && r.id === message.author.id))
  const info = message.routine
  return (
    <article className="msg msg--routine">
      <div className="msg__gutter">
        <span className="avatar avatar--routine" style={{ width: 34, height: 34 }}>
          <Icon name="clock" size={17} />
        </span>
      </div>
      <div className="msg__body">
        <div className="msg__head">
          {exists ? (
            <button className="msg__author link" onClick={() => navigate({ kind: 'routines' })}>
              {info?.name ?? 'Rotina'}
            </button>
          ) : (
            <span className="msg__author">{info?.name ?? 'Rotina'}</span>
          )}
          <span className="tag">rotina</span>
          {info?.late && <span className="tag tag--warn">atrasada · era {time(info.scheduledAt)}</span>}
          <span className="msg__time">{time(message.at)}</span>
        </div>
        {info?.event && (
          <div className="note routine-event">
            <Icon name="zap" size={12} /> {info.event.source}: <strong>{info.event.title}</strong>
          </div>
        )}
        <div className="md">
          <Markdown remarkPlugins={[remarkGfm]}>{highlightMentions(message.text)}</Markdown>
        </div>
      </div>
    </article>
  )
}

function SummaryPanel({ conv, messages, onClose }: { conv: Conversation; messages: Message[]; onClose: () => void }): ReactNode {
  const [text, setText] = useState(conv.summary ?? '')
  const [asked, setAsked] = useState<number | null>(null)
  useEffect(() => setText(conv.summary ?? ''), [conv.summary, conv.summaryAt])
  useEffect(() => {
    if (asked === null) return
    const t = setTimeout(() => setAsked(null), 120_000) // give up waiting; the core logs failures
    return () => clearTimeout(t)
  }, [asked])
  const busy = asked !== null && (conv.summaryAt ?? 0) < asked
  const since = messages.filter((m) => m.author.kind !== 'system' && m.text.trim() && m.at > (conv.summaryUntil ?? 0)).length
  const changed = text.trim() !== (conv.summary ?? '').trim()

  return (
    <div className="summary">
      <div className="summary__head">
        <strong>Resumo da conversa</strong>
        <span className="muted small">{conv.summaryAt ? `atualizado ${time(conv.summaryAt)}` : 'ainda não há'}</span>
        <span className="grow" />
        <button
          className="btn btn--sm"
          disabled={busy || since <= SUMMARY_WINDOW}
          title={since <= SUMMARY_WINDOW ? `As últimas ${SUMMARY_WINDOW} mensagens sempre vão inteiras; ainda não há o que resumir.` : undefined}
          onClick={() => {
            setAsked(Date.now())
            summarizeNow(conv.id)
          }}
        >
          {busy ? 'Resumindo…' : 'Resumir agora'}
        </button>
        <button className="icon-btn" title="Fechar" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {conv.summary !== undefined || changed ? (
        <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <p className="muted small">
          Quando passar de {SUMMARY_MAX_AFTER} mensagens, o que sair da janela vira um resumo aqui, e os agentes recebem o resumo mais as mensagens recentes.
        </p>
      )}
      <div className="row row--between">
        <span className="hint">
          Os agentes recebem {conv.summary ? 'este resumo e ' : ''}as {since} mensagens {conv.summary ? 'desde ele' : 'da conversa'}.
        </span>
        {changed && (
          <button className="btn btn--sm btn--primary" onClick={() => editSummary(conv.id, text)}>
            Salvar resumo
          </button>
        )}
      </div>
    </div>
  )
}

// A memory saved or proposed in this reply, with what I can do about it.
function MemoryChip({ id }: { id: string }): ReactNode {
  const memory = useStore((s) => s.memories.find((m) => m.id === id))
  if (!memory) return null // discarded or deleted
  const label = { active: 'Guardou', pending: 'Quer guardar', archived: 'Guardou (depois atualizada)', forgotten: 'Esquecida' }[memory.state]
  return (
    <div className={`memory-chip memory-chip--${memory.state}`}>
      <Icon name="book" size={13} />
      <span className="memory-chip__label">{label}:</span>
      <span className="memory-chip__text">{memory.text}</span>
      {memory.scope !== 'me' && <span className="tag">nota dele</span>}
      {memory.state === 'active' && (
        <button className="link" onClick={() => forgetMemory(id)}>
          Desfazer
        </button>
      )}
      {memory.state === 'pending' && (
        <>
          <button className="btn btn--xs btn--primary" onClick={() => decideMemory(id, true)}>
            Guardar
          </button>
          <button className="btn btn--xs btn--ghost" onClick={() => decideMemory(id, false)}>
            Descartar
          </button>
        </>
      )}
    </div>
  )
}

// A routine the agent scheduled in this reply.
function RoutineChip({ id }: { id: string }): ReactNode {
  const r = useStore((s) => s.routines.find((x) => x.id === id))
  if (!r) return null // deleted
  const state = r.enabled && r.nextAt ? `próxima ${when(r.nextAt)}` : r.schedule.once && r.lastAt ? 'já rodou' : 'desligada'
  return (
    <div className="memory-chip routine-chip">
      <Icon name="clock" size={13} />
      <span className="memory-chip__label">Agendou:</span>
      <span className="memory-chip__text">{r.name}</span>
      <span className="muted small">
        {describeSchedule(r.schedule)} · {state}
      </span>
      <button className="link" onClick={() => navigate({ kind: 'routines' })}>
        Ver
      </button>
      <button className="link" onClick={() => removeRoutine(id)}>
        Desfazer
      </button>
    </div>
  )
}

function QuestionCard({ question, answered }: { question: string; answered: boolean }): ReactNode {
  return (
    <div className={`question ${answered ? 'is-answered' : ''}`}>
      <span className="question__label">{answered ? 'Perguntou' : 'Pergunta pra você'}</span>
      <p>{question}</p>
      {!answered && <span className="hint">Sua próxima mensagem aqui é a resposta.</span>}
    </div>
  )
}

const highlightMentions = (text: string): string => text.replace(/(^|\s)@([a-z0-9_-]{2,32})/gi, '$1**@$2**')

function RunSteps({ message }: { message: Message }): ReactNode {
  const run = message.run!
  const [open, setOpen] = useState(run.status === 'working' || run.status === 'waiting_approval')
  useEffect(() => {
    if (run.status === 'working') setOpen(true)
  }, [run.status])

  if (run.steps.length === 0 && run.status !== 'working') return null
  const total = run.steps.reduce((acc, st) => acc + (st.ms ?? 0), 0)
  const working = run.status === 'working'

  return (
    <div className={`steps ${open ? 'is-open' : ''}`}>
      <button className="steps__toggle" onClick={() => setOpen(!open)}>
        <span className="steps__chev">
          <Icon name="chevron" size={12} />
        </span>
        {working ? (
          <span className="shimmer">Trabalhando…</span>
        ) : (
          <span>
            {run.steps.length} passo{run.steps.length === 1 ? '' : 's'}
            {total > 0 && ` · ${duration(total)}`}
          </span>
        )}
        {working && (
          <span
            className="btn btn--xs btn--ghost steps__stop"
            role="button"
            onClick={(e) => {
              e.stopPropagation()
              stopRun(message.id)
            }}
          >
            <Icon name="stop" size={11} /> Parar
          </span>
        )}
      </button>
      {open && (
        <ol className="steps__list">
          {run.steps.map((st) => (
            <StepRow key={st.id} step={st} />
          ))}
        </ol>
      )}
    </div>
  )
}

function StepRow({ step }: { step: Step }): ReactNode {
  return (
    <li className={`step step--${step.status}`}>
      <span className="step__icon">
        {step.status === 'running' ? <span className="spinner" /> : <Icon name={step.status === 'done' ? 'check' : 'x'} size={12} />}
      </span>
      <span className="step__label">{step.label}</span>
      {step.note ? <span className="step__note">{step.note}</span> : step.detail && <code className="step__detail">{step.detail}</code>}
      {step.ms !== undefined && <span className="step__ms">{duration(step.ms)}</span>}
    </li>
  )
}

function ReceiptLine({ receipt }: { receipt: NonNullable<NonNullable<Message['run']>['receipt']> }): ReactNode {
  const model = useStore((s) => modelById(s, receipt.model))
  const [open, setOpen] = useState(false)
  const total = countedTokens(receipt)
  return (
    <div className="receipt">
      <button className="receipt__line" onClick={() => setOpen(!open)} title="Ver recibo">
        {model?.label ?? receipt.model} · {tokens(total)} tokens · {duration(receipt.ms)}
      </button>
      {open && (
        <dl className="receipt__table">
          <dt>Entrada</dt>
          <dd>{tokens(receipt.inputTokens - receipt.cacheReadTokens)}</dd>
          <dt title="Ler do cache custa cerca de um décimo: conta 10% no limite.">Do cache (conta 10%)</dt>
          <dd>{tokens(receipt.cacheReadTokens)}</dd>
          <dt>Saída</dt>
          <dd>{tokens(receipt.outputTokens)}</dd>
          <dt>Motor</dt>
          <dd>{model ? ENGINES[model.engine].label : '—'}</dd>
          {receipt.apiCostUsd !== undefined && (
            <>
              <dt title="O que esse uso custaria na API. Na assinatura, não é cobrado.">Equivalente na API</dt>
              <dd>{usd(receipt.apiCostUsd)}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  )
}

export function ApprovalCard({ approval, compact }: { approval: Approval; compact?: boolean }): ReactNode {
  const agent = useStore((s) => agentById(s, approval.agentId))
  const me = useStore((s) => s.me)
  const [refusing, setRefusing] = useState(false)
  const [reason, setReason] = useState('')
  const [hold, setHold] = useState(0)
  const timer = useRef<number | null>(null)

  const startHold = (): void => {
    const started = performance.now()
    const tick = (): void => {
      const p = Math.min(1, (performance.now() - started) / 1500)
      setHold(p)
      if (p >= 1) {
        timer.current = null
        decideApproval(approval.id, 'approved')
        return
      }
      timer.current = requestAnimationFrame(tick)
    }
    timer.current = requestAnimationFrame(tick)
  }
  const cancelHold = (): void => {
    if (timer.current) cancelAnimationFrame(timer.current)
    timer.current = null
    setHold(0)
  }

  const decided = approval.state !== 'pending'

  return (
    <div className={`approval approval--${approval.state} ${compact ? 'approval--compact' : ''}`}>
      <div className="approval__head">
        <span className="approval__badge">
          <Icon name="shield" size={13} />
          {approval.state === 'pending' ? 'Esperando você' : approval.state === 'approved' ? 'Aprovado' : approval.state === 'refused' ? 'Recusado' : 'Expirado'}
        </span>
        {approval.highRisk && <span className="tag tag--danger">alto risco</span>}
      </div>
      <div className="approval__title">
        {approval.tool === ACCESS_REQUEST ? (
          <>
            {agent?.name ?? 'Agente'} pede acesso ao <strong>{approval.connectorName}</strong>: {approval.args['nivel'] === 'read_write' ? 'ler e escrever' : 'ler'}
          </>
        ) : approval.tool === 'abrir_pr' ? (
          <>
            {agent?.name ?? 'Agente'} quer abrir uma <strong>pull request</strong> em {String(approval.args['repo'])}
          </>
        ) : approval.connectorId === 'navegador' ? (
          <>
            {agent?.name ?? 'Agente'} quer clicar em <strong>{String(approval.args['alvo'] || 'um ponto da tela')}</strong> em {String(approval.args['url']).replace(/^https?:\/\//, '').slice(0, 60)}
          </>
        ) : (
          <>
            {agent?.name ?? 'Agente'} quer usar <strong>{approval.tool.replace(/_/g, ' ')}</strong> no {approval.connectorName}
          </>
        )}
      </div>
      {approval.why && <p className="approval__why">{approval.why}</p>}
      <div className="approval__call">
        <code>
          {approval.connectorName} · {approval.tool}
        </code>
        <pre>{JSON.stringify(approval.args, null, 2)}</pre>
      </div>
      <p className="approval__bound">
        A aprovação cobre só esta chamada, com estes valores. Se mudar qualquer coisa, o agente pede de novo.
        {!decided && ` Expira ${time(approval.expiresAt)}.`}
      </p>

      {decided ? (
        <div className="approval__decided">
          {approval.state === 'expired' ? 'Expirou sem decisão' : `${approval.state === 'approved' ? 'Aprovado' : 'Recusado'} por ${me.name}`}
          {approval.decidedAt ? ` · ${time(approval.decidedAt)}` : ''}
          {approval.reason ? ` · “${approval.reason}”` : ''}
          {approval.outcome ? ` · ${approval.outcome}` : ''}
        </div>
      ) : refusing ? (
        <form
          className="approval__refuse"
          onSubmit={(e) => {
            e.preventDefault()
            decideApproval(approval.id, 'refused', reason.trim() || undefined)
          }}
        >
          <textarea
            autoFocus
            rows={2}
            value={reason}
            placeholder={`Por que não? ${agent?.name ?? 'O agente'} lê e ajusta o plano.`}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="row">
            <button type="button" className="btn btn--ghost" onClick={() => setRefusing(false)}>
              Cancelar
            </button>
            <button type="submit" className="btn btn--danger">
              Recusar
            </button>
          </div>
        </form>
      ) : (
        <div className="row">
          {approval.highRisk ? (
            <button
              className="btn btn--primary btn--hold"
              onPointerDown={startHold}
              onPointerUp={cancelHold}
              onPointerLeave={cancelHold}
              style={{ ['--hold' as string]: `${hold * 100}%` }}
            >
              <span>{hold > 0 ? 'Segure…' : 'Segure para aprovar'}</span>
            </button>
          ) : (
            <>
              <button className="btn btn--primary" onClick={() => decideApproval(approval.id, 'approved')}>
                Aprovar
              </button>
              {approval.tool !== ACCESS_REQUEST && approval.tool !== 'abrir_pr' && approval.connectorId !== 'navegador' && (
                <button className="btn" title={`Daqui pra frente ${agent?.name ?? 'o agente'} usa ${approval.tool} no ${approval.connectorName} sem pedir. Dá pra tirar na página dele.`} onClick={() => decideApproval(approval.id, 'approved', undefined, true)}>
                  Aprovar e sempre permitir
                </button>
              )}
            </>
          )}
          <button className="btn" onClick={() => setRefusing(true)}>
            Recusar
          </button>
        </div>
      )}
    </div>
  )
}

function Composer({ conversationId, members, placeholder }: { conversationId: string; members: Agent[]; placeholder: string }): ReactNode {
  const [text, setText] = useState('')
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const allAgents = useStore((s) => s.agents.filter((a) => !a.archived))
  const isDm = useStore((s) => s.conversations.find((c) => c.id === conversationId)?.kind === 'dm')
  const working = useStore((s) => s.messages.filter((m) => m.conversationId === conversationId && m.author.kind === 'agent' && m.run?.status === 'working'))
  const asker = useStore((s) => {
    const q = s.messages.findLast((m) => m.conversationId === conversationId && m.run?.status === 'waiting_input')
    return q?.author.kind === 'agent' ? agentById(s, q.author.id)?.name : undefined
  })

  useEffect(() => {
    setText('')
    ref.current?.focus()
  }, [conversationId])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  const options = mention
    ? members.filter((a) => a.handle.startsWith(mention.query.toLowerCase()) || a.name.toLowerCase().startsWith(mention.query.toLowerCase()))
    : []
  const outsiders = mention ? allAgents.filter((a) => !members.includes(a) && a.handle.startsWith(mention.query.toLowerCase())) : []

  const updateMention = (value: string, caret: number): void => {
    const before = value.slice(0, caret)
    const m = /(^|\s)@([a-z0-9_-]*)$/i.exec(before)
    if (m) {
      setMention({ query: m[2] ?? '', start: caret - (m[2]?.length ?? 0) - 1 })
      setActive(0)
    } else setMention(null)
  }

  const pick = (a: Agent): void => {
    if (!mention) return
    const caret = ref.current?.selectionStart ?? text.length
    const next = `${text.slice(0, mention.start)}@${a.handle} ${text.slice(caret)}`
    setText(next)
    setMention(null)
    requestAnimationFrame(() => {
      const pos = mention.start + a.handle.length + 2
      ref.current?.setSelectionRange(pos, pos)
      ref.current?.focus()
    })
  }

  const submit = (): void => {
    if (!text.trim()) return
    sendMessage(conversationId, text)
    setText('')
    setMention(null)
  }

  return (
    <div className="composer-wrap">
      {mention && (options.length > 0 || outsiders.length > 0) && (
        <div className="mention-menu" role="listbox">
          {options.map((a, i) => (
            <button
              key={a.id}
              className={`mention-menu__item ${i === active ? 'is-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(a)
              }}
            >
              <AgentAvatar agent={a} size={20} />
              <strong>{a.name}</strong>
              <span className="muted">@{a.handle}</span>
              <span className="mention-menu__role">{a.role}</span>
            </button>
          ))}
          {outsiders.length > 0 && (
            <div className="mention-menu__hint">
              {outsiders.map((a) => a.name).join(', ')} não {outsiders.length === 1 ? 'está' : 'estão'} neste canal.{' '}
              <button className="link" onMouseDown={(e) => (e.preventDefault(), openDm(outsiders[0]!.id))}>
                Abrir DM
              </button>
            </div>
          )}
        </div>
      )}
      <div className="composer">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={asker ? `Responder a ${asker}` : placeholder}
          onChange={(e) => {
            setText(e.target.value)
            updateMention(e.target.value, e.target.selectionStart)
          }}
          onKeyDown={(e) => {
            if (mention && options.length > 0) {
              if (e.key === 'ArrowDown') return (e.preventDefault(), setActive((active + 1) % options.length))
              if (e.key === 'ArrowUp') return (e.preventDefault(), setActive((active - 1 + options.length) % options.length))
              if (e.key === 'Enter' || e.key === 'Tab') return (e.preventDefault(), pick(options[active]!))
              if (e.key === 'Escape') return setMention(null)
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer__bar">
          <span className="composer__hint">
            {isDm ? 'O agente sempre responde na DM' : '@ chama um agente · sem menção, o router decide'}
          </span>
          {working.length > 0 ? (
            <button className="btn btn--sm" onClick={() => working.forEach((m) => stopRun(m.id))}>
              <Icon name="stop" size={12} /> Parar
            </button>
          ) : null}
          <button className="btn btn--primary btn--sm btn--icon" disabled={!text.trim()} onClick={submit} title="Enviar (Enter)">
            <Icon name="send" size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
