import type { ReactNode } from 'react'
import type { Agent } from '../store'

const PATHS: Record<string, ReactNode> = {
  hash: <path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16" />,
  at: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12 5 5L20 7" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  shield: <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />,
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  plug: <path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v5" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  send: <path d="M4 12 20 4l-6 16-3-7-7-1Z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  edit: <path d="M4 20h4L19 9l-4-4L4 16v4Z" />,
  book: <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15ZM5 19.5A1.5 1.5 0 0 0 6.5 21H19M9 7h6" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  terminal: <path d="m5 7 5 5-5 5M12 17h7" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
}

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16 }: { name: IconName; size?: number }): ReactNode {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  )
}

export function AgentAvatar({ agent, size = 32 }: { agent: Pick<Agent, 'name' | 'color'>; size?: number }): ReactNode {
  return (
    <span className={`avatar avatar--agent c-${agent.color}`} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      <span className="avatar__eyes" aria-hidden>
        <i />
        <i />
      </span>
      <span className="sr-only">{agent.name}</span>
    </span>
  )
}

export function MeAvatar({ initials, size = 32 }: { initials: string; size?: number }): ReactNode {
  return (
    <span className="avatar avatar--me" style={{ width: size, height: size, fontSize: size * 0.36 }}>
      {initials}
    </span>
  )
}

export const usd = (v: number): string =>
  v < 0.01 && v > 0 ? `US$ ${v.toFixed(4).replace('.', ',')}` : `US$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const tokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} mi`
    : n >= 1000
      ? `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: n >= 100_000 ? 0 : 1 })}k`
      : String(n)

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)} min ${s % 60}s`
}

export function time(at: number): string {
  const d = new Date(at)
  const today = new Date()
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return hm
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} · ${hm}`
}

export function UsageBar({ used, limit }: { used: number; limit: number }): ReactNode {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 100
  const tone = pct >= 100 ? 'danger' : pct >= 80 ? 'warn' : 'ok'
  return (
    <span className={`budget budget--${tone}`} role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <span className="budget__fill" style={{ width: `${pct}%` }} />
    </span>
  )
}
