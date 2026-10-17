// Pure rules of the governance layer: how a tool is classified, which tools a
// grant exposes, and how an approval is bound to one exact call.
import { createHash } from 'node:crypto'
import type { ConnectorTool, GrantLevel, ToolClass } from '../shared/types'

const READ_WORDS = new Set(['get', 'list', 'search', 'read', 'find', 'fetch', 'query', 'describe', 'show', 'view', 'count', 'lookup', 'retrieve'])
const SENSITIVE_WORDS = new Set(['delete', 'remove', 'merge', 'deploy', 'send', 'publish', 'transfer', 'pay', 'destroy', 'drop', 'revoke'])

// "mergePullRequest" and "merge_pull_request" both become ["merge", "pull", "request"].
const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

// Annotations first; then the name. A sensitive word anywhere wins over a read verb
// at the start, since a wrong "read" would skip approval.
export function classify(tool: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }): ToolClass {
  if (tool.annotations?.readOnlyHint === true) return 'read'
  if (tool.annotations?.destructiveHint === true) return 'sensitive'
  const w = words(tool.name)
  if (w.some((x) => SENSITIVE_WORDS.has(x))) return 'sensitive'
  if (w[0] && READ_WORDS.has(w[0])) return 'read'
  return 'write'
}

// `read` exposes read tools; `read_write` exposes everything (sensitive ones go through approval).
export function allowed(tool: ConnectorTool, grant: GrantLevel | undefined): boolean {
  if (!tool.enabled) return false
  if (grant === 'read') return tool.cls === 'read'
  return grant === 'read_write'
}

// Same JSON for the same arguments regardless of key order.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function approvalHash(connectorId: string, tool: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(`${connectorId}\n${tool}\n${canonical(args)}`).digest('hex')
}
