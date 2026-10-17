// The core runs in an Electron utility process: database, engines and runs
// live here so the window never waits on agent work. The renderer talks to it
// over a MessagePort handed out by the main process.
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MessagePortMain } from 'electron'
import type { Api, CoreEvent, Method, Request, Wire } from '../shared/rpc'
import { ENGINES, type Agent, type EngineId, type EngineStatus, type Settings } from '../shared/types'
import { Db } from './db'
import { claudeEngine } from './engines/claude'
import { codexEngine } from './engines/codex'
import { adoptLoginShellPath, detectEngines } from './engines/detect'
import { fakeEngine } from './engines/fake'
import type { Engine } from './engines/types'
import { Runner } from './runs'
import { seed } from './seed'

const dataDir = process.env['AGENT_DESK_DATA'] ?? join(process.cwd(), '.agent-desk')
const fake = process.env['AGENT_DESK_FAKE_ENGINES'] === '1'
mkdirSync(dataDir, { recursive: true })

const db = new Db(join(dataDir, 'agent-desk.db'))
if (db.isEmpty()) seed(db)
const interrupted = db.interruptStaleRuns()
if (interrupted) console.log(`[core] ${interrupted} run(s) marked as interrupted`)

const user = userInfo().username
const DEFAULTS: Omit<Settings, 'engines'> = {
  workspaceName: user ? user[0]!.toUpperCase() + user.slice(1) : 'Eu',
  context: '',
  routerModel: 'haiku',
  defaultLimit: 2_000_000,
  theme: 'system'
}

const unknownEngine: EngineStatus = { installed: false, loggedIn: false }
let engines: Record<EngineId, EngineStatus> = { claude: unknownEngine, codex: unknownEngine }

const fakeStatus = (v: string): EngineStatus => ({ installed: true, loggedIn: true, path: 'fake', version: v, account: 'Motor de teste' })
async function detect(): Promise<void> {
  engines = fake ? { claude: fakeStatus('0.0.0'), codex: fakeStatus('0.0.0') } : await detectEngines()
  emit({ type: 'settings', settings: settings() })
}
const ready = (fake ? Promise.resolve() : adoptLoginShellPath()).then(detect)

const settings = (): Settings => ({ ...db.getSettings(DEFAULTS), engines })

const engineImpls: Record<EngineId, Engine> = fake
  ? { claude: fakeEngine('claude'), codex: fakeEngine('codex') }
  : { claude: claudeEngine(() => engines.claude.path), codex: codexEngine(() => engines.codex.path) }

// ---------- ports ----------

const ports = new Set<MessagePortMain>()
function emit(event: CoreEvent): void {
  const wire: Wire = { event }
  for (const p of ports) p.postMessage(wire)
}

const runner = new Runner({
  db,
  engines: engineImpls,
  settings: () => ready.then(settings),
  emit,
  workDir: join(dataDir, 'agents')
})

function emitConversations(ids?: string[]): void {
  for (const c of db.conversations()) if (!ids || ids.includes(c.id)) emit({ type: 'conversation', conversation: c })
}

const api: Api = {
  snapshot: () => ({ settings: settings(), agents: db.agents(), conversations: db.conversations(), messages: db.messages() }),

  sendMessage: ({ conversationId, text }) => {
    void runner.send(conversationId, text)
  },

  stopRun: ({ messageId }) => runner.stop(messageId),

  saveAgent: ({ agent, channelIds }) => {
    const clean: Agent = { ...agent, name: agent.name.trim(), handle: agent.handle.trim().toLowerCase() }
    db.saveAgent(clean)
    const changed = db.setAgentChannels(clean.id, channelIds)
    emit({ type: 'agent', agent: db.agent(clean.id)! })
    emitConversations(changed)
  },

  createChannel: ({ name }) => {
    const id = randomUUID()
    db.createConversation({ id, kind: 'channel', name, members: [] })
    emitConversations([id])
    return id
  },

  openDm: ({ agentId }) => {
    const existing = db.conversations().find((c) => c.kind === 'dm' && c.name === agentId)
    if (existing) return existing.id
    const id = randomUUID()
    db.createConversation({ id, kind: 'dm', name: agentId, members: [agentId] })
    emitConversations([id])
    return id
  },

  updateSettings: ({ patch }) => {
    db.setSettings(patch)
    emit({ type: 'settings', settings: settings() })
  },

  refreshEngines: () => {
    void detect()
  },

  // Login always happens in the CLI's own flow; the app never sees credentials.
  loginEngine: ({ engine }) => {
    const cmd = engines[engine].path ? `${engines[engine].path!} ${ENGINES[engine].login.split(' ').slice(1).join(' ')}` : ENGINES[engine].login
    execFile('osascript', ['-e', 'tell application "Terminal" to activate', '-e', `tell application "Terminal" to do script ${JSON.stringify(cmd)}`])
  }
}

function handle(port: MessagePortMain, req: Request): void {
  const reply = (r: Omit<Extract<Wire, { id: number }>, 'id'>): void => port.postMessage({ id: req.id, ...r } satisfies Wire)
  const fn = api[req.method as Method] as ((p: unknown) => unknown) | undefined
  if (!fn) return reply({ error: `unknown method ${req.method}` })
  try {
    reply({ result: fn(req.params) })
  } catch (e) {
    console.error(`[core] ${req.method}`, e)
    reply({ error: e instanceof Error ? e.message : String(e) })
  }
}

process.parentPort.on('message', (e) => {
  const port = e.ports[0]
  if (!port) return
  ports.add(port)
  port.on('message', (m) => handle(port, m.data as Request))
  port.on('close', () => ports.delete(port))
  port.start()
})

process.on('exit', () => db.close())
