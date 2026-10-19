// What agents make on their computers, in the chat: artifact cards and
// service cards inside messages, and the side panel that opens them.
import { useEffect, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { artifactUrl, computerOf, openExternal, openPanel, stopService, useStore, type Artifact } from '../store'
import { call } from '../rpc'
import { Icon } from './ui'

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

export function SidePanel(): ReactNode {
  const panel = useStore((s) => s.panel)
  const artifact = useStore((s) => (s.panel?.kind === 'artifact' ? s.artifacts.find((a) => a.id === (s.panel as { id: string }).id) : undefined))
  const service = useStore((s) =>
    s.panel?.kind === 'service' ? computerOf(s, s.panel.agentId)?.services.find((x) => x.name === (s.panel as { name: string }).name) : undefined
  )
  const [reload, setReload] = useState(0)
  if (!panel) return null

  const title = artifact?.title ?? service?.name ?? ''
  return (
    <aside className="side-panel">
      <header className="side-panel__head">
        <Icon name={panel.kind === 'service' ? 'globe' : 'edit'} size={14} />
        <strong className="side-panel__title">{title}</strong>
        {service?.url && <code className="side-panel__url">{service.url}</code>}
        <span className="grow" />
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
