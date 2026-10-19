// Each agent can have a computer of its own (spec §13): a Linux container,
// created and kept by the app, where the agent installs, builds and runs
// anything without asking. The CLI (and the subscription login) stays on the
// Mac; the computer only receives commands through these tools.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, posix, sep } from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { CoreEvent } from '../shared/rpc'
import { PROJECTS_DIR, type Agent, type Artifact, type ArtifactKind, type ComputerInfo, type LentFolder, type Service } from '../shared/types'
import type { Db } from './db'
import { textResult, type ToolDef } from './gateway'
import { MacComputer, macTools } from './mac'

export const IMAGE = 'node:22-bookworm'
export const PORTS = [3000, 3001, 4173, 5000, 5173, 8000, 8080, 8501, 8888]
const WORK = '/work'
const MAX_OUTPUT = 30_000 // characters of command output handed back to the model
const MAX_FILE = 200_000 // characters read_file returns
const MAX_SHOW_BYTES = 50 * 1024 * 1024

// ---------- folders lent from the Mac (M5.1) ----------

// Why a folder can't be lent, or null. Only folders inside the home folder,
// never the home itself, Library, hidden folders (~/.ssh, ~/.config…) or the app's own data.
export function checkFolder(path: string, opts: { home?: string; dataDir: string }): string | null {
  let real: string
  try {
    real = realpathSync(path)
    if (!statSync(real).isDirectory()) return 'Isso não é uma pasta.'
  } catch {
    return 'Essa pasta não existe.'
  }
  const home = realpathSync(opts.home ?? homedir())
  if (!real.startsWith(home + sep)) return 'Só dá pra emprestar pastas dentro da sua pasta de usuário.'
  const top = real.slice(home.length + 1).split(sep)[0]!
  if (top === 'Library' || top.startsWith('.')) return 'Essa pasta guarda configurações e credenciais do Mac; não dá pra emprestar.'
  const data = existsSync(opts.dataDir) ? realpathSync(opts.dataDir) : opts.dataDir
  if (data === real || data.startsWith(real + sep) || real.startsWith(data + sep)) return 'Essa pasta tem os dados do próprio agent-desk; não dá pra emprestar.'
  return null
}

// /projetos/<name>: the folder's name, made safe, and unique among the agent's folders.
export function folderName(path: string, taken: string[]): string {
  const base = basename(path).toLowerCase().normalize('NFD').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'pasta'
  let name = base
  for (let i = 2; taken.includes(name); i++) name = `${base}-${i}`
  return name
}

// Folders the Mac uses for its own builds of dependencies. Inside the computer
// each gets a volume of its own, so Linux installs never replace the Mac's.
const OWN_DEPS = ['node_modules', '.venv']

export function mountArgs(container: string, folders: LentFolder[], exists: (p: string) => boolean = existsSync): string[] {
  return folders.flatMap((f) => {
    const at = `${PROJECTS_DIR}/${f.name}`
    const deps = f.readOnly ? [] : OWN_DEPS.filter((d) => d === 'node_modules' || exists(join(f.path, d)))
    return ['-v', `${f.path}:${at}${f.readOnly ? ':ro' : ''}`, ...deps.flatMap((d) => ['-v', `${container}-${f.name}-${d.replace('.', '')}:${at}/${d}`])]
  })
}

export type Shooter = (opts: { url: string; width: number; height: number; fullPage: boolean }) => Promise<Buffer>

