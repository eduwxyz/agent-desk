import { useState, type ReactNode } from 'react'
import {
  addMemory,
  agentById,
  confirmMemory,
  decideMemory,
  editMemory,
  forgetMemory,
  isStale,
  navigate,
  purgeMemory,
  useStore,
  STALE_DAYS,
  type Memory
} from '../store'
import { Page } from './Pages'
import { AgentAvatar, Icon, time } from './ui'

export function MemoryPage(): ReactNode {
  const memories = useStore((s) => s.memories)
  const agents = useStore((s) => s.agents.filter((a) => !a.archived))
  const me = useStore((s) => s.me.name)

  const pending = memories.filter((m) => m.state === 'pending')
  const stale = memories.filter((m) => isStale(m))
  const activeIn = (scope: string): Memory[] => memories.filter((m) => m.scope === scope && m.state === 'active' && !isStale(m)).sort((a, b) => b.confirmedAt - a.confirmedAt)
  const forgotten = memories.filter((m) => m.state === 'forgotten')
  const withNotes = agents.filter((a) => memories.some((m) => m.scope === a.id && m.state === 'active'))

  return (
    <Page title="Memória" subtitle="O que os agentes lembram entre conversas. Tudo que está aqui entra no prompt deles, e nada fica escondido nas CLIs.">
      {pending.length > 0 && (
        <MemorySection title="Sugestões" lead="Só entram na memória se você guardar.">
          {pending.map((m) => (
            <MemoryRow key={m.id} memory={m}>
              <button className="btn btn--sm btn--primary" onClick={() => decideMemory(m.id, true)}>
                Guardar
              </button>
              <button className="btn btn--sm btn--ghost" onClick={() => decideMemory(m.id, false)}>
                Descartar
              </button>
            </MemoryRow>
          ))}
        </MemorySection>
      )}

      {stale.length > 0 && (
        <MemorySection title="Revisar" lead={`Sem confirmação há mais de ${STALE_DAYS} dias. Continuam no prompt até você decidir.`}>
          {stale.map((m) => (
            <MemoryRow key={m.id} memory={m}>
              <button className="btn btn--sm" onClick={() => confirmMemory(m.id)}>
                Ainda vale
              </button>
              <button className="btn btn--sm btn--ghost" onClick={() => forgetMemory(m.id)}>
                Esquecer
              </button>
            </MemoryRow>
          ))}
        </MemorySection>
      )}

      <MemorySection title={`Sobre ${me}`} lead="Todos os agentes veem.">
        {activeIn('me').map((m) => (
          <EditableRow key={m.id} memory={m} />
        ))}
        <AddMemory scope="me" placeholder={`Ex.: ${me} prefere PRs pequenos, com descrição em bullets.`} />
      </MemorySection>

      {withNotes.map((a) => (
        <MemorySection
          key={a.id}
          title={
            <button className="link row row--center" onClick={() => navigate({ kind: 'agent', id: a.id })}>
              <AgentAvatar agent={a} size={18} /> Notas de {a.name}
            </button>
          }
          lead="Só este agente vê."
        >
          {activeIn(a.id).map((m) => (
            <EditableRow key={m.id} memory={m} />
          ))}
        </MemorySection>
      ))}

      {forgotten.length > 0 && <Forgotten memories={forgotten} />}
    </Page>
  )
}

function MemorySection({ title, lead, children }: { title: ReactNode; lead?: string; children: ReactNode }): ReactNode {
  return (
    <section className="memory-section">
      <h3 className="section-title">{title}</h3>
      {lead && <p className="muted small memory-section__lead">{lead}</p>}
      <div className="table">{children}</div>
    </section>
  )
}

// Where a memory came from, in one line.
function Origin({ memory }: { memory: Memory }): ReactNode {
  const agent = useStore((s) => (memory.agentId ? agentById(s, memory.agentId) : undefined))
  const conv = useStore((s) => s.conversations.find((c) => c.id === memory.conversationId))
  const dmWith = useStore((s) => (conv?.kind === 'dm' ? agentById(s, conv.name)?.name : undefined))
  const previous = useStore((s) => (memory.replaces ? s.memories.find((m) => m.id === memory.replaces) : undefined))
  const who = memory.origin === 'agent' ? `${agent?.name ?? 'Um agente'} ${memory.state === 'pending' ? 'quer guardar' : 'guardou'}` : memory.origin === 'extraction' ? 'Aprendida da conversa' : 'Você escreveu'
  return (
    <span className="muted small">
      {who}
      {conv && (
        <>
          {' '}
          <button className="link" onClick={() => navigate({ kind: 'conversation', id: conv.id })}>
            {conv.kind === 'channel' ? `em #${conv.name}` : `na DM com ${dmWith ?? 'agente'}`}
          </button>
        </>
      )}{' '}
      · {time(memory.createdAt)}
      {previous && <span className="memory__previous"> · antes: “{previous.text}”</span>}
    </span>
  )
}

function MemoryRow({ memory, children }: { memory: Memory; children?: ReactNode }): ReactNode {
  return (
    <div className="table__row memory">
      <div className="grow memory__body">
        <span>{memory.text}</span>
        <Origin memory={memory} />
      </div>
      <div className="memory__actions">{children}</div>
    </div>
  )
}

function EditableRow({ memory }: { memory: Memory }): ReactNode {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(memory.text)
  if (editing)
    return (
      <form
        className="table__row memory"
        onSubmit={(e) => {
          e.preventDefault()
          editMemory(memory.id, text)
          setEditing(false)
        }}
      >
        <textarea className="grow" rows={2} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
        <div className="memory__actions">
          <button className="btn btn--sm btn--primary" disabled={!text.trim()}>
            Salvar
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => (setEditing(false), setText(memory.text))}>
            Cancelar
          </button>
        </div>
      </form>
    )
  return (
    <MemoryRow memory={memory}>
      <button className="icon-btn" title="Editar" onClick={() => setEditing(true)}>
        <Icon name="edit" size={14} />
      </button>
      <button className="btn btn--sm btn--ghost" onClick={() => forgetMemory(memory.id)}>
        Esquecer
      </button>
    </MemoryRow>
  )
}

function AddMemory({ scope, placeholder }: { scope: string; placeholder: string }): ReactNode {
  const [text, setText] = useState('')
  return (
    <form
      className="table__row memory memory--add"
      onSubmit={(e) => {
        e.preventDefault()
        addMemory(scope, text)
        setText('')
      }}
    >
      <Icon name="plus" size={14} />
      <input className="grow" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} />
      <button className="btn btn--sm" disabled={!text.trim()}>
        Adicionar
      </button>
    </form>
  )
}

function Forgotten({ memories }: { memories: Memory[] }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <section className="memory-section">
      <h3 className="section-title">
        <button className="link" onClick={() => setOpen(!open)}>
          Esquecidas ({memories.length}) {open ? '▾' : '▸'}
        </button>
      </h3>
      {open && (
        <>
          <p className="muted small memory-section__lead">Saíram do prompt. O registro impede que sejam aprendidas de novo; apagar de vez remove até ele.</p>
          <div className="table">
            {memories.map((m) => (
              <MemoryRow key={m.id} memory={m}>
                {m.reason && <span className="muted small">{m.reason}</span>}
                <button className="btn btn--sm btn--ghost" onClick={() => purgeMemory(m.id)}>
                  Apagar de vez
                </button>
              </MemoryRow>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
