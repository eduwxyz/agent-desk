// The core runs in an Electron utility process: database, engines and runs
// live here so the window never waits on agent work. The renderer talks to it
// over a MessagePort handed out by the main process.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
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
import { ConnectorManager } from './connectors'
import { Gateway } from './gateway'
import { mainCipher, plainCipher, Secrets } from './secrets'
import { Computers, type Shooter } from './computer'
import { Memories } from './memory'
import { Routines } from './routines'
import { Runner } from './runs'
import { seed } from './seed'

const dataDir = process.env['AGENT_DESK_DATA'] ?? join(process.cwd(), '.agent-desk')
const fake = process.env['AGENT_DESK_FAKE_ENGINES'] === '1'
mkdirSync(dataDir, { recursive: true })

const db = new Db(join(dataDir, 'agent-desk.db'))
const codexHome = join(dataDir, 'codex-home')
mkdirSync(join(codexHome, '.codex'), { recursive: true })
if (db.isEmpty()) seed(db)
const interrupted = db.interruptStaleRuns()
if (interrupted) console.log(`[core] ${interrupted} run(s) marked as interrupted`)

const user = userInfo().username
const DEFAULTS: Omit<Settings, 'engines'> = {
  workspaceName: user ? user[0]!.toUpperCase() + user.slice(1) : 'Eu',
  context: '',
  routerModel: 'haiku',
  memoryModel: 'haiku',
  memoryLearning: 'approve',
  defaultLimit: 2_000_000,
  approvalTtlHours: 24,
  theme: 'system'
}

const unknownEngine: EngineStatus = { installed: false, loggedIn: false }
let engines: Record<EngineId, EngineStatus> = { claude: unknownEngine, codex: unknownEngine }

const fakeStatus = (v: string): EngineStatus => ({ installed: true, loggedIn: true, path: 'fake', version: v, account: 'Motor de teste' })
async function detect(): Promise<void> {
  engines = fake ? { claude: fakeStatus('0.0.0'), codex: fakeStatus('0.0.0') } : await detectEngines(codexHome)
  emit({ type: 'settings', settings: settings() })
}
const gateway = new Gateway()
const ready = Promise.all([gateway.start(), (fake ? Promise.resolve() : adoptLoginShellPath()).then(detect)])

const settings = (): Settings => ({ ...db.getSettings(DEFAULTS), engines })

const engineImpls: Record<EngineId, Engine> = fake
  ? { claude: fakeEngine('claude'), codex: fakeEngine('codex') }
  : { claude: claudeEngine(() => engines.claude.path), codex: codexEngine(() => engines.codex.path, codexHome) }

// ---------- ports ----------

const ports = new Set<MessagePortMain>()
function emit(event: CoreEvent): void {
  const wire: Wire = { event }
  for (const p of ports) p.postMessage(wire)
}

// Asks the main process to do what only it can: open the browser or a folder, show a notification.
type ToMain =
  | { type: 'open'; url: string }
  | { type: 'open_path'; path: string }
  | { type: 'notify'; title: string; body: string; conversationId?: string }
  | { type: 'login_item'; open: boolean }
const toMain = (msg: ToMain): void =>
  process.parentPort.postMessage(msg)

// Screenshots use Electron's Chromium, which lives in the main process.
const shots = new Map<string, { resolve: (b: Buffer) => void; reject: (e: Error) => void }>()
process.parentPort.on('message', (e) => {
  const r = e.data as { type?: string; id: string; data?: string; error?: string } | undefined
  if (r?.type !== 'screenshot-result') return
  const p = shots.get(r.id)
  shots.delete(r.id)
  if (r.error !== undefined) p?.reject(new Error(r.error))
  else p?.resolve(Buffer.from(r.data ?? '', 'base64'))
})
const shoot: Shooter = (opts) =>
  new Promise((resolve, reject) => {
    const id = randomUUID()
    shots.set(id, { resolve, reject })
    process.parentPort.postMessage({ type: 'screenshot', id, ...opts })
  })

const secrets = new Secrets(db, fake ? plainCipher : mainCipher(process.parentPort))
const connectors = new ConnectorManager({
  db,
  secrets,
  emit,
  openUrl: (url) => toMain({ type: 'open', url }),
  oauthCallbackUrl: () => gateway.url('/oauth/callback')
})
gateway.route('/oauth/callback', async (url) => {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state') ?? ''
  if (!code) return `Autorização não concluída: ${url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'sem código'}.`
  return (await connectors.finishOAuth(state, code)) ? 'Conector autorizado. Pode fechar esta aba e voltar pro agent-desk.' : 'Esse pedido de autorização expirou. Tente de novo pelo app.'
})

const memory = new Memories({ db, engines: engineImpls, settings: () => ready.then(settings), emit, workDir: join(dataDir, 'agents') })

const computers = new Computers({ db, dataDir, emit, shoot })

const runner = new Runner({
  db,
  engines: engineImpls,
  settings: () => ready.then(settings),
  emit,
  workDir: join(dataDir, 'agents'),
  gateway,
  connectors,
  memory,
  computers,
  notify: (title, body, conversationId) => toMain({ type: 'notify', title, body, conversationId })
})

const routines = new Routines({ db, runner, emit, notify: (title, body, conversationId) => toMain({ type: 'notify', title, body, conversationId }) })

