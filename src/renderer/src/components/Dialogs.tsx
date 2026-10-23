// Small windows over the app (a channel's members, name and topic) and the
// right-click menu. Which window is open lives in the store, so the sidebar's
// menu and the channel's header open the same ones.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { agentById, archiveAgent, createChannel, getState, navigate, openDialog, openDm, renameChannel, setChannelMembers, setTopic, useStore, type State, type View } from '../store'
import { AgentAvatar, Icon, type IconName } from './ui'

const message = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e))

export function Dialogs(): ReactNode {
  const dialog = useStore((s) => s.dialog)
  const conv = useStore((s) => (s.dialog && 'id' in s.dialog ? s.conversations.find((c) => c.id === (s.dialog as { id: string }).id) : undefined))
  const close = (): void => openDialog(null)
  if (dialog?.kind === 'search') return <Search onClose={close} />
  if (dialog?.kind === 'archived') return <Archived onClose={close} />
  if (dialog?.kind === 'new-channel')
    return <TextDialog title="Novo canal" label="Nome" value="" hint="Minúsculas e hífens: “Squad Pagamentos” vira squad-pagamentos. Depois você escolhe os agentes." prefix="#" onSave={(v) => createChannel(v)} onClose={() => getState().dialog?.kind === 'new-channel' && close()} />
  if (!dialog || !conv || dialog.kind === 'project') return null
  if (dialog.kind === 'members') return <MembersDialog id={conv.id} name={conv.name} members={conv.members} onClose={close} />
  if (dialog.kind === 'rename')
    return <TextDialog title={`Renomear #${conv.name}`} label="Nome" value={conv.name} hint="Minúsculas e hífens: “Lançamento do App” vira lancamento-do-app." prefix="#" onSave={(v) => renameChannel(conv.id, v)} onClose={close} />
  return <TextDialog title={`Tema de #${conv.name}`} label="Tema" value={conv.topic ?? ''} hint="Uma linha no topo do canal dizendo pra que ele serve. Vazio, some." onSave={(v) => setTopic(conv.id, v)} onClose={close} allowEmpty />
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): ReactNode {
  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal__card" role="dialog" aria-label={title}>
        <header className="modal__head">
          <strong>{title}</strong>
          <button className="icon-btn icon-btn--sm" title="Fechar" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}

// Who is in the channel: a row per agent, on or off, saved together.
function MembersDialog({ id, name, members, onClose }: { id: string; name: string; members: string[]; onClose: () => void }): ReactNode {
  const agents = useStore((s) => s.agents.filter((a) => !a.archived))
  const [picked, setPicked] = useState<string[]>(members)
  const [error, setError] = useState<string | null>(null)
  const toggle = (a: string): void => setPicked(picked.includes(a) ? picked.filter((x) => x !== a) : [...picked, a])
  const changed = picked.length !== members.length || picked.some((a) => !members.includes(a))
  return (
    <Modal title={`Agentes em #${name}`} onClose={onClose}>
      <p className="muted small modal__lead">Quem está no canal lê a conversa e pode responder. Sem @menção, o router escolhe entre eles.</p>
      <div className="member-list">
        {agents.map((a) => {
          const on = picked.includes(a.id)
          return (
            <button key={a.id} className={`member ${on ? 'is-on' : ''}`} onClick={() => toggle(a.id)}>
              <AgentAvatar agent={a} size={28} />
              <span className="member__text grow">
                <strong>{a.name}</strong>
                <span className="muted small">
                  @{a.handle}
                  {a.role ? ` · ${a.role}` : ''}
                </span>
              </span>
              <span className="member__check">{on && <Icon name="check" size={13} />}</span>
            </button>
          )
        })}
      </div>
      {error && <p className="field__error">{error}</p>}
      <footer className="modal__foot">
        <span className="muted small">
          {picked.length} {picked.length === 1 ? 'agente' : 'agentes'}
        </span>
        <button className="btn btn--ghost btn--sm" onClick={onClose}>
          Cancelar
        </button>
        <button className="btn btn--primary btn--sm" disabled={!changed} onClick={() => setChannelMembers(id, picked).then(onClose, (e: unknown) => setError(message(e)))}>
          Salvar
        </button>
      </footer>
    </Modal>
  )
}

