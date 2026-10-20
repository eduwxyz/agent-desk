// What agents make on their computers, in the chat: artifact cards and
// service cards inside messages, and the side panel that opens them.
import { useEffect, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { agentById, artifactUrl, browserAction, browserOf, computerOf, openExternal, openPanel, stopService, useStore, type Artifact } from '../store'
import { call } from '../rpc'
import { Icon, type IconName } from './ui'

const KIND_LABEL: Record<Artifact['kind'], string> = {
  image: 'Imagem',
  video: 'Vídeo',
  markdown: 'Documento',
  html: 'Página',
  pdf: 'PDF',
  csv: 'Planilha',
  text: 'Texto',
  file: 'Arquivo'
}

export const bytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)

export function ArtifactCard({ id }: { id: string }): ReactNode {
  const a = useStore((s) => s.artifacts.find((x) => x.id === id))
  const open = useStore((s) => s.panel?.kind === 'artifact' && s.panel.id === id)
  if (!a) return null
  if (a.kind === 'image')
    return (
      <button className={`artifact-image ${open ? 'is-open' : ''}`} onClick={() => openPanel({ kind: 'artifact', id })} title={a.title}>
        <img src={artifactUrl(a)} alt={a.title} />
        <span className="artifact-image__caption">{a.title}</span>
      </button>
    )
  return (
    <button className={`artifact-card ${open ? 'is-open' : ''}`} onClick={() => openPanel({ kind: 'artifact', id })}>
      <span className="artifact-card__icon">
        <Icon name={a.kind === 'html' ? 'globe' : a.kind === 'video' ? 'play' : 'edit'} size={16} />
      </span>
      <span className="artifact-card__text">
        <strong>{a.title}</strong>
        <span className="muted small">
          {KIND_LABEL[a.kind]} · {a.name} · {bytes(a.size)}
        </span>
      </span>
      <span className="artifact-card__open">Abrir</span>
    </button>
  )
}

export function ServiceCard({ agentId, name }: { agentId: string; name: string }): ReactNode {
  const svc = useStore((s) => computerOf(s, agentId)?.services.find((x) => x.name === name))
  const open = useStore((s) => s.panel?.kind === 'service' && s.panel.agentId === agentId && s.panel.name === name)
  if (!svc) return null
  return (
    <div className={`artifact-card artifact-card--service ${open ? 'is-open' : ''}`}>
      <span className="artifact-card__icon">
        <Icon name="globe" size={16} />
      </span>
      <span className="artifact-card__text">
        <strong>{svc.name}</strong>
        <span className="muted small">
          {svc.running ? 'no ar' : 'parado'} · porta {svc.port} · <code>{svc.command}</code>
        </span>
      </span>
      {svc.running && svc.url && (
        <>
          <button className="btn btn--sm btn--primary" onClick={() => openPanel({ kind: 'service', agentId, name })}>
            Abrir
          </button>
          <button className="btn btn--sm btn--ghost" onClick={() => stopService(agentId, name)}>
            Parar
          </button>
        </>
      )}
    </div>
  )
}

// ---------- the agent's browser, live ----------

const LOG_ICON: Record<string, IconName> = {
  Abriu: 'globe',
  Clicou: 'pointer',
  'Clicou (aprovado)': 'pointer',
  Escreveu: 'edit',
  Apertou: 'keyboard',
  Rolou: 'down',
  Voltou: 'back',
  'Leu a página': 'book',
  'Olhou a tela': 'eye',
  Esperou: 'clock'
}
const logIcon = (label: string): IconName => LOG_ICON[label] ?? (/assumiu|devolveu/.test(label) ? 'hand' : 'spark')
const clock = (at: number): string => new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

// Live while the agent is answering with it, or while I drive it.
function useLive(agentId: string): boolean {
  const working = useStore((s) => s.messages.some((m) => m.author.kind === 'agent' && m.author.id === agentId && m.run?.status === 'working'))
  const view = useStore((s) => browserOf(s, agentId))
  return working || !!view?.doing || !!view?.shown
}

