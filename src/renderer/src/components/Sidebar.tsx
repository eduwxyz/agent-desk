import { useCallback, useState, type ReactNode } from 'react'
import {
  agentById,
  channelName,
  createChannel,
  deleteConversation,
  markRead,
  navigate,
  openDialog,
  openDm,
  pendingApprovals,
  pendingMemories,
  updateSettings,
  useStore,
  type View
} from '../store'
import { ContextMenu, type MenuItem, type MenuState } from './Dialogs'
import { GettingStarted } from './Onboarding'
import { AgentAvatar, Icon, type IconName } from './ui'

const same = (a: View | null, b: View): boolean => JSON.stringify(a) === JSON.stringify(b)

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
  const suggestions = pendingMemories(s).length
  const proposals = s.skills.filter((k) => k.state === 'pending').length
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [menu, setMenu] = useState<MenuState>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const open = (e: React.MouseEvent, items: MenuItem[]): void => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }
  const channelMenu = (c: (typeof channels)[number]): MenuItem[] => [
    { label: 'Adicionar ou remover agentes…', icon: 'users', onClick: () => openDialog({ kind: 'members', id: c.id }) },
    { label: 'Renomear…', icon: 'edit', onClick: () => openDialog({ kind: 'rename', id: c.id }) },
    { label: 'Mudar o tema…', icon: 'hash', onClick: () => openDialog({ kind: 'topic', id: c.id }) },
    {
      label: c.project ? 'Projeto…' : 'Ligar a um projeto…',
      icon: 'folder',
      onClick: () => {
        navigate({ kind: 'conversation', id: c.id })
        openDialog({ kind: 'project', id: c.id })
      }
    },
    ...(c.unread ? [{ label: 'Marcar como lido', icon: 'check' as const, onClick: () => markRead(c.id) }] : []),
    'separator',
    {
      label: 'Excluir canal…',
      icon: 'trash',
      danger: true,
      onClick: () => {
        if (confirm(`Excluir #${c.name}?\n\nAs mensagens, as rotinas que postam nele e a memória do projeto vão junto. Os agentes continuam existindo. Não dá pra desfazer.`)) void deleteConversation(c.id)
      }
    }
  ]
  const dmMenu = (id: string, agentId: string, agentName: string): MenuItem[] => [
    { label: `Ver ${agentName}`, icon: 'eye', onClick: () => navigate({ kind: 'agent', id: agentId }) },
    { label: 'Marcar como lido', icon: 'check', onClick: () => markRead(id) },
    'separator',
    {
      label: 'Apagar a conversa…',
      icon: 'trash',
      danger: true,
      onClick: () => {
        if (confirm(`Apagar a conversa com ${agentName}?\n\nAs mensagens e as rotinas desta DM vão junto. ${agentName} continua existindo.`)) void deleteConversation(id)
      }
    }
  ]
  const agentMenu = (agentId: string): MenuItem[] => [
    { label: 'Mandar mensagem', icon: 'send', onClick: () => void openDm(agentId) },
    { label: 'Editar', icon: 'edit', onClick: () => navigate({ kind: 'agent', id: agentId }) }
  ]

  const submitChannel = (): void => {
    const clean = channelName(name)
    if (clean) void createChannel(clean)
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
          className={`icon-btn ${s.settings.paused ? 'is-paused' : ''}`}
          title={s.settings.paused ? 'Retomar os agentes' : 'Pausar tudo: nenhum agente começa a trabalhar e nenhuma rotina roda'}
          onClick={() => updateSettings({ paused: !s.settings.paused })}
        >
          <Icon name={s.settings.paused ? 'play' : 'pause'} />
        </button>
        <button
          className="icon-btn"
          title="Trocar tema"
          onClick={() => updateSettings({ theme: isDark ? 'light' : 'dark' })}
        >
          <Icon name={isDark ? 'sun' : 'moon'} />
        </button>
      </div>

      {s.settings.paused && (
        <button className="paused-banner" onClick={() => updateSettings({ paused: false })}>
          <Icon name="pause" size={13} /> Agentes pausados · <u>retomar</u>
        </button>
      )}
      <nav className="sidebar__scroll">
        <NavItem view={{ kind: 'approvals' }} icon="shield" label="Aprovações" badge={pending} />
        <NavItem view={{ kind: 'memory' }} icon="book" label="Memória" badge={suggestions} />
        <NavItem view={{ kind: 'routines' }} icon="clock" label="Rotinas" />
        <NavItem view={{ kind: 'skills' }} icon="layers" label="Skills" badge={proposals} />
        <NavItem view={{ kind: 'report' }} icon="report" label="Boletim" />

        <div className="section">
          <div className="section__head">
            <span>Canais</span>
            <button className="icon-btn icon-btn--sm" title="Novo canal" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} />
            </button>
          </div>
          {channels.map((c) => (
            <div key={c.id} onContextMenu={(e) => open(e, channelMenu(c))}>
              <ChannelItem id={c.id} name={c.name} unread={c.unread} />
            </div>
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
            return (
              <div key={c.id} onContextMenu={(e) => open(e, dmMenu(c.id, agent.id, agent.name))}>
                <DmItem id={c.id} name={agent.name} color={agent.color} />
              </div>
            )
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
              <div key={a.id} onContextMenu={(e) => open(e, agentMenu(a.id))}>
                <AgentItem id={a.id} />
              </div>
            ))}
        </div>
      </nav>

      {s.settings.onboarding?.done && !s.settings.onboarding.checklistHidden && <GettingStarted />}
      <ContextMenu menu={menu} onClose={closeMenu} />
      <div className="sidebar__foot">
        <NavItem view={{ kind: 'usage' }} icon="chart" label="Uso e limites" />
        <NavItem view={{ kind: 'connectors' }} icon="plug" label="Conectores" />
        <NavItem view={{ kind: 'settings' }} icon="gear" label="Configurações" />
      </div>
    </aside>
  )
}

function ChannelItem({ id, name, unread }: { id: string; name: string; unread?: number }): ReactNode {
  const active = useStore((s) => s.view?.kind === 'conversation' && s.view.id === id)
  return (
    <button className={`nav-item ${active ? 'is-active' : ''} ${unread ? 'is-unread' : ''}`} onClick={() => navigate({ kind: 'conversation', id })}>
      <Icon name="hash" />
      <span className="nav-item__label">{name}</span>
      {unread ? <span className="badge badge--soft">{unread}</span> : null}
    </button>
  )
}

function DmItem({ id, name, color }: { id: string; name: string; color: Parameters<typeof AgentAvatar>[0]['agent']['color'] }): ReactNode {
  const active = useStore((s) => s.view?.kind === 'conversation' && s.view.id === id)
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
  const active = useStore((s) => s.view?.kind === 'agent' && s.view.id === id)
  if (!agent) return null
  const pct = agent.limit > 0 ? agent.used / agent.limit : 1
  return (
    <button className={`nav-item ${active ? 'is-active' : ''}`} onClick={() => navigate({ kind: 'agent', id })}>
      <AgentAvatar agent={agent} size={18} />
      <span className="nav-item__label">{agent.name}</span>
      <span className="nav-item__meta">{agent.role}</span>
      {agent.computer && agent.computerKind === 'mac' && (
        <span className="nav-item__mac" title="Roda no seu Mac">
          <Icon name="laptop" size={13} />
        </span>
      )}
      {pct >= 0.8 && <span className={`dot ${pct >= 1 ? 'dot--danger' : 'dot--warn'}`} title="Orçamento acima de 80%" />}
    </button>
  )
}