function TextDialog(p: { title: string; label: string; value: string; hint: string; prefix?: string; allowEmpty?: boolean; onSave: (v: string) => Promise<void>; onClose: () => void }): ReactNode {
  const [value, setValue] = useState(p.value)
  const [error, setError] = useState<string | null>(null)
  const save = (): void => {
    if (!p.allowEmpty && !value.trim()) return
    p.onSave(value).then(p.onClose, (e: unknown) => setError(message(e)))
  }
  return (
    <Modal title={p.title} onClose={p.onClose}>
      <label className="field">
        <span className="field__label">{p.label}</span>
        <span className="row row--center modal__input">
          {p.prefix && <span className="muted">{p.prefix}</span>}
          <input autoFocus className="grow" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        </span>
        <span className="hint">{p.hint}</span>
      </label>
      {error && <p className="field__error">{error}</p>}
      <footer className="modal__foot">
        <span className="grow" />
        <button className="btn btn--ghost btn--sm" onClick={p.onClose}>
          Cancelar
        </button>
        <button className="btn btn--primary btn--sm" disabled={!p.allowEmpty && !value.trim()} onClick={save}>
          Salvar
        </button>
      </footer>
    </Modal>
  )
}

// The agents taken out of the sidebar, to see or bring back.
function Archived({ onClose }: { onClose: () => void }): ReactNode {
  const agents = useStore((s) => s.agents.filter((a) => a.archived))
  return (
    <Modal title="Agentes arquivados" onClose={onClose}>
      <p className="muted small modal__lead">Não respondem, não rodam rotinas e não aparecem pro router. O histórico e os recibos continuam. Reativado, o agente volta aos canais em que estava; as rotinas dele você liga de novo em Rotinas.</p>
      {agents.length === 0 ? (
        <p className="muted small">Nenhum agente arquivado.</p>
      ) : (
        <div className="member-list">
          {agents.map((a) => (
            <div key={a.id} className="member">
              <AgentAvatar agent={a} size={28} />
              <span className="member__text grow">
                <strong>{a.name}</strong>
                <span className="muted small">
                  @{a.handle}
                  {a.role ? ` · ${a.role}` : ''}
                </span>
              </span>
              <button
                className="btn btn--sm btn--ghost"
                onClick={() => {
                  onClose()
                  navigate({ kind: 'agent', id: a.id })
                }}
              >
                Ver
              </button>
              <button className="btn btn--sm" onClick={() => void archiveAgent(a.id, false)}>
                Reativar
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

// ---------- ⌘K: go anywhere by typing ----------

type Hit = { key: string; label: string; detail: string; icon?: IconName; agent?: string; go: () => void }

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

const PAGES: { label: string; view: View; icon: IconName }[] = [
  { label: 'Aprovações', view: { kind: 'approvals' }, icon: 'shield' },
  { label: 'Memória', view: { kind: 'memory' }, icon: 'book' },
  { label: 'Rotinas', view: { kind: 'routines' }, icon: 'clock' },
  { label: 'Skills', view: { kind: 'skills' }, icon: 'layers' },
  { label: 'Boletim', view: { kind: 'report' }, icon: 'report' },
  { label: 'Uso e limites', view: { kind: 'usage' }, icon: 'chart' },
  { label: 'Conectores', view: { kind: 'connectors' }, icon: 'plug' },
  { label: 'Configurações', view: { kind: 'settings' }, icon: 'gear' }
]

function hits(s: State): Hit[] {
  const agents = s.agents.filter((a) => !a.archived)
  return [
    ...s.conversations.filter((c) => c.kind === 'channel').map((c): Hit => ({ key: c.id, label: `#${c.name}`, detail: c.topic ?? 'canal', icon: 'hash', go: () => navigate({ kind: 'conversation', id: c.id }) })),
    ...agents.map((a): Hit => ({ key: `dm-${a.id}`, label: a.name, detail: `conversa${a.role ? ` · ${a.role}` : ''}`, agent: a.id, go: () => void openDm(a.id) })),
    ...agents.map((a): Hit => ({ key: `agent-${a.id}`, label: `${a.name}: configurar`, detail: `@${a.handle}`, icon: 'edit', go: () => navigate({ kind: 'agent', id: a.id }) })),
    ...PAGES.map((p): Hit => ({ key: p.label, label: p.label, detail: 'tela', icon: p.icon, go: () => navigate(p.view) })),
    { key: 'new-channel', label: 'Novo canal', detail: '⌘N', icon: 'plus', go: () => openDialog({ kind: 'new-channel' }) },
    { key: 'new-agent', label: 'Novo agente', detail: 'ação', icon: 'plus', go: () => navigate({ kind: 'new-agent' }) }
  ]
}

function Search({ onClose }: { onClose: () => void }): ReactNode {
  const all = useStore(hits)
  const state = useStore((s) => s)
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const query = fold(q.trim().replace(/^[#@]/, ''))
  const list = (query ? all.filter((h) => fold(`${h.label} ${h.detail}`).includes(query)).sort((a, b) => Number(!fold(a.label).replace(/^#/, '').startsWith(query)) - Number(!fold(b.label).replace(/^#/, '').startsWith(query))) : all).slice(0, 12)
  const pick = (h: Hit | undefined): void => {
    if (!h) return
    onClose()
    h.go()
  }
  return (
    <div className="modal modal--top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search" role="dialog" aria-label="Ir para">
        <div className="search__input">
          <Icon name="spark" size={16} />
          <input
            autoFocus
            value={q}
            placeholder="Ir para um canal, agente ou tela…"
            onChange={(e) => {
              setQ(e.target.value)
              setAt(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setAt(Math.min(at + 1, list.length - 1))
              else if (e.key === 'ArrowUp') setAt(Math.max(at - 1, 0))
              else if (e.key === 'Enter') pick(list[at])
              else if (e.key === 'Escape') onClose()
              else return
              e.preventDefault()
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="search__list">
          {list.length === 0 && <p className="muted small search__none">Nada com “{q}”.</p>}
          {list.map((h, i) => {
            const agent = h.agent ? agentById(state, h.agent) : undefined
            return (
              <button key={h.key} className={`search__hit ${i === at ? 'is-on' : ''}`} onMouseEnter={() => setAt(i)} onClick={() => pick(h)}>
                {agent ? <AgentAvatar agent={agent} size={18} /> : <Icon name={h.icon ?? 'hash'} size={15} />}
                <span className="grow">{h.label}</span>
                <span className="muted small">{h.detail}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ---------- the right-click menu ----------

export type MenuItem = { label: string; icon?: IconName; danger?: boolean; onClick: () => void } | 'separator'
export type MenuState = { x: number; y: number; items: MenuItem[] } | null

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!menu) return
    // Keep it on screen.
    const r = ref.current?.getBoundingClientRect()
    setPos({ x: Math.min(menu.x, window.innerWidth - (r?.width ?? 220) - 8), y: Math.min(menu.y, window.innerHeight - (r?.height ?? 200) - 8) })
    const close = (): void => onClose()
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', esc)
    }
  }, [menu, onClose])
  if (!menu) return null
  return (
    <div ref={ref} className="menu" role="menu" style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y }} onMouseDown={(e) => e.stopPropagation()}>
      {menu.items.map((it, i) =>
        it === 'separator' ? (
          <div key={i} className="menu__sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu__item ${it.danger ? 'is-danger' : ''}`}
            onClick={() => {
              onClose()
              it.onClick()
            }}
          >
            {it.icon && <Icon name={it.icon} size={14} />}
            {it.label}
          </button>
        )
      )}
    </div>
  )
}