function LiveBadge({ agentId }: { agentId: string }): ReactNode {
  return useLive(agentId) ? (
    <span className="live-badge">
      <i />
      ao vivo
    </span>
  ) : null
}

// The address as a browser shows it: the site in bold, the rest muted.
function UrlBar({ url }: { url: string }): ReactNode {
  let host = url
  let rest = ''
  let secure = false
  try {
    const u = new URL(url)
    host = u.host.replace(/^www\./, '')
    rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}`
    secure = u.protocol === 'https:'
  } catch {}
  return (
    <span className="url-bar" title={url}>
      <Icon name={secure ? 'lock' : 'globe'} size={11} />
      <span className="url-bar__text">
        <strong>{host || 'Nenhuma página'}</strong>
        {rest && <span>{rest}</span>}
      </span>
    </span>
  )
}

// The screen: what Chrome streams, with the agent's cursor where it last clicked or typed.
function BrowserScreen({ agentId, onOpen }: { agentId: string; onOpen?: () => void }): ReactNode {
  const view = useStore((s) => browserOf(s, agentId))
  const agent = useStore((s) => agentById(s, agentId))
  const live = useLive(agentId)
  if (!view?.frame)
    return (
      <div className="screen screen--empty">
        <Icon name="globe" size={22} />
        <span>{view?.doing ? `${view.doing.label}…` : 'Nenhuma página aberta ainda'}</span>
      </div>
    )
  const c = view.cursor
  return (
    <div className={`screen ${onOpen ? 'screen--button' : ''}`} onClick={onOpen} role={onOpen ? 'button' : undefined}>
      <img className="screen__frame" src={view.frame} alt={view.title} draggable={false} />
      {c && !view.shown && agent && (
        <span className={`screen__cursor c-${agent.color} ${live ? '' : 'is-idle'}`} style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%` }}>
          <i key={c.at} className="screen__ripple" />
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
            <path d="m4 2 16 8-7 2-3 7L4 2Z" />
          </svg>
          <span className="screen__name">{agent.name}</span>
        </span>
      )}
      {view.doing && !view.shown && (
        <span className="screen__status">
          <span className="spinner" />
          <span>
            {view.doing.label} {view.doing.detail && <strong>{view.doing.detail}</strong>}
          </span>
        </span>
      )}
      {view.shown && (
        <span className="screen__status screen__status--you">
          <Icon name="hand" size={13} />
          Você está no controle. Feche a janela do Chrome ou clique em Devolver.
        </span>
      )}
    </div>
  )
}

function BrowserLog({ agentId, max }: { agentId: string; max?: number }): ReactNode {
  const view = useStore((s) => browserOf(s, agentId))
  if (!view) return null
  const log = [...view.log].reverse().slice(0, max)
  return (
    <ol className="browser-log">
      {view.doing && (
        <li className="is-now">
          <span className="browser-log__icon">
            <span className="spinner" />
          </span>
          <span className="browser-log__text">
            {view.doing.label}
            {view.doing.detail && <span className="muted"> {view.doing.detail}</span>}
          </span>
          <time>agora</time>
        </li>
      )}
      {log.map((l, i) => (
        <li key={`${l.at}-${i}`}>
          <span className="browser-log__icon">
            <Icon name={logIcon(l.label)} size={12} />
          </span>
          <span className="browser-log__text">
            {l.label}
            {l.detail && <span className="muted"> {l.detail}</span>}
          </span>
          <time>{clock(l.at)}</time>
        </li>
      ))}
      {!view.doing && log.length === 0 && <li className="muted">Nada ainda.</li>}
    </ol>
  )
}