void ready.then(async () => {
  connectors.connectAll()
  for (const a of db.agents()) if (a.computer && !a.archived) void computers.refresh(a)
  await runner.expireApprovals()
  setInterval(() => void runner.expireApprovals(), 60_000).unref()
  routines.start()
})
toMain({ type: 'login_item', open: !!settings().openAtLogin })

function emitConversations(ids?: string[]): void {
  for (const c of db.conversations()) if (!ids || ids.includes(c.id)) emit({ type: 'conversation', conversation: c })
}

const demoPath = join(process.cwd(), 'scripts', 'demo-mcp-server.mjs')

const api: Api = {
  snapshot: () => ({
    settings: settings(),
    agents: db.agents(),
    conversations: db.conversations(),
    messages: db.messages(),
    connectors: connectors.list(),
    approvals: db.approvals(),
    memories: db.memories(),
    artifacts: db.artifacts(),
    computers: db.agents().map((a) => computers.info(a)),
    routines: db.routines(),
    packaged: process.env['AGENT_DESK_PACKAGED'] === '1',
    demoServer: existsSync(demoPath) ? { command: 'node', args: [demoPath] } : undefined
  }),

  sendMessage: ({ conversationId, text }) => {
    void runner.send(conversationId, text)
  },

  stopRun: ({ messageId }) => runner.stop(messageId),

  retryRun: ({ messageId }) => runner.retry(messageId),

  saveAgent: ({ agent, channelIds }) => {
    const clean: Agent = { ...agent, name: agent.name.trim(), handle: agent.handle.trim().toLowerCase() }
    const before = db.agent(clean.id)
    db.saveAgent(clean)
    // Turning the computer on starts it right away (the first time downloads the system); off stops it.
    if (clean.computer && !before?.computer) void computers.ensure(clean.id).catch(() => {})
    else if (!clean.computer && before?.computer) void computers.stop(clean.id).then(() => computers.refresh(clean))
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
    if (patch.openAtLogin !== undefined) toMain({ type: 'login_item', open: patch.openAtLogin })
    emit({ type: 'settings', settings: settings() })
  },

  // Validation errors come back to the form; connecting continues in the background.
  addConnector: ({ input }) => connectors.add(input),

  removeConnector: ({ id }) => void connectors.remove(id),
  reconnectConnector: ({ id }) => void connectors.connect(id),
  authorizeConnector: ({ id }) => void connectors.authorize(id),
  updateTool: ({ connectorId, name, patch }) => connectors.updateTool(connectorId, name, patch),
  decideApproval: ({ id, decision, reason }) => void runner.decide(id, decision, reason?.trim() || undefined),

  addMemory: ({ scope, text }) => memory.add(scope, text),
  editMemory: ({ id, text }) => memory.edit(id, text),
  confirmMemory: ({ id }) => memory.confirm(id),
  decideMemory: ({ id, accept }) => memory.decide(id, accept),
  forgetMemory: ({ id, reason }) => memory.forget(id, reason?.trim() || undefined),
  purgeMemory: ({ id }) => memory.purge(id),
  editSummary: ({ conversationId, text }) => memory.editSummary(conversationId, text),
  summarizeNow: ({ conversationId }) => void memory.consolidate(conversationId, true),

  computerAction: ({ agentId, action }) => {
    const agent = db.agent(agentId)
    if (!agent) return
    if (action === 'open_folder') {
      mkdirSync(computers.folder(agentId), { recursive: true })
      return toMain({ type: 'open_path', path: computers.folder(agentId) })
    }
    const run = { start: () => computers.ensure(agentId), restart: () => computers.restart(agentId), erase: () => computers.erase(agentId), refresh: () => computers.refresh(agent) }[action]
    void run().catch((e: unknown) => console.error('[computer]', e))
  },
  stopService: ({ agentId, name }) => void computers.stopService(agentId, name),
  openExternal: ({ url }) => toMain({ type: 'open', url }),

  saveRoutine: ({ routine }) => routines.save(routine),
  removeRoutine: ({ id }) => routines.remove(id),
  runRoutine: ({ id }) => routines.runNow(id),

  refreshEngines: () => {
    void detect()
  },

  // Login always happens in the CLI's own flow; the app never sees credentials.
  // Codex logs into the app's own home (see codexEnv), separate from the user's.
  loginEngine: ({ engine }) => {
    const bin = engines[engine].path ?? ENGINES[engine].cli
    const sub = ENGINES[engine].login.split(' ').slice(1).join(' ')
    const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
    const cmd = engine === 'codex' ? `HOME=${q(codexHome)} CODEX_HOME=${q(join(codexHome, '.codex'))} ${q(bin)} ${sub}` : `${q(bin)} ${sub}`
    execFile('osascript', ['-e', 'tell application "Terminal" to activate', '-e', `tell application "Terminal" to do script ${JSON.stringify(cmd)}`])
  }
}

function handle(port: MessagePortMain, req: Request): void {
  const reply = (r: Omit<Extract<Wire, { id: number }>, 'id'>): void => port.postMessage({ id: req.id, ...r } satisfies Wire)
  const fn = api[req.method as Method] as ((p: unknown) => unknown) | undefined
  if (!fn) return reply({ error: `unknown method ${req.method}` })
  Promise.resolve()
    .then(() => fn(req.params))
    .then(
      (result) => reply({ result }),
      (e: unknown) => {
        console.error(`[core] ${req.method}`, e)
        reply({ error: e instanceof Error ? e.message : String(e) })
      }
    )
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
