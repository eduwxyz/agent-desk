// The core runs in an Electron utility process: database, engines and runs
// live here so the window never waits on agent work. The renderer talks to it
// over a MessagePort handed out by the main process.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MessagePortMain } from 'electron'
import type { Api, CoreEvent, Method, Request, Wire } from '../shared/rpc'
import { ENGINES, inQuietHours, WEBHOOK_PORT, type Agent, type Message, type EngineId, type EngineStatus, type Settings } from '../shared/types'
import { Db } from './db'
import { claudeEngine } from './engines/claude'
import { codexEngine } from './engines/codex'
import { adoptLoginShellPath, detectEngines } from './engines/detect'
import { fakeEngine } from './engines/fake'
import type { Engine } from './engines/types'
import { ConnectorManager } from './connectors'
import { Gateway } from './gateway'
import { createServer } from 'node:http'
import { checkJevKey, JEV_MODEL, JEV_SECRET } from './jev'
import { GitHub } from './github'
import { report } from './report'
import { Skills } from './skills'
import { backup, backupIfDue, exportTeam, importTeam } from './team'
import { Telegram } from './telegram'
import { mainCipher, plainCipher, Secrets } from './secrets'
import { checkFolder, Computers, folderName, type Shooter } from './computer'
import { Memories } from './memory'
import { cleanFiles, defaultFiles, projectFolders } from './projects'
import { Routines } from './routines'
import { Runner } from './runs'
import { seed } from './seed'

const dataDir = process.env['AGENT_DESK_DATA'] ?? join(process.cwd(), '.agent-desk')
const fake = process.env['AGENT_DESK_FAKE_ENGINES'] === '1'
mkdirSync(dataDir, { recursive: true })

const db = new Db(join(dataDir, 'agent-desk.db'))
const codexHome = join(dataDir, 'codex-home')
mkdirSync(join(codexHome, '.codex'), { recursive: true })
if (db.created) seed(db)
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

const settings = (): Settings => ({ ...db.getSettings(DEFAULTS), engines, jevKey: db.getSecret(JEV_SECRET) !== undefined, telegram: telegram?.info(), github: githubInfo() })
// github is made further down; settings can be asked for before.
const githubInfo = (): Settings['github'] => githubRef?.info()

const engineImpls: Record<EngineId, Engine> = fake
  ? { claude: fakeEngine('claude'), codex: fakeEngine('codex') }
  : { claude: claudeEngine(() => engines.claude.path), codex: codexEngine(() => engines.codex.path, codexHome) }

// ---------- ports ----------

const ports = new Set<MessagePortMain>()
function emit(event: CoreEvent): void {
  const wire: Wire = { event }
  for (const p of ports) p.postMessage(wire)
  toPhone(event)
}

// The phone gets each new approval and question as it happens (spec §19).
let telegram: Telegram | undefined
let githubRef: GitHub | undefined
const sentToPhone = new Set<string>()
function toPhone(e: CoreEvent): void {
  if (!telegram) return
  const name = (id: string): string => db.agent(id)?.name ?? 'Um agente'
  if (e.type === 'approval' && e.approval.state === 'pending' && !sentToPhone.has(e.approval.id)) {
    sentToPhone.add(e.approval.id)
    void telegram.approvalAsked(e.approval, name(e.approval.agentId))
  } else if (e.type === 'message' && e.message.run?.status === 'waiting_input' && e.message.run.question && e.message.author.kind === 'agent' && !sentToPhone.has(e.message.id)) {
    sentToPhone.add(e.message.id)
    const conv = db.conversation(e.message.conversationId)
    void telegram.questionAsked(e.message, name(e.message.author.id), conv?.kind === 'channel' ? `#${conv.name}` : 'na DM')
  }
}

// Desktop notification, and the same on the phone.
const notifyAll = (title: string, body: string, conversationId?: string): void => {
  toMain({ type: 'notify', title, body, conversationId })
  void telegram?.notice(title, body)
}

