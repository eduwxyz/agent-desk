import { DatabaseSync } from 'node:sqlite'
import type { Agent, AgentColor, Author, Conversation, Effort, Message, Receipt, Run, Settings } from '../shared/types'

// Each entry runs once, in order; PRAGMA user_version records how far we got.
const MIGRATIONS = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    handle TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    effort TEXT NOT NULL,
    limit_tokens INTEGER NOT NULL,
    grants TEXT NOT NULL DEFAULT '{}',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('channel', 'dm')),
    name TEXT NOT NULL,
    topic TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE members (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    PRIMARY KEY (conversation_id, agent_id)
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    author_kind TEXT NOT NULL,
    author_id TEXT,
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    run TEXT
  );
  CREATE INDEX messages_by_conversation ON messages (conversation_id, at);
  CREATE TABLE receipts (
    id INTEGER PRIMARY KEY,
    message_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    engine TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    ms INTEGER NOT NULL,
    api_cost_usd REAL,
    at INTEGER NOT NULL
  );
  CREATE INDEX receipts_by_agent ON receipts (agent_id, at);
  `
]

type Row = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export const monthStart = (now = new Date()): number => new Date(now.getFullYear(), now.getMonth(), 1).getTime()

export class Db {
  private db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    const { user_version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!)
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
  }

  // Nested calls join the outer transaction.
  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn()
    this.db.exec('BEGIN')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  isEmpty(): boolean {
    return !this.db.prepare('SELECT 1 FROM agents LIMIT 1').get()
  }

  // ---------- settings ----------

  getSettings(defaults: Omit<Settings, 'engines'>): Omit<Settings, 'engines'> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
    const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]))
    return { ...defaults, ...stored }
  }

  setSettings(patch: Partial<Omit<Settings, 'engines'>>): void {
    const stmt = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    this.tx(() => {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) stmt.run(k, JSON.stringify(v))
    })
  }

  // ---------- agents ----------

  private toAgent(r: Row): Agent {
    return {
      id: str(r['id']),
      name: str(r['name']),
      handle: str(r['handle']),
      role: str(r['role']),
      color: str(r['color']) as AgentColor,
      instructions: str(r['instructions']),
      modelId: str(r['model']),
      effort: str(r['effort']) as Effort,
      limit: Number(r['limit_tokens']),
      used: this.usedThisMonth(str(r['id'])),
      grants: JSON.parse(str(r['grants']) || '{}') as Agent['grants'],
      archived: r['archived'] === 1
    }
  }

  agents(): Agent[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY created_at').all() as Row[]).map((r) => this.toAgent(r))
  }

  agent(id: string): Agent | undefined {
    const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined
    return r && this.toAgent(r)
  }

  saveAgent(a: Agent): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, name, handle, role, color, instructions, model, effort, limit_tokens, grants, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, handle = excluded.handle, role = excluded.role,
           color = excluded.color, instructions = excluded.instructions, model = excluded.model, effort = excluded.effort,
           limit_tokens = excluded.limit_tokens, grants = excluded.grants, archived = excluded.archived`
      )
      .run(a.id, a.name, a.handle, a.role, a.color, a.instructions, a.modelId, a.effort, a.limit, JSON.stringify(a.grants), a.archived ? 1 : 0, Date.now())
  }

  usedThisMonth(agentId: string): number {
    const r = this.db
      .prepare('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS used FROM receipts WHERE agent_id = ? AND at >= ?')
      .get(agentId, monthStart()) as { used: number }
    return r.used
  }

  // ---------- conversations ----------

  conversations(): Conversation[] {
    const rows = this.db.prepare('SELECT * FROM conversations ORDER BY created_at').all() as Row[]
    const members = this.db.prepare('SELECT conversation_id, agent_id FROM members').all() as { conversation_id: string; agent_id: string }[]
    return rows.map((r) => ({
      id: str(r['id']),
      kind: str(r['kind']) as Conversation['kind'],
      name: str(r['name']),
      topic: r['topic'] ? str(r['topic']) : undefined,
      members: members.filter((m) => m.conversation_id === r['id']).map((m) => m.agent_id)
    }))
  }

  conversation(id: string): Conversation | undefined {
    return this.conversations().find((c) => c.id === id)
  }

  createConversation(c: Omit<Conversation, 'unread'>): void {
    this.tx(() => {
      this.db.prepare('INSERT INTO conversations (id, kind, name, topic, created_at) VALUES (?, ?, ?, ?, ?)').run(c.id, c.kind, c.name, c.topic ?? null, Date.now())
      for (const m of c.members) this.db.prepare('INSERT INTO members (conversation_id, agent_id) VALUES (?, ?)').run(c.id, m)
    })
  }

  // Puts the agent in exactly these channels (DMs are untouched).
  setAgentChannels(agentId: string, channelIds: string[]): string[] {
    const changed: string[] = []
    this.tx(() => {
      for (const c of this.conversations()) {
        if (c.kind !== 'channel') continue
        const has = c.members.includes(agentId)
        const want = channelIds.includes(c.id)
        if (has === want) continue
        if (want) this.db.prepare('INSERT INTO members (conversation_id, agent_id) VALUES (?, ?)').run(c.id, agentId)
        else this.db.prepare('DELETE FROM members WHERE conversation_id = ? AND agent_id = ?').run(c.id, agentId)
        changed.push(c.id)
      }
    })
    return changed
  }

  // ---------- messages ----------

  private toMessage(r: Row): Message {
    const kind = str(r['author_kind'])
    const author: Author = kind === 'agent' ? { kind: 'agent', id: str(r['author_id']) } : kind === 'system' ? { kind: 'system' } : { kind: 'me' }
    return {
      id: str(r['id']),
      conversationId: str(r['conversation_id']),
      author,
      text: str(r['text']),
      at: Number(r['at']),
      run: r['run'] ? (JSON.parse(str(r['run'])) as Run) : undefined
    }
  }

  messages(): Message[] {
    return (this.db.prepare('SELECT * FROM messages ORDER BY at').all() as Row[]).map((r) => this.toMessage(r))
  }

  recentMessages(conversationId: string, limit: number): Message[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY at DESC LIMIT ?').all(conversationId, limit) as Row[]
    return rows.reverse().map((r) => this.toMessage(r))
  }

  message(id: string): Message | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined
    return r && this.toMessage(r)
  }

  saveMessage(m: Message): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET text = excluded.text, run = excluded.run`
      )
      .run(m.id, m.conversationId, m.author.kind, m.author.kind === 'agent' ? m.author.id : null, m.text, m.at, m.run ? JSON.stringify(m.run) : null)
  }

  // Runs that were working when the app closed can't continue: their CLI process is gone.
  interruptStaleRuns(): number {
    let n = 0
    for (const m of this.messages()) {
      if (m.run?.status !== 'working') continue
      n++
      this.saveMessage({
        ...m,
        run: { ...m.run, status: 'interrupted', steps: m.run.steps.map((s) => (s.status === 'running' ? { ...s, status: 'error' } : s)) }
      })
    }
    return n
  }

  // ---------- receipts ----------

  addReceipt(r: Receipt & { messageId: string; agentId: string; engine: string; at: number }): void {
    this.db
      .prepare(
        `INSERT INTO receipts (message_id, agent_id, engine, model, input_tokens, cache_read_tokens, output_tokens, ms, api_cost_usd, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(r.messageId, r.agentId, r.engine, r.model, r.inputTokens, r.cacheReadTokens, r.outputTokens, r.ms, r.apiCostUsd ?? null, r.at)
  }

  receiptTotals(messageId: string): { tokens: number } {
    return this.db
      .prepare('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM receipts WHERE message_id = ?')
      .get(messageId) as { tokens: number }
  }
}
