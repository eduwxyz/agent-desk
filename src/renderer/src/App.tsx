import { useEffect, type ReactNode } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { ConversationView } from './components/Conversation'
import { AgentPage, ApprovalsPage, ConnectorsPage, SettingsPage, UsagePage } from './components/Pages'

export function App(): ReactNode {
  const view = useStore((s) => s.view)
  const theme = useStore((s) => s.settings.theme)

  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset['theme']
    else document.documentElement.dataset['theme'] = theme
  }, [theme])

  if (!view) return <div className="boot" />

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {view.kind === 'conversation' && <ConversationView key={view.id} id={view.id} />}
        {view.kind === 'agent' && <AgentPage key={view.id} id={view.id} />}
        {view.kind === 'new-agent' && <AgentPage key="new" />}
        {view.kind === 'approvals' && <ApprovalsPage />}
        {view.kind === 'usage' && <UsagePage />}
        {view.kind === 'connectors' && <ConnectorsPage />}
        {view.kind === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}