function TakeOver({ agentId }: { agentId: string }): ReactNode {
  const view = useStore((s) => browserOf(s, agentId))
  if (!view?.url) return null
  return (
    <button
      className={`btn btn--sm ${view.shown ? 'btn--primary' : 'btn--ghost'}`}
      title={view.shown ? 'Fecha a janela e devolve o navegador' : 'Abre o navegador numa janela pra você usar (login, código, captcha)'}
      onClick={(e) => {
        e.stopPropagation()
        browserAction(agentId, view.shown ? 'hide' : 'show')
      }}
    >
      <Icon name="hand" size={13} />
      {view.shown ? 'Devolver' : 'Assumir'}
    </button>
  )
}

// In the chat, on the agent's latest message that used it: the browser live,
// with what it did. Older messages get a small card.
export function BrowserCard({ agentId, big }: { agentId: string; big?: boolean }): ReactNode {
  const view = useStore((s) => browserOf(s, agentId))
  const name = useStore((s) => agentById(s, agentId)?.name ?? 'agente')
  const open = useStore((s) => s.panel?.kind === 'browser' && s.panel.agentId === agentId)
  const show = (): void => openPanel({ kind: 'browser', agentId })
  const status = view?.shown ? 'você está no controle' : view?.doing ? `${view.doing.label.toLowerCase()} ${view.doing.detail}` : view?.log.at(-1)?.label.toLowerCase() ?? 'parado'

  if (big)
    return (
      <div className="browser-live">
        <header className="browser-live__head">
          <Icon name="globe" size={14} />
          <span className="browser-live__title">
            <strong>Navegador de {name}</strong>
            <span className="muted"> · {status}</span>
          </span>
          <LiveBadge agentId={agentId} />
          <span className="grow" />
          <TakeOver agentId={agentId} />
          <button className="icon-btn" title="Abrir ao lado" onClick={show}>
            <Icon name="expand" size={14} />
          </button>
        </header>
        <div className="browser-live__body">
          <div className="browser-live__screen">
            <UrlBar url={view?.url ?? ''} />
            <BrowserScreen agentId={agentId} onOpen={show} />
          </div>
          <BrowserLog agentId={agentId} max={7} />
        </div>
      </div>
    )

  return (
    <button className={`artifact-card browser-card ${open ? 'is-open' : ''}`} onClick={show}>
      {view?.frame ? (
        <img className="browser-card__thumb" src={view.frame} alt="" />
      ) : (
        <span className="artifact-card__icon">
          <Icon name="globe" size={16} />
        </span>
      )}
      <span className="artifact-card__text">
        <strong>Navegador de {name}</strong>
        <span className="muted small">{view?.shown ? 'Você está no controle' : view?.title || view?.url || 'Nenhuma página aberta'}</span>
      </span>
      <span className="artifact-card__open">Ver</span>
    </button>
  )
}

function BrowserPanel({ agentId }: { agentId: string }): ReactNode {
  const view = useStore((s) => browserOf(s, agentId))
  return (
    <div className="browser-view">
      <div className="browser-window">
        <div className="browser-window__bar">
          <span className="browser-window__dots">
            <i />
            <i />
            <i />
          </span>
          <UrlBar url={view?.url ?? ''} />
        </div>
        <BrowserScreen agentId={agentId} />
      </div>
      <section className="browser-activity">
        <h4>O que fez</h4>
        <BrowserLog agentId={agentId} />
      </section>
    </div>
  )
}