// Asks the main process to do what only it can: open the browser or a folder, show a notification.
type ToMain =
  | { type: 'open'; url: string }
  | { type: 'open_path'; path: string }
  | { type: 'notify'; title: string; body: string; conversationId?: string }
  | { type: 'login_item'; open: boolean }
  | { type: 'busy'; busy: boolean }
const toMain = (msg: ToMain): void =>
  process.parentPort.postMessage(msg)

// Screenshots use Electron's Chromium, which lives in the main process.
const shots = new Map<string, { resolve: (b: Buffer) => void; reject: (e: Error) => void }>()
process.parentPort.on('message', (e) => {
  const r = e.data as { type?: string; id: string; data?: string; error?: string; awake?: boolean } | undefined
  if (r?.type === 'power') return routines.setAwake(r.awake === true)
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

// Issue to PR: the GitHub proxy agents' computers push through (spec §22).
const github: GitHub = new GitHub({
  secrets,
  db,
  post: (conversationId, text) => {
    const m: Message = { id: randomUUID(), conversationId, author: { kind: 'system' }, text, at: Date.now() }
    db.saveMessage(m)
    emit({ type: 'message', message: m })
  },
  changed: () => emit({ type: 'settings', settings: settings() })
})

githubRef = github
const computers = new Computers({ db, dataDir, emit, shoot, gitRemote: (agentId) => github.gitRemote(agentId) })
const backups = join(dataDir, 'backups')

// The runner runs routines, and agents schedule routines through the runner's tools.
const routines = new Routines({
  db,
  runner: { runRoutine: (r, when) => runner.runRoutine(r, when) },
  connectors: { call: (id, tool, args) => connectors.call(id, tool, args), list: () => connectors.list() },
  blocked: () => !!settings().paused || inQuietHours(settings().quietHours),
  emit,
  notify: notifyAll
})

const skills = new Skills({ db, emit, notify: (title, body) => notifyAll(title, body) })

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
  routines,
  skills,
  // Approvals reach the phone with their buttons, through toPhone.
  notify: (title, body, conversationId, kind) => (kind === 'approval' ? toMain({ type: 'notify', title, body, conversationId }) : notifyAll(title, body, conversationId)),
  jev: { key: () => secrets.get(JEV_SECRET) },
  github,
  onBusy: (busy) => toMain({ type: 'busy', busy }),
  onQuota: (quota) => {
    db.setSettings({ quota })
    emit({ type: 'settings', settings: settings() })
  }
})
runner.setPaused(!!settings().paused)

telegram = new Telegram({
  secrets,
  decide: (id, decision, reason) => runner.decide(id, decision, reason),
  approval: (id) => db.approval(id),
  answer: (conversationId, text) => void runner.send(conversationId, text),
  changed: () => emit({ type: 'settings', settings: settings() })
})

// Routines started by something on this Mac: POST http://127.0.0.1:WEBHOOK_PORT/gatilho/<token>.
const hooks = createServer((req, res) => {
  const m = /^\/gatilho\/([\w-]{10,})$/.exec(req.url ?? '')
  if (req.method !== 'POST' || !m) return void res.writeHead(404).end('Use POST /gatilho/<código>\n')
  let body = ''
  let tooBig = false
  req.setEncoding('utf8')
  req.on('data', (chunk: string) => {
    body += chunk
    if (body.length > 64_000) tooBig = true
  })
  req.on('end', () => {
    if (tooBig) return void res.writeHead(413).end('Grande demais (máx. 64 KB).\n')
    const r = routines.webhook(m[1]!, body)
    res.writeHead(r === 'ok' ? 202 : r === 'busy' ? 409 : 404).end(r === 'ok' ? 'Rotina disparada.\n' : r === 'busy' ? 'A rotina ainda está rodando.\n' : 'Nenhuma rotina ligada com esse endereço.\n')
  })
})
hooks.on('error', (e) => console.error(`[gatilhos] porta ${WEBHOOK_PORT}:`, e.message))


