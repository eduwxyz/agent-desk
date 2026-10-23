import { useEffect, type ReactNode } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { ConversationView } from './components/Conversation'
import { AgentPage, ApprovalsPage, ConnectorsPage, SettingsPage, UsagePage } from './components/Pages'
import { MemoryPage } from './components/Memory'
import { RoutinesPage } from './components/Routines'
import { SkillsPage } from './components/Skills'
import { ReportPage } from './components/Report'
import { Onboarding } from './components/Onboarding'

export function App(): ReactNode {
  const view = useStore((s) => s.view)
  const theme = useStore((s) => s.settings.theme)
  const intro = useStore((s) => s.ready && s.settings.onboarding?.done === false)

  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset['theme']
    else document.documentElement.dataset['theme'] = theme
  }, [theme])

  if (!view) return <div className="boot" />
  if (intro) return <Onboarding />

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
        {view.kind === 'memory' && <MemoryPage />}
        {view.kind === 'routines' && <RoutinesPage />}
        {view.kind === 'skills' && <SkillsPage />}
        {view.kind === 'report' && <ReportPage />}
        {view.kind === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}
