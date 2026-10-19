// The report (spec §20): computed on demand from replies, approvals and receipts.
import { countedTokens, type AgentReport, type Message, type Rate, type Report, type SkillReport } from '../shared/types'
import type { Db } from './db'

const DAYS = 42 // six weeks
const WEEK = 7 * 86_400_000
const OK = new Set(['done', 'waiting_input', 'waiting_approval'])
const CUT = /^Parei: (repeti|\d+ ferramentas falharam|fiquei)/

const rate = (ms: Message[]): Rate => ({ replies: ms.length, ok: ms.filter((m) => OK.has(m.run!.status)).length })

export function report(db: Db, now = Date.now()): Report {
  const since = now - DAYS * 86_400_000
  const replies = db.messages().filter((m) => m.author.kind === 'agent' && m.run && m.at >= since && m.run.status !== 'working')
  const approvals = db.approvals().filter((a) => a.createdAt >= since)
  const weekStart = (i: number): number => now - (DAYS / 7 - i) * WEEK

  const agents: AgentReport[] = db
    .agents()
    .filter((a) => !a.archived)
    .map((a) => {
      const mine = replies.filter((m) => m.author.kind === 'agent' && m.author.id === a.id)
      const costs = mine.flatMap((m) => (m.run!.receipt ? [{ tokens: countedTokens(m.run!.receipt), ms: m.run!.receipt.ms }] : []))
      const avg = (xs: number[]): number => (xs.length ? Math.round(xs.reduce((x, y) => x + y, 0) / xs.length) : 0)
      const asked = approvals.filter((x) => x.agentId === a.id)
      return {
        agentId: a.id,
        total: rate(mine),
        failed: mine.filter((m) => m.run!.status === 'failed' && !CUT.test(m.run!.error ?? '')).length,
        cut: mine.filter((m) => CUT.test(m.run!.error ?? '')).length,
        paused: mine.filter((m) => m.run!.status === 'paused' || m.run!.budget !== undefined).length,
        approvals: { asked: asked.length, refused: asked.filter((x) => x.state === 'refused').length },
        avgTokens: avg(costs.map((c) => c.tokens)),
        avgMs: avg(costs.map((c) => c.ms)),
        weeks: Array.from({ length: DAYS / 7 }, (_, i) => {
          const week = mine.filter((m) => m.at >= weekStart(i) && m.at < weekStart(i + 1))
          return { start: weekStart(i), rate: rate(week), avgTokens: avg(week.flatMap((m) => (m.run!.receipt ? [countedTokens(m.run!.receipt)] : []))) }
        })
      }
    })

  const skills: SkillReport[] = db
    .skills()
    .filter((k) => k.state === 'active')
    .map((k) => {
      const read = replies.filter((m) => m.run!.steps.some((s) => s.label === 'Leu a skill' && s.detail === k.name))
      const changedAt = db.skillVersions(k.id)[0]?.at
      return {
        skillId: k.id,
        name: k.name,
        reads: rate(read),
        changedAt,
        ...(changedAt ? { before: rate(read.filter((m) => m.at < changedAt)), since: rate(read.filter((m) => m.at >= changedAt)) } : {})
      }
    })

  return { since, agents, skills, work: db.costByWork(since) }
}