void ready.then(async () => {
  connectors.connectAll()
  syncProjectFolders() // in case a project or membership changed while the app was closed
  for (const a of db.agents()) if (a.computer && !a.archived) void computers.refresh(a)
  await runner.expireApprovals()
  setInterval(() => void runner.expireApprovals(), 60_000).unref()
  routines.start()
  // Nothing here waits on the keychain: the first use after an update can be a
  // macOS prompt that stays open until someone answers it.
  void github.start().catch((e: unknown) => console.error('[github]', e))
  if (!fake) {
    hooks.listen(WEBHOOK_PORT, '127.0.0.1')
    github.listen()
    void telegram?.start()
  }
  // A copy of the database once a day, the last 7 kept.
  const daily = (): void => {
    try {
      backupIfDue(db, backups)
    } catch (e) {
      console.error('[backup]', e)
    }
  }
  daily()
  setInterval(daily, 3_600_000).unref()
})
toMain({ type: 'login_item', open: !!settings().openAtLogin })

// Project channels lend their folder to members with access; recomputed whenever
// a project or a channel's members change.
function syncProjectFolders(): void {
  const conversations = db.conversations()
  for (const agent of db.agents()) {
    const next = projectFolders(agent, conversations)
    if (next) setFolders(agent, next)
  }
}

function setFolders(agent: Agent, folders: NonNullable<Agent['folders']>): void {
  db.setFolders(agent.id, folders)
  emit({ type: 'agent', agent: db.agent(agent.id)! })
  if (agent.computer) void computers.ensure(agent.id).catch((e: unknown) => console.error('[computer]', e))
}

function emitConversations(ids?: string[]): void {
  for (const c of db.conversations()) if (!ids || ids.includes(c.id)) emit({ type: 'conversation', conversation: c })
}

const demoPath = join(process.cwd(), 'scripts', 'demo-mcp-server.mjs')