export function SidePanel(): ReactNode {
  const panel = useStore((s) => s.panel)
  const artifact = useStore((s) => (s.panel?.kind === 'artifact' ? s.artifacts.find((a) => a.id === (s.panel as { id: string }).id) : undefined))
  const service = useStore((s) =>
    s.panel?.kind === 'service' ? computerOf(s, s.panel.agentId)?.services.find((x) => x.name === (s.panel as { name: string }).name) : undefined
  )
  const browser = useStore((s) => (s.panel?.kind === 'browser' ? browserOf(s, s.panel.agentId) : undefined))
  const browserName = useStore((s) => (s.panel?.kind === 'browser' ? agentById(s, s.panel.agentId)?.name : undefined))
  const [reload, setReload] = useState(0)
  if (!panel) return null

  const title = artifact?.title ?? service?.name ?? (panel.kind === 'browser' ? `Navegador de ${browserName ?? 'agente'}` : '')
  return (
    <aside className={`side-panel side-panel--${panel.kind}`}>
      <header className="side-panel__head">
        <Icon name={panel.kind === 'service' || panel.kind === 'browser' ? 'globe' : 'edit'} size={14} />
        <strong className="side-panel__title">{title}</strong>
        {service?.url && <code className="side-panel__url">{service.url}</code>}
        {panel.kind === 'browser' && <LiveBadge agentId={panel.agentId} />}
        <span className="grow" />
        {panel.kind === 'browser' && <TakeOver agentId={panel.agentId} />}
        {service?.url && (
          <>
            <button className="icon-btn" title="Recarregar" onClick={() => setReload((n) => n + 1)}>
              <Icon name="clock" size={14} />
            </button>
            <button className="btn btn--sm btn--ghost" onClick={() => openExternal(service.url!)}>
              Abrir no navegador
            </button>
          </>
        )}
        <button className="icon-btn" title="Fechar" onClick={() => openPanel(null)}>
          <Icon name="x" size={14} />
        </button>
      </header>
      <div className="side-panel__body">
        {artifact && <ArtifactView artifact={artifact} />}
        {panel.kind === 'service' &&
          (service?.running && service.url ? (
            // Same origin is the service's own (127.0.0.1:port), not the app's.
            <iframe key={reload} src={service.url} sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals" title={service.name} />
          ) : (
            <p className="empty">Esse serviço não está rodando.</p>
          ))}
        {panel.kind === 'artifact' && !artifact && <p className="empty">Arquivo não encontrado.</p>}
        {panel.kind === 'browser' && <BrowserPanel agentId={panel.agentId} />}
      </div>
    </aside>
  )
}

function ArtifactView({ artifact }: { artifact: Artifact }): ReactNode {
  const url = artifactUrl(artifact)
  const [text, setText] = useState<string | null>(null)
  const textual = artifact.kind === 'markdown' || artifact.kind === 'csv' || artifact.kind === 'text'
  useEffect(() => {
    setText(null)
    if (textual)
      void call('artifactText', { id: artifact.id }).then(
        (t) => setText(t ?? '(não consegui abrir o arquivo)'),
        () => setText('(não consegui abrir o arquivo)')
      )
  }, [artifact.id, textual])

  switch (artifact.kind) {
    case 'image':
      return (
        <div className="side-panel__image">
          <img src={url} alt={artifact.title} />
        </div>
      )
    case 'video':
      return (
        <div className="side-panel__image">
          <video src={url} controls preload="metadata" />
        </div>
      )
    case 'html':
      return <iframe src={url} sandbox="allow-scripts allow-popups" title={artifact.title} />
    case 'pdf':
      return <iframe src={url} title={artifact.title} />
    case 'markdown':
      return <div className="side-panel__doc md">{text !== null && <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>}</div>
    case 'csv':
      return <div className="side-panel__doc">{text !== null && <CsvTable text={text} tab={artifact.name.endsWith('.tsv')} />}</div>
    case 'text':
      return <pre className="side-panel__text">{text}</pre>
    default:
      return <p className="empty">Sem visualização pra esse tipo de arquivo ({artifact.name}, {bytes(artifact.size)}).</p>
  }
}

// Enough CSV for a preview: quoted fields, escaped quotes, first 500 rows.
export function parseCsv(text: string, sep = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length && rows.length < 500; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === sep) row.push(field), (field = '')
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field), rows.push(row), (row = []), (field = '')
    } else field += c
  }
  if (field || row.length) row.push(field), rows.push(row)
  return rows
}

function CsvTable({ text, tab }: { text: string; tab: boolean }): ReactNode {
  const [head = [], ...rows] = parseCsv(text, tab ? '\t' : ',')
  return (
    <table className="csv">
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={i}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