export const COMPUTER_TOOLS: ToolDef[] = [
  {
    name: 'bash',
    description: `Roda um comando bash no seu computador (Linux Debian, você é root, com internet), na pasta ${WORK}. Use pra instalar (apt, pip, npm), criar, rodar e testar qualquer coisa. Pra servidores que ficam rodando, use start_service.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'O comando, como no terminal.' },
        timeout_seconds: { type: 'number', description: 'Tempo máximo, de 1 a 600. Default 120.' }
      },
      required: ['command']
    }
  },
  {
    name: 'read_file',
    description: 'Lê um arquivo de texto do seu computador.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: `Caminho absoluto ou relativo a ${WORK}.` } }, required: ['path'] }
  },
  {
    name: 'write_file',
    description: 'Cria ou sobrescreve um arquivo no seu computador, criando as pastas que faltarem.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: `Caminho absoluto ou relativo a ${WORK}.` }, content: { type: 'string' } },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description: 'Troca um trecho exato de um arquivo por outro. O trecho precisa aparecer uma vez só, a não ser com replace_all.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string', description: 'O trecho atual, igualzinho ao arquivo.' },
        new_text: { type: 'string' },
        replace_all: { type: 'boolean' }
      },
      required: ['path', 'old_text', 'new_text']
    }
  },
  {
    name: 'start_service',
    description: `Deixa um processo rodando em segundo plano (servidor web, API, dashboard) e confere se ele abriu a porta. O servidor precisa escutar em 0.0.0.0 (ex.: "npx vite --host 0.0.0.0 --port 5173", "python3 -m http.server 8000 --bind 0.0.0.0"). Portas disponíveis: ${PORTS.join(', ')}. O log fica em ${WORK}/.logs/<nome>.log. Iniciar de novo com o mesmo nome reinicia.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nome curto, ex.: "dashboard".' },
        command: { type: 'string', description: `Comando, rodado em ${WORK}.` },
        port: { type: 'number', description: 'A porta em que ele escuta.' }
      },
      required: ['name', 'command', 'port']
    }
  },
  {
    name: 'stop_service',
    description: 'Para um serviço iniciado com start_service.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  },
  {
    name: 'screenshot',
    description:
      'Tira um print de uma página web e mostra no chat; você também recebe a imagem. Use http://localhost:<porta> pra ver um serviço do seu computador, ou qualquer URL da internet.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        full_page: { type: 'boolean', description: 'A página inteira, não só a primeira tela.' },
        width: { type: 'number', description: 'Largura da janela, default 1280.' }
      },
      required: ['url']
    }
  },
  {
    name: 'show_file',
    description:
      'Mostra um arquivo do seu computador no chat: imagem, Markdown, HTML, PDF, CSV ou texto. O arquivo é guardado como está agora. HTML precisa ser autossuficiente (CSS e JS dentro dele); pra um app com vários arquivos, use start_service e screenshot.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, title: { type: 'string', description: 'Um título curto pro card no chat.' } },
      required: ['path']
    }
  }
]

export const COMPUTER_TOOL_NAMES = new Set(COMPUTER_TOOLS.map((t) => t.name))

// The tools as the agent sees them: described for its Linux computer or for the Mac.
export const computerTools = (agent: Pick<Agent, 'computerKind'>): ToolDef[] => (agent.computerKind === 'mac' ? macTools() : COMPUTER_TOOLS)

// ---------- pure helpers (tested on their own) ----------

// Long output keeps its start and, mostly, its end: errors usually come last.
export function clipOutput(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.2)
  return `${text.slice(0, head)}\n[… ${text.length - max} caracteres cortados …]\n${text.slice(text.length - (max - head))}`
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

export function formatExec(r: { code: number; stdout: string; stderr: string }, timeoutSeconds: number): string {
  const timedOut = r.code === 124
  const out = r.stdout.replace(ANSI, '').trimEnd()
  const err = r.stderr.replace(ANSI, '').trimEnd()
  return clipOutput(
    [
      timedOut ? `Parou: passou de ${timeoutSeconds} s. Pra algo que fica rodando, use start_service.` : `exit code ${r.code}`,
      out && `--- stdout ---\n${out}`,
      err && `--- stderr ---\n${err}`,
      !out && !err && '(sem saída)'
    ]
      .filter(Boolean)
      .join('\n')
  )
}

// A path as the agent writes it, resolved inside the computer.
export function containerPath(p: string): string {
  return linuxPath(p)
}

function linuxPath(p: string): string {
  return posix.normalize(p.startsWith('/') ? p : posix.join(WORK, p))
}

// Whether something listens on a port, from /proc/net/tcp{,6}: on every
// interface (reachable from the Mac) or only on loopback (not reachable).
export function listening(procNet: string, port: number): 'all' | 'loopback' | null {
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  let found: 'all' | 'loopback' | null = null
  for (const line of procNet.split('\n')) {
    const cols = line.trim().split(/\s+/)
    const [addr, p] = (cols[1] ?? '').split(':')
    if (cols[3] !== '0A' || p !== hex || !addr) continue // 0A = LISTEN
    if (/^0+$/.test(addr)) return 'all'
    found = 'loopback'
  }
  return found
}

export function artifactKind(name: string): ArtifactKind {
  const ext = extname(name).toLowerCase().slice(1)
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image'
  if (['md', 'markdown'].includes(ext)) return 'markdown'
  if (['html', 'htm'].includes(ext)) return 'html'
  if (ext === 'pdf') return 'pdf'
  if (['csv', 'tsv'].includes(ext)) return 'csv'
  if (['txt', 'log', 'json', 'yaml', 'yml', 'toml', 'xml', 'js', 'ts', 'tsx', 'jsx', 'py', 'sql', 'sh', 'css', 'rb', 'go', 'rs', 'java'].includes(ext)) return 'text'
  return 'file'
}

