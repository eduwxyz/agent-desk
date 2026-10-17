import { useState, type ReactNode } from 'react'
import {
  agentById,
  createChannel,
  navigate,
  pendingApprovals,
  updateSettings,
  useStore,
  type View
} from '../store'
import { AgentAvatar, Icon, type IconName } from './ui'

const same = (a: View, b: View): boolean => JSON.stringify(a) === JSON.stringify(b)

function NavItem({ view, icon, label, badge }: { view: View; icon: IconName; label: string; badge?: number }): ReactNode {
  const active = useStore((s) => same(s.view, view))
  return (
    <button className={`nav-item ${active ? 'is-active' : ''}`} onClick={() => navigate(view)}>
      <Icon name={icon} />
      <span className="nav-item__label">{label}</span>
      {badge ? <span className="badge">{badge}</span> : null}
    </button>
  )
}

export function Sidebar(): ReactNode {
  const s = useStore((s) => s)
  const channels = s.conversations.filter((c) => c.kind === 'channel')
  const dms = s.conversations.filter((c) => c.kind === 'dm')
  const pending = pendingApprovals(s).length
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  const submitChannel = (): void => {
    const clean = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '')
    if (clean) navigate({ kind: 'conversation', id: createChannel(clean) })
    setName('')
    setAdding(false)
  }

  const isDark =
    s.settings.theme === 'dark' || (s.settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)

  return (
    <aside className="sidebar">
      <div className="sidebar__drag" />
      <div className="workspace">
        <span className="workspace__logo">{s.settings.workspaceName.slice(0, 1)}</span>
        <span className="workspace__name">{s.settings.workspaceName}</span>
        <button
          className="icon-btn"
          title="Trocar tema"
          onClick={() => updateSettings({ theme: isDark ? 'light' : 'dark' })}
        >
          <Icon name={isDark ? 'sun' : 'moon'} />
        </button>
      </div>

      <nav className="sidebar__scroll">
        <NavItem view={{ kind: 'approvals' }} icon="shield" label="Aprovações" badge={pending} />

        <div className="section">
          <div className="section__head">
            <span>Canais</span>
            <button className="icon-btn icon-btn--sm" title="Novo canal" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} />
            </button>
          </div>
          {channels.map((c) => (
            <ChannelItem key={c.id} id={c.id} name={c.name} unread={c.unread} />
          ))}
          {adding && (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault()
                submitChannel()
              }}
            >
              <Icon name="hash" />
              <input
                autoFocus
                value={name}
                placeholder="nome-do-canal"
                onChange={(e) => setName(e.target.value)}
                onBlur={submitChannel}
                onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
              />
            </form>
          )}
        </div>

        <div className="section">
          <div className="section__head">
            <span>Mensagens diretas</span>
          </div>
          {dms.map((c) => {
            const agent = agentById(s, c.name)
            if (!agent) return null
            return <DmItem key={c.id} id={c.id} name={agent.name} color={agent.color} />
          })}
        </div>

        <div className="section">
          <div className="section__head">
            <span>Agentes</span>
            <button className="icon-btn icon-btn--sm" title="Novo agente" onClick={() => navigate({ kind: 'new-agent' })}>
              <Icon name="plus" size={14} />
            </button>
          </div>
          {s.agents
            .filter((a) => !a.archived)
            .map((a) => (
              <AgentItem key={a.id} id={a.id} />
            ))}
        </div>
      </nav>

      <div className="sidebar__foot">
        <NavItem view={{ kind: 'usage' }} icon="chart" label="Uso e limites" />
        <NavItem view={{ kind: 'connectors' }} icon="plug" label="Conectores" />
        <NavItem view={{ kind: 'settings' }} icon="gear" label="Configurações" />
      </div>
    </aside>
  )
}

function ChannelItem({ id, name, unread }: { id: string; name: string; unread?: number }): ReactNode {
  const active = useStore((s) => s.view.kind === 'conversation' && s.view.id === id)
  return (
    <button className={`nav-item ${active ? 'is-active' : ''} ${unread ? 'is-unread' : ''}`} onClick={() => navigate({ kind: 'conversation', id })}>
      <Icon name="hash" />
      <span className="nav-item__label">{name}</span>
      {unread ? <span className="badge badge--soft">{unread}</span> : null}
    </button>
  )
}

function DmItem({ id, name, color }: { id: string; name: string; color: Parameters<typeof AgentAvatar>[0]['agent']['color'] }): ReactNode {
  const active = useStore((s) => s.view.kind === 'conversation' && s.view.id === id)
  const working = useStore((s) => s.messages.some((m) => m.conversationId === id && m.run?.status === 'working'))
  return (
    <button className={`nav-item ${active ? 'is-active' : ''}`} onClick={() => navigate({ kind: 'conversation', id })}>
      <AgentAvatar agent={{ name, color }} size={18} />
      <span className="nav-item__label">{name}</span>
      {working && <span className="pulse" title="Trabalhando" />}
    </button>
  )
}

function AgentItem({ id }: { id: string }): ReactNode {
  const agent = useStore((s) => agentById(s, id))
  const active = useStore((s) => s.view.kind === 'agent' && s.view.id === id)
  if (!agent) return null
  const pct = agent.limit > 0 ? agent.used / agent.limit : 1
  return (
    <button className={`nav-item ${active ? 'is-active' : ''}`} onClick={() => navigate({ kind: 'agent', id })}>
      <AgentAvatar agent={agent} size={18} />
      <span className="nav-item__label">{agent.name}</span>
      <span className="nav-item__meta">{agent.role}</span>
      {pct >= 0.8 && <span className={`dot ${pct >= 1 ? 'dot--danger' : 'dot--warn'}`} title="Orçamento acima de 80%" />}
    </button>
  )
}