const api: Api = {
  // The page loads from file://, which can't fetch agentdesk:// (CORS); text comes through the core instead.
  artifactText: ({ id }) => {
    const a = db.artifacts().find((x) => x.id === id)
    if (!a) return null
    const file = join(dataDir, 'artifacts', a.id, a.name)
    try {
      return readFileSync(file, 'utf8').slice(0, 2_000_000)
    } catch {
      return null
    }
  },

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
    skills: db.skills(),
    packaged: process.env['AGENT_DESK_PACKAGED'] === '1',
    demoServer: existsSync(demoPath) ? { command: 'node', args: [demoPath] } : undefined
  }),

  sendMessage: ({ conversationId, text }) => {
    void runner.send(conversationId, text)
  },

  stopRun: ({ messageId }) => runner.stop(messageId),

  retryRun: ({ messageId }) => runner.retry(messageId),

  continueRun: ({ messageId }) => void runner.continue(messageId),

  saveAgent: ({ agent, channelIds }) => {
    const clean: Agent = { ...agent, name: agent.name.trim(), handle: agent.handle.trim().toLowerCase() }
    const before = db.agent(clean.id)
    const linux = (a?: Agent): boolean => !!a?.computer && a.computerKind !== 'mac'
    const mac = (a?: Agent): boolean => !!a?.computer && a.computerKind === 'mac'
    db.saveAgent(clean)
    // A Linux computer starts right away when turned on (the first time downloads the system) and stops when
    // turned off or moved to the Mac; a computer on the Mac has nothing to start, only its services to stop.
    if (linux(clean) && !linux(before)) void computers.ensure(clean.id).catch(() => {})
    if (linux(before) && !linux(clean))
      void computers.stopLinux(clean.id).then(() => {
        if (mac(clean)) db.removeServices(clean.id) // the container's services don't exist on the Mac
        return computers.refresh(clean)
      })
    if (mac(before) && !mac(clean)) void computers.mac.stopAll(clean.id).then(() => computers.refresh(clean))
    if (mac(clean) && !mac(before)) void computers.refresh(clean)
    const changed = db.setAgentChannels(clean.id, channelIds)
    emit({ type: 'agent', agent: db.agent(clean.id)! })
    emitConversations(changed)
    if (changed.length) syncProjectFolders()
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

  saveSkill: ({ skill }) => skills.save(skill),
  decideSkill: ({ id, approve }) => void skills.decide(id, approve),
  restoreSkill: ({ skillId, versionId }) => void skills.restore(skillId, versionId),
  archiveSkill: ({ id, archived }) => void skills.archive(id, archived),
  removeSkill: ({ id }) => skills.remove(id),
  skillVersions: ({ skillId }) => db.skillVersions(skillId),

  checkTrigger: ({ trigger }) => routines.preview(trigger),

  setTelegramToken: ({ token }) => telegram!.setToken(token),
  setGithubToken: ({ token }) => github.setToken(token),
  exportTeam: () => exportTeam(db),
  importTeam: ({ text }) => {
    const r = importTeam(db, text, settings().defaultLimit)
    for (const a of db.agents()) emit({ type: 'agent', agent: a })
    emitConversations()
    for (const k of db.skills()) emit({ type: 'skill', skill: k })
    for (const r2 of db.routines()) emit({ type: 'routine', routine: r2 })
    return r
  },
  backupNow: () => backup(db, backups),
  openBackups: () => {
    mkdirSync(backups, { recursive: true })
    toMain({ type: 'open_path', path: backups })
  },
  report: () => report(db),
  unpairTelegram: () => void telegram?.unpair(),

  // Checked with TypeSafe before it's saved; null removes it.
  setJevKey: async ({ key }) => {
    const k = key?.trim()
    if (k) await checkJevKey(k)
    await secrets.set(JEV_SECRET, k || undefined)
    if (!k && settings().routerModel === JEV_MODEL) db.setSettings({ routerModel: 'haiku' })
    emit({ type: 'settings', settings: settings() })
  },

  updateSettings: ({ patch: { jevKey: _computed, telegram: _phone, ...patch } }) => {
    db.setSettings(patch)
    if (patch.paused !== undefined) runner.setPaused(patch.paused)
    if (patch.openAtLogin !== undefined) toMain({ type: 'login_item', open: patch.openAtLogin })
    emit({ type: 'settings', settings: settings() })
  },

  // Validation errors come back to the form; connecting continues in the background.
  addConnector: ({ input }) => connectors.add(input),

  removeConnector: ({ id }) => void connectors.remove(id),
  reconnectConnector: ({ id }) => void connectors.connect(id),
  authorizeConnector: ({ id }) => void connectors.authorize(id),
  updateTool: ({ connectorId, name, patch }) => connectors.updateTool(connectorId, name, patch),
  decideApproval: ({ id, decision, reason, always }) => void runner.decide(id, decision, reason?.trim() || undefined, always),

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

  // Lending or returning a folder remakes the computer with the new mounts (what it installed stays).
  lendFolder: ({ agentId, path }) => {
    const agent = db.agent(agentId)
    if (!agent) return
    const why = checkFolder(path, { dataDir })
    if (why) throw new Error(why)
    const folders = agent.folders ?? []
    if (folders.some((f) => f.path === path)) return
    setFolders(agent, [...folders, { name: folderName(path, folders.map((f) => f.name)), path, readOnly: false }])
  },
  setProject: ({ conversationId, project }) => {
    const conv = db.conversation(conversationId)
    if (!conv || conv.kind !== 'channel') return
    if (project) {
      const why = checkFolder(project.folder, { dataDir })
      if (why) throw new Error(why)
      const moved = conv.project?.folder !== project.folder
      const files = cleanFiles(project.files)
      const access = Object.fromEntries(Object.entries(project.access).filter(([id, a]) => conv.members.includes(id) && (a === 'read_write' || a === 'read_only')))
      project = { folder: project.folder, files: moved && files.length === 0 ? defaultFiles(project.folder) : files, brief: project.brief.trim(), access }
    }
    db.setProject(conv.id, project ?? undefined)
    emitConversations([conv.id])
    syncProjectFolders()
  },

  folderAction: ({ agentId, name, action }) => {
    const agent = db.agent(agentId)
    if (!agent) return
    const folders = agent.folders ?? []
    if (folders.find((f) => f.name === name)?.channelId) return // managed by its project channel
    setFolders(agent, action === 'return' ? folders.filter((f) => f.name !== name) : folders.map((f) => (f.name === name ? { ...f, readOnly: action === 'read_only' } : f)))
  },
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