// The URL a screenshot should load on the Mac: localhost ports of the computer map to their published ports.
export function hostUrl(url: string, ports: Record<number, number>): string | { error: string } {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { error: `URL inválida: ${url}` }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Só URLs http e https.' }
  if (!['localhost', '127.0.0.1', '0.0.0.0'].includes(u.hostname)) return u.toString()
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  const host = ports[port]
  if (!host) return { error: `A porta ${port} do seu computador não está aberta pro Mac. Use uma destas: ${PORTS.join(', ')}.` }
  u.hostname = '127.0.0.1'
  u.port = String(host)
  return u.toString()
}

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

// ---------- docker ----------

type Exec = { code: number; stdout: string; stderr: string }

function docker(args: string[], opts: { stdin?: string | Buffer; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Exec> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout = (stdout + d).slice(-2_000_000)))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-200_000)))
    const kill = (): void => void child.kill('SIGKILL')
    const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : null
    opts.signal?.addEventListener('abort', kill, { once: true })
    child.on('error', (e) => {
      stderr += e.message
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', kill)
      resolve({ code: code ?? -1, stdout, stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(opts.stdin ?? '')
  })
}

export interface ToolOutcome {
  result: CallToolResult
  artifact?: Artifact
  service?: string
}

export interface ComputerDeps {
  db: Db
  dataDir: string
  emit: (e: CoreEvent) => void
  shoot?: Shooter // screenshots need the main process (Electron's Chromium)
  gitRemote?: (agentId: string) => string | undefined // the app's GitHub proxy for this agent (spec §22)
}

export class Computers {
  private infos = new Map<string, ComputerInfo>()
  private gitSet = new Set<string>() // computers whose git already goes through the proxy, this session
  private ports = new Map<string, Record<number, number>>()
  private starting = new Map<string, Promise<void>>()
  private prefix: string
  readonly mac: MacComputer // agents whose computer is this Mac (spec §23)

  constructor(private deps: ComputerDeps) {
    this.mac = new MacComputer({ db: deps.db, dataDir: deps.dataDir, emit: deps.emit, shoot: deps.shoot })
    // Containers of another data directory (tests, a second install) never collide.
    this.prefix = `agentdesk-${createHash('sha1').update(deps.dataDir).digest('hex').slice(0, 6)}`
  }

  name(agentId: string): string {
    return `${this.prefix}-${agentId.slice(0, 8)}`
  }

  folder(agentId: string): string {
    return join(this.deps.dataDir, 'computers', agentId, 'work')
  }

  private onMac(agentId: string): Agent | undefined {
    const a = this.deps.db.agent(agentId)
    return a?.computerKind === 'mac' ? a : undefined
  }

  info(agent: Agent): ComputerInfo {
    if (agent.computerKind === 'mac') return this.mac.info(agent)
    return this.infos.get(agent.id) ?? { agentId: agent.id, state: agent.computer ? 'stopped' : 'off', folder: this.folder(agent.id), services: [] }
  }

  private set(agentId: string, patch: Partial<ComputerInfo>): void {
    const prev = this.infos.get(agentId) ?? { agentId, state: 'stopped' as const, folder: this.folder(agentId), services: [] }
    const next = { ...prev, ...patch }
    if (!('detail' in patch)) delete next.detail
    this.infos.set(agentId, next)
    this.deps.emit({ type: 'computer', computer: next })
  }

  // Reads the container's real state, for the agent page.
  async refresh(agent: Agent): Promise<void> {
    if (agent.computerKind === 'mac') return this.mac.refresh(agent)
    if (!agent.computer) return this.set(agent.id, { state: 'off', services: [] })
    const r = await docker(['inspect', '-f', '{{.State.Running}}', this.name(agent.id)], { timeoutMs: 10_000 })
    if (r.code !== 0) {
      const down = /daemon|connect/i.test(r.stderr)
      return this.set(agent.id, { state: down ? 'no_docker' : 'stopped', detail: down ? 'O Docker não está rodando. Abra o Docker Desktop.' : undefined, services: [] })
    }
    if (r.stdout.trim() !== 'true') return this.set(agent.id, { state: 'stopped', services: [] })
    await this.readPorts(agent.id)
    this.set(agent.id, { state: 'running', services: await this.serviceStatus(agent.id) })
  }

  // Creates or starts the container. The first time pulls the image, which takes a while.
  ensure(agentId: string): Promise<void> {
    if (this.onMac(agentId)) return Promise.resolve()
    const current = this.starting.get(agentId)
    if (current) return current
    const p = this.doEnsure(agentId).finally(() => this.starting.delete(agentId))
    this.starting.set(agentId, p)
    return p
  }

  // The computer's state (what the agent installed) saved as an image, so it survives a remount.
  private stateImage(agentId: string): string {
    return `${this.name(agentId)}:estado`
  }

  private async doEnsure(agentId: string): Promise<void> {
    const name = this.name(agentId)
    const mounts = mountArgs(name, this.deps.db.agent(agentId)?.folders ?? [])
    const sig = mounts.length ? createHash('sha1').update(JSON.stringify(mounts)).digest('hex').slice(0, 12) : ''
    let state = await docker(['inspect', '-f', '{{.State.Running}} {{index .Config.Labels "agent-desk.mounts"}}', name], { timeoutMs: 15_000 })
    const [running, raw = ''] = state.stdout.trim().split(' ')
    const label = raw === '<no' ? '' : raw // "<no value>": made before folders existed
    // Folders are mounted when the container is made: lending or returning one makes it again, from its saved state.
    if (state.code === 0 && label !== sig) {
      this.set(agentId, { state: 'starting', detail: 'Trocando as pastas emprestadas (reinicia o computador)…' })
      const commit = await docker(['commit', name, this.stateImage(agentId)], { timeoutMs: 10 * 60_000 })
      if (commit.code !== 0) return this.fail(agentId, commit.stderr)
      await docker(['rm', '-f', name], { timeoutMs: 60_000 })
      this.deps.db.removeServices(agentId)
      this.ports.delete(agentId)
      state = { code: 1, stdout: '', stderr: 'No such object' }
    }
    if (state.code === 0 && running === 'true') {
      if (!this.ports.has(agentId)) await this.readPorts(agentId)
      await this.pointGit(agentId)
      if (this.infos.get(agentId)?.state !== 'running') this.set(agentId, { state: 'running', services: await this.serviceStatus(agentId) })
      return
    }
    if (/daemon|connect to the docker/i.test(state.stderr)) {
      this.set(agentId, { state: 'no_docker', detail: 'O Docker não está rodando. Abra o Docker Desktop.' })
      throw new Error('O Docker não está rodando no Mac. Peça pro usuário abrir o Docker Desktop.')
    }

    if (state.code === 0) {
      this.set(agentId, { state: 'starting', detail: 'Ligando o computador…' })
      const r = await docker(['start', name], { timeoutMs: 60_000 })
      if (r.code !== 0) return this.fail(agentId, r.stderr)
    } else {
      const saved = (await docker(['image', 'inspect', this.stateImage(agentId)], { timeoutMs: 15_000 })).code === 0
      const image = saved ? this.stateImage(agentId) : IMAGE
      if (!saved && (await docker(['image', 'inspect', IMAGE], { timeoutMs: 15_000 })).code !== 0) {
        this.set(agentId, { state: 'starting', detail: 'Baixando o sistema do computador (só na primeira vez, alguns minutos)…' })
        const pull = await docker(['pull', IMAGE], { timeoutMs: 30 * 60_000 })
        if (pull.code !== 0) return this.fail(agentId, pull.stderr)
      }
      this.set(agentId, { state: 'starting', detail: 'Montando o computador…' })
      const folder = this.folder(agentId)
      mkdirSync(folder, { recursive: true })
      const agent = this.deps.db.agent(agentId)
      const run = await docker(
        [
          'run', '-d',
          '--name', name,
          '--hostname', agent?.handle || 'agente',
          '--label', 'agent-desk=1',
          '--label', `agent-desk.agent=${agentId}`,
          '--label', `agent-desk.mounts=${sig}`,
          '--init',
          '--memory', '3g',
          '--cpus', '2',
          '-w', WORK,
          '-v', `${folder}:${WORK}`,
          ...mounts,
          ...PORTS.flatMap((p) => ['-p', `127.0.0.1::${p}`]),
          image,
          'sleep', 'infinity'
        ],
        { timeoutMs: 120_000 }
      )
      if (run.code !== 0) return this.fail(agentId, run.stderr)
      // Lent repositories belong to the Mac's user, not root: let git work in them.
      await docker(['exec', name, 'git', 'config', '--global', '--add', 'safe.directory', '*'], { timeoutMs: 15_000 })
      // Returned folders leave their empty mount points in the saved state. Only empty
      // directories of names no longer lent go, so nothing mounted is ever touched.
      const lent = (this.deps.db.agent(agentId)?.folders ?? []).map((f) => f.name)
      const clean = `cd ${PROJECTS_DIR} 2>/dev/null || exit 0; for d in */; do d="\${d%/}"; case " ${lent.join(' ')} " in *" $d "*) ;; *) find "$d" -xdev -depth -type d -empty -delete ;; esac; done; true`
      await docker(['exec', name, 'bash', '-c', clean], { timeoutMs: 15_000 })
    }
    await this.readPorts(agentId)
    await this.pointGit(agentId)
    this.set(agentId, { state: 'running', services: await this.serviceStatus(agentId) })
  }

  // GitHub, by any of its URL forms, goes through the app's proxy, which adds the
  // token outside the computer and lets through only what the project allows.
  private async pointGit(agentId: string): Promise<void> {
    const via = this.deps.gitRemote?.(agentId)
    if (!via || this.gitSet.has(agentId)) return
    const name = this.name(agentId)
    for (const [from, match] of [['https://github.com/', '^https://github'], ['git@github.com:', '^git@github'], ['ssh://git@github.com/', '^ssh://']] as const) {
      await docker(['exec', name, 'git', 'config', '--global', '--replace-all', `url.${via}.insteadOf`, from, match], { timeoutMs: 15_000 })
    }
    this.gitSet.add(agentId)
  }

  private fail(agentId: string, stderr: string): never {
    const detail = stderr.trim().split('\n').slice(-2).join(' ') || 'falhou sem mensagem'
    this.set(agentId, { state: 'error', detail })
    throw new Error(`Não consegui ligar o computador: ${detail}`)
  }

  private async readPorts(agentId: string): Promise<void> {
    const r = await docker(['port', this.name(agentId)], { timeoutMs: 10_000 })
    const map: Record<number, number> = {}
    for (const m of r.stdout.matchAll(/^(\d+)\/tcp -> 127\.0\.0\.1:(\d+)$/gm)) map[Number(m[1])] = Number(m[2])
    this.ports.set(agentId, map)
  }

  async stop(agentId: string): Promise<void> {
    if (this.onMac(agentId)) return this.mac.stopAll(agentId)
    return this.stopLinux(agentId)
  }

  // The container only, whatever the agent's computer is now (used when it moves to the Mac or turns off).
  async stopLinux(agentId: string): Promise<void> {
    await docker(['stop', '-t', '5', this.name(agentId)], { timeoutMs: 60_000 })
    this.ports.delete(agentId)
    this.set(agentId, { state: 'stopped', services: await this.serviceStatus(agentId) })
  }

  async restart(agentId: string): Promise<void> {
    if (this.onMac(agentId)) return this.mac.stopAll(agentId)
    await this.stop(agentId)
    await this.ensure(agentId)
  }

  // Everything goes: the container, what was installed, and /work.
  async erase(agentId: string): Promise<void> {
    const mac = this.onMac(agentId)
    if (mac) return this.mac.erase(agentId).then(() => this.mac.refresh(mac))
    await docker(['rm', '-f', this.name(agentId)], { timeoutMs: 60_000 })
    await docker(['rmi', '-f', this.stateImage(agentId)], { timeoutMs: 60_000 })
    const volumes = await docker(['volume', 'ls', '-q', '--filter', `name=^${this.name(agentId)}-`], { timeoutMs: 15_000 })
    const ids = volumes.stdout.split('\n').filter(Boolean)
    if (ids.length) await docker(['volume', 'rm', '-f', ...ids], { timeoutMs: 60_000 })
    rmSync(join(this.deps.dataDir, 'computers', agentId), { recursive: true, force: true })
    this.deps.db.removeServices(agentId)
    this.ports.delete(agentId)
    const agent = this.deps.db.agent(agentId)
    this.set(agentId, { state: agent?.computer ? 'stopped' : 'off', services: [] })
  }

  exec(agentId: string, command: string, opts: { timeoutSeconds?: number; signal?: AbortSignal; stdin?: string | Buffer } = {}): Promise<Exec> {
    const t = Math.min(600, Math.max(1, Math.round(opts.timeoutSeconds ?? 120)))
    // `timeout` runs inside, so the command stops even if the docker client is killed.
    return docker(['exec', ...(opts.stdin !== undefined ? ['-i'] : []), '-w', WORK, '-e', 'TERM=dumb', this.name(agentId), 'timeout', '-k', '5', String(t), 'bash', '-lc', command], {
      timeoutMs: (t + 15) * 1000,
      signal: opts.signal,
      stdin: opts.stdin
    })
  }

  // ---------- services ----------

  private async serviceStatus(agentId: string): Promise<Service[]> {
    const rows = this.deps.db.services(agentId)
    if (rows.length === 0) return []
    const ports = this.ports.get(agentId) ?? {}
    const r = await docker(
      ['exec', this.name(agentId), 'bash', '-c', rows.map((s) => `kill -0 "$(cat /run/agentdesk/${s.name}.pid 2>/dev/null)" 2>/dev/null && echo ${s.name}`).join('; ') + '; true'],
      { timeoutMs: 10_000 }
    )
    const alive = new Set(r.stdout.split('\n').filter(Boolean))
    return rows.map((s) => ({ ...s, running: alive.has(s.name), url: alive.has(s.name) && ports[s.port] ? `http://127.0.0.1:${ports[s.port]}` : undefined }))
  }

  private async refreshServices(agentId: string): Promise<Service[]> {
    const services = await this.serviceStatus(agentId)
    this.set(agentId, { services })
    return services
  }

  async stopService(agentId: string, name: string): Promise<boolean> {
    if (this.onMac(agentId)) return this.mac.stopService(agentId, name)
    const pid = `/run/agentdesk/${name}.pid`
    const r = await docker(
      ['exec', this.name(agentId), 'bash', '-c', `p=$(cat ${pid} 2>/dev/null) || exit 3; kill -TERM -- -$p 2>/dev/null; for i in 1 2 3 4 5 6; do kill -0 $p 2>/dev/null || exit 0; sleep 0.5; done; kill -KILL -- -$p 2>/dev/null; exit 0`],
      { timeoutMs: 20_000 }
    )
    this.deps.db.removeServices(agentId, name)
    await this.refreshServices(agentId)
    return r.code === 0
  }

  private async startService(agentId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
    const name = typeof args['name'] === 'string' ? args['name'].trim() : ''
    const command = typeof args['command'] === 'string' ? args['command'].trim() : ''
    const port = Number(args['port'])
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name)) return { result: textResult('Nome inválido: use letras, números, - ou _.', true) }
    if (!command) return { result: textResult('Faltou o comando.', true) }
    if (!PORTS.includes(port)) return { result: textResult(`Porta ${port} não está aberta pro Mac. Use uma destas: ${PORTS.join(', ')}.`, true) }
    const taken = this.deps.db.services(agentId).find((s) => s.port === port && s.name !== name)
    if (taken) return { result: textResult(`A porta ${port} já é do serviço "${taken.name}". Pare ele ou use outra porta.`, true) }

    if (this.deps.db.services(agentId).some((s) => s.name === name)) await this.stopService(agentId, name)
    const log = `${WORK}/.logs/${name}.log`
    await docker(['exec', this.name(agentId), 'bash', '-c', `mkdir -p /run/agentdesk ${WORK}/.logs && : > ${q(log)}`], { timeoutMs: 10_000 })
    // setsid gives the service its own process group, so stopping it stops its children too.
    const script = `echo $$ > /run/agentdesk/${name}.pid; cd ${WORK}; exec bash -lc ${q(command)} >> ${q(log)} 2>&1`
    const start = await docker(['exec', '-d', this.name(agentId), 'setsid', 'bash', '-c', script], { timeoutMs: 15_000 })
    if (start.code !== 0) return { result: textResult(`Não consegui iniciar: ${start.stderr.trim()}`, true) }
    this.deps.db.saveService(agentId, { name, command, port, startedAt: Date.now() })

    // Wait for the port, up to 60 s, and check it is reachable from the Mac.
    let where: 'all' | 'loopback' | null = null
    let alive = true
    for (let i = 0; i < 60 && !signal?.aborted; i++) {
      const r = await docker(
        ['exec', this.name(agentId), 'bash', '-c', `cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; echo ---; kill -0 "$(cat /run/agentdesk/${name}.pid)" 2>/dev/null && echo alive`],
        { timeoutMs: 10_000 }
      )
      const [net = '', tail = ''] = r.stdout.split('---')
      where = listening(net, port)
      alive = tail.includes('alive')
      if (where || !alive) break
      await new Promise((res) => setTimeout(res, 1000))
    }
    const services = await this.refreshServices(agentId)
    const svc = services.find((s) => s.name === name)
    const logTail = (await this.exec(agentId, `tail -n 30 ${q(log)}`, { timeoutSeconds: 10 })).stdout.trim()
    const withLog = (msg: string): string => `${msg}${logTail ? `\n\nÚltimas linhas do log (${log}):\n${clipOutput(logTail, 4000)}` : ''}`

    if (!alive) return { result: textResult(withLog(`O processo terminou logo depois de iniciar.`), true) }
    if (where === 'loopback')
      return { result: textResult(withLog(`Está rodando, mas escuta só em localhost, então o Mac não alcança. Reinicie escutando em 0.0.0.0 (ex.: --host 0.0.0.0).`), true), service: name }
    if (!where) return { result: textResult(withLog(`Iniciou, mas a porta ${port} ainda não abriu depois de 60 s. Confira o log; ele continua rodando.`)), service: name }
    return {
      result: textResult(withLog(`"${name}" está no ar na porta ${port}. O usuário vê um botão pra abrir no chat. Pra conferir, use screenshot com http://localhost:${port}.`)),
      service: svc ? name : undefined
    }
  }

  // ---------- files ----------
  // Always through the container, never through the mounted folder on the Mac:
  // a symlink the agent creates in /work must resolve inside the computer.

  private async readFile(agentId: string, path: string): Promise<CallToolResult> {
    const abs = containerPath(path)
    const r = await this.exec(agentId, `if [ -d ${q(abs)} ]; then echo "é uma pasta" >&2; exit 2; fi; head -c ${MAX_FILE * 4} ${q(abs)}`, { timeoutSeconds: 30 })
    if (r.code !== 0) return textResult(r.stderr.trim() || `Não consegui ler ${abs}`, true)
    if (r.stdout.slice(0, 8000).includes('\u0000')) return textResult(`${abs} é binário. Use show_file pra mostrar ou bash pra inspecionar.`, true)
    const text = r.stdout
    return textResult(text.length > MAX_FILE ? `${text.slice(0, MAX_FILE)}\n[… arquivo cortado em ${MAX_FILE} caracteres]` : text || '(arquivo vazio)')
  }

  private async writeFile(agentId: string, path: string, content: string): Promise<CallToolResult> {
    const abs = containerPath(path)
    const r = await this.exec(agentId, `mkdir -p "$(dirname ${q(abs)})" && cat > ${q(abs)}`, { timeoutSeconds: 30, stdin: content })
    if (r.code !== 0) return textResult(r.stderr.trim() || `Não consegui escrever ${abs}`, true)
    return textResult(`Escrevi ${abs} (${Buffer.byteLength(content)} bytes).`)
  }

  private async editFile(agentId: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const path = String(args['path'] ?? '')
    const oldText = String(args['old_text'] ?? '')
    const newText = String(args['new_text'] ?? '')
    if (!oldText) return textResult('old_text não pode ser vazio. Pra criar ou reescrever o arquivo, use write_file.', true)
    const current = await this.readFile(agentId, path)
    if (current.isError) return current
    const text = (current.content[0] as { text: string }).text
    const count = text.split(oldText).length - 1
    if (count === 0) return textResult('O trecho não está no arquivo. Leia de novo e copie exatamente.', true)
    if (count > 1 && args['replace_all'] !== true) return textResult(`O trecho aparece ${count} vezes. Inclua mais contexto ou use replace_all.`, true)
    const next = args['replace_all'] === true ? text.split(oldText).join(newText) : text.replace(oldText, () => newText)
    const r = await this.writeFile(agentId, path, next)
    return r.isError ? r : textResult(`Editei ${containerPath(path)} (${count} troca${count > 1 ? 's' : ''}).`)
  }

  // Copies a file out of the computer into the app's artifact store, as it is now.
  private async keep(
    agentId: string,
    ctx: { conversationId: string; messageId: string },
    file: { name: string; title: string; source: string; data?: Buffer; containerPath?: string }
  ): Promise<Artifact | { error: string }> {
    const id = randomUUID()
    const name = file.name.replace(/[\\/]/g, '_') || 'arquivo'
    const dir = join(this.deps.dataDir, 'artifacts', id)
    mkdirSync(dir, { recursive: true })
    if (file.containerPath) {
      // `docker cp -L` resolves links inside the container and writes a plain file here.
      const r = await docker(['cp', '-L', `${this.name(agentId)}:${file.containerPath}`, join(dir, name)], { timeoutMs: 120_000 })
      if (r.code !== 0) {
        rmSync(dir, { recursive: true, force: true })
        return { error: r.stderr.trim() || `Não achei ${file.containerPath}.` }
      }
    } else writeFileSync(join(dir, name), file.data ?? Buffer.alloc(0))
    const size = statSync(join(dir, name)).size
    if (!statSync(join(dir, name)).isFile() || size > MAX_SHOW_BYTES) {
      rmSync(dir, { recursive: true, force: true })
      return { error: 'Só dá pra mostrar um arquivo de até 50 MB.' }
    }
    const artifact: Artifact = {
      id,
      agentId,
      conversationId: ctx.conversationId,
      messageId: ctx.messageId,
      kind: artifactKind(name),
      name,
      title: file.title,
      source: file.source,
      size,
      createdAt: Date.now()
    }
    this.deps.db.saveArtifact(artifact)
    this.deps.emit({ type: 'artifact', artifact })
    return artifact
  }

  private async showFile(agentId: string, args: Record<string, unknown>, ctx: { conversationId: string; messageId: string }): Promise<ToolOutcome> {
    const abs = containerPath(String(args['path'] ?? ''))
    const title = (typeof args['title'] === 'string' && args['title'].trim()) || basename(abs)
    const kept = await this.keep(agentId, ctx, { name: basename(abs), title, source: abs, containerPath: abs })
    if ('error' in kept) return { result: textResult(kept.error, true) }
    return { result: textResult(`Mostrei "${title}" no chat.`), artifact: kept }
  }

  private async screenshot(agentId: string, args: Record<string, unknown>, ctx: { conversationId: string; messageId: string }): Promise<ToolOutcome> {
    if (!this.deps.shoot) return { result: textResult('Prints não estão disponíveis neste modo do app.', true) }
    const url = String(args['url'] ?? '')
    const target = hostUrl(url, this.ports.get(agentId) ?? {})
    if (typeof target !== 'string') return { result: textResult(target.error, true) }
    let png: Buffer
    try {
      png = await this.deps.shoot({ url: target, width: Math.min(2560, Math.max(320, Number(args['width']) || 1280)), height: 800, fullPage: args['full_page'] === true })
    } catch (e) {
      return { result: textResult(`Não consegui abrir ${url}: ${e instanceof Error ? e.message : String(e)}`, true) }
    }
    const file = `print-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
    const saved = `${WORK}/.prints/${file}`
    await this.exec(agentId, `mkdir -p ${WORK}/.prints && cat > ${q(saved)}`, { timeoutSeconds: 30, stdin: png })
    const kept = await this.keep(agentId, ctx, { name: file, title: `Print de ${url}`, source: url, data: png })
    if ('error' in kept) return { result: textResult(kept.error, true) }
    return {
      result: {
        content: [
          { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: `Print de ${url}, mostrado no chat e salvo em ${saved}.` }
        ]
      },
      artifact: kept
    }
  }

  // ---------- the tools ----------

  async call(agent: Agent, name: string, args: Record<string, unknown>, ctx: { conversationId: string; messageId: string; signal?: AbortSignal }): Promise<ToolOutcome> {
    if (agent.computerKind === 'mac') return this.mac.call(agent, name, args, ctx)
    try {
      await this.ensure(agent.id)
    } catch (e) {
      return { result: textResult(e instanceof Error ? e.message : String(e), true) }
    }
    switch (name) {
      case 'bash': {
        const command = String(args['command'] ?? '').trim()
        if (!command) return { result: textResult('Faltou o comando.', true) }
        const t = Math.min(600, Math.max(1, Number(args['timeout_seconds']) || 120))
        const r = await this.exec(agent.id, command, { timeoutSeconds: t, signal: ctx.signal })
        return { result: textResult(formatExec(r, t), r.code !== 0) }
      }
      case 'read_file':
        return { result: await this.readFile(agent.id, String(args['path'] ?? '')) }
      case 'write_file':
        return { result: await this.writeFile(agent.id, String(args['path'] ?? ''), String(args['content'] ?? '')) }
      case 'edit_file':
        return { result: await this.editFile(agent.id, args) }
      case 'start_service':
        return this.startService(agent.id, args, ctx.signal)
      case 'stop_service': {
        const svc = String(args['name'] ?? '')
        if (!this.deps.db.services(agent.id).some((s) => s.name === svc)) return { result: textResult(`Não há serviço "${svc}".`, true) }
        await this.stopService(agent.id, svc)
        return { result: textResult(`Parei "${svc}".`) }
      }
      case 'screenshot':
        return this.screenshot(agent.id, args, ctx)
      case 'show_file':
        return this.showFile(agent.id, args, ctx)
      default:
        return { result: textResult(`Ferramenta desconhecida: ${name}`, true) }
    }
  }
}

// A one-line description of a computer tool call, for its step in the chat.
export function stepFor(name: string, args: Record<string, unknown>, onMac = false): { label: string; detail: string } {
  const s = (k: string): string => String(args[k] ?? '')
  const containerPath = (p: string): string => (onMac ? p : linuxPath(p))
  const short = (t: string): string => (t.length > 140 ? `${t.slice(0, 140)}…` : t)
  switch (name) {
    case 'bash':
      return { label: 'Rodou', detail: short(s('command').split('\n')[0] ?? '') }
    case 'read_file':
      return { label: 'Leu', detail: containerPath(s('path')) }
    case 'write_file':
      return { label: 'Escreveu', detail: containerPath(s('path')) }
    case 'edit_file':
      return { label: 'Editou', detail: containerPath(s('path')) }
    case 'start_service':
      return { label: 'Subiu', detail: `${s('name')} · porta ${s('port')}` }
    case 'stop_service':
      return { label: 'Parou', detail: s('name') }
    case 'screenshot':
      return { label: 'Tirou print', detail: s('url') }
    case 'show_file':
      return { label: 'Mostrou', detail: containerPath(s('path')) }
    default:
      return { label: name, detail: '' }
  }
}
