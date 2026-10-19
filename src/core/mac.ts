// An agent whose computer is this Mac (spec §23): the same tools as the Linux
// computer, run directly on the Mac as the user, with what is installed here.
// Chosen per agent, by the user, knowing it reaches everything the user reaches.
// What stays: every call is a step in the chat, the run guards still apply, and
// commands get the user's own shell environment, never the app's.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, closeSync, unlinkSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { CoreEvent } from '../shared/rpc'
import type { Agent, Artifact, ComputerInfo, Service } from '../shared/types'
import type { Db } from './db'
import { textResult, type ToolDef } from './gateway'
import { artifactKind, clipOutput, COMPUTER_TOOLS, formatExec, seenImage, type Shooter, type ToolOutcome } from './computer'

const MAX_FILE = 200_000
const MAX_SHOW_BYTES = 50 * 1024 * 1024
const RESERVED_PORTS = [47_717, 47_718] // the app's own webhook and git proxy

const MAC_DESCRIPTIONS: Record<string, string> = {
  bash: 'Roda um comando no Mac do usuário (macOS, como o próprio usuário, com o que ele tem instalado: Homebrew, Python, Node…), por padrão na pasta do projeto do canal. Pra servidores que ficam rodando, use start_service.',
  read_file: 'Lê um arquivo de texto do Mac.',
  write_file: 'Cria ou sobrescreve um arquivo no Mac, criando as pastas que faltarem.',
  start_service:
    'Deixa um processo rodando em segundo plano no Mac (servidor web, API, dashboard) e confere se ele abriu a porta (qualquer porta acima de 1024 que esteja livre). O log fica na pasta de trabalho, em .logs/<nome>.log. Iniciar de novo com o mesmo nome reinicia.',
  screenshot: 'Tira um print de uma página web e mostra no chat; você também recebe a imagem. Serve http://localhost:<porta> (o Mac) ou qualquer URL da internet.',
  show_file: 'Mostra um arquivo do Mac no chat: imagem, vídeo, Markdown, HTML, PDF, CSV ou texto (até 50 MB). O arquivo é guardado como está agora. Se for imagem, você também a recebe pra conferir.'
}

// The same tools, described for the Mac (a function: computer.ts and this file import each other).
let macToolsOnce: ToolDef[] | undefined
export const macTools = (): ToolDef[] => (macToolsOnce ??= COMPUTER_TOOLS.map((t) => {
  const description = MAC_DESCRIPTIONS[t.name] ?? t.description
  const props = (t.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {}
  const properties = Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k, k === 'path' ? { ...v, description: 'Caminho absoluto, com ~, ou relativo à pasta de trabalho.' } : k === 'command' && t.name === 'start_service' ? { ...v, description: 'Comando, rodado na pasta de trabalho.' } : v])
  )
  return { ...t, description, inputSchema: { ...t.inputSchema, properties } as ToolDef['inputSchema'] }
}))

// A path as the agent writes it, on the Mac.
export function macPath(p: string, cwd: string): string {
  const s = p.trim()
  if (s === '~' || s.startsWith('~/')) return normalize(join(homedir(), s.slice(1)))
  return normalize(isAbsolute(s) ? s : join(cwd, s))
}

type Exec = { code: number; stdout: string; stderr: string }

// The user's own environment, as a new terminal would have it (PATH from the
// shell's profile: Homebrew, asdf, pyenv…), built from a clean start so that
// nothing of the app's process goes along.
let envOnce: Promise<NodeJS.ProcessEnv> | undefined
export function loginEnv(): Promise<NodeJS.ProcessEnv> {
  envOnce ??= new Promise((resolve) => {
    const base: NodeJS.ProcessEnv = {
      HOME: homedir(),
      USER: process.env['USER'],
      LOGNAME: process.env['LOGNAME'] ?? process.env['USER'],
      SHELL: process.env['SHELL'] ?? '/bin/zsh',
      LANG: process.env['LANG'] ?? 'pt_BR.UTF-8',
      TMPDIR: process.env['TMPDIR'],
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
    }
    const marker = '__AGENTDESK_ENV__'
    const child = spawn(base.SHELL!, ['-ilc', `printf '${marker}\\0'; env -0`], { env: base, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    const done = (): void => {
      const at = out.indexOf(`${marker}\0`)
      if (at < 0) return resolve({ ...base, PATH: `/opt/homebrew/bin:/usr/local/bin:${base.PATH}` })
      const env: NodeJS.ProcessEnv = {}
      for (const pair of out.slice(at + marker.length + 1).split('\0')) {
        const i = pair.indexOf('=')
        if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1)
      }
      resolve(env)
    }
    const timer = setTimeout(() => (child.kill('SIGKILL'), done()), 15_000)
    child.on('close', () => (clearTimeout(timer), done()))
    child.on('error', () => (clearTimeout(timer), done()))
  })
  return envOnce
}

function run(command: string, opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutSeconds: number; signal?: AbortSignal }): Promise<Exec> {
  return new Promise((resolve) => {
    // Its own process group, so a timeout or a stop takes the children with it.
    const child = spawn('/bin/bash', ['-c', command], { cwd: opts.cwd, env: { ...opts.env, TERM: 'dumb' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout = (stdout + d).slice(-2_000_000)))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-200_000)))
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig)
      } catch {
        /* already gone */
      }
    }
    const stop = (): void => {
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), 5000).unref()
    }
    const timer = setTimeout(() => ((timedOut = true), stop()), opts.timeoutSeconds * 1000)
    opts.signal?.addEventListener('abort', stop, { once: true })
    child.on('error', (e) => (stderr += e.message))
    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', stop)
      resolve({ code: timedOut ? 124 : (code ?? -1), stdout, stderr })
    })
  })
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port })
    const end = (ok: boolean): void => (s.destroy(), resolve(ok))
    s.setTimeout(800, () => end(false))
    s.once('connect', () => end(true))
    s.once('error', () => end(false))
  })
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export interface MacDeps {
  db: Db
  dataDir: string
  emit: (e: CoreEvent) => void
  shoot?: Shooter
  env?: () => Promise<NodeJS.ProcessEnv> // tests pass their own
}

export class MacComputer {
  constructor(private deps: MacDeps) {}

  // The default working folder, when the conversation has no project folder.
  folder(agentId: string): string {
    return join(this.deps.dataDir, 'computers', agentId, 'work')
  }

  // Where commands start: the conversation's project folder, else the agent's own folder.
  cwd(agent: Agent, conversationId?: string): string {
    const project = conversationId ? agent.folders?.find((f) => f.channelId === conversationId) : undefined
    if (project && existsSync(project.path)) return project.path
    const own = this.folder(agent.id)
    mkdirSync(own, { recursive: true })
    return own
  }

  private pidFile(agentId: string, name: string): string {
    return join(this.folder(agentId), '.run', `${name}.pid`)
  }

  private pid(agentId: string, name: string): number | undefined {
    try {
      const n = Number(readFileSync(this.pidFile(agentId, name), 'utf8').trim())
      return n > 0 ? n : undefined
    } catch {
      return undefined
    }
  }

  services(agentId: string): Service[] {
    return this.deps.db.services(agentId).map((s) => {
      const pid = this.pid(agentId, s.name)
      const running = !!pid && alive(pid)
      return { ...s, running, url: running ? `http://127.0.0.1:${s.port}` : undefined }
    })
  }

  info(agent: Agent): ComputerInfo {
    return { agentId: agent.id, state: agent.computer ? 'running' : 'off', kind: 'mac', folder: this.folder(agent.id), services: agent.computer ? this.services(agent.id) : [] }
  }

  refresh(agent: Agent): void {
    this.deps.emit({ type: 'computer', computer: this.info(agent) })
  }

  async stopService(agentId: string, name: string): Promise<boolean> {
    const pid = this.pid(agentId, name)
    let stopped = true
    if (pid && alive(pid)) {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        stopped = false
      }
      for (let i = 0; i < 6 && alive(pid); i++) await new Promise((r) => setTimeout(r, 500))
      if (alive(pid))
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* gone */
        }
    }
    rmSync(this.pidFile(agentId, name), { force: true })
    this.deps.db.removeServices(agentId, name)
    const agent = this.deps.db.agent(agentId)
    if (agent) this.refresh(agent)
    return stopped
  }

  async stopAll(agentId: string): Promise<void> {
    for (const s of this.deps.db.services(agentId)) await this.stopService(agentId, s.name)
  }

  // Only the agent's own folder: its services, prints and logs. Never anything else of the Mac.
  async erase(agentId: string): Promise<void> {
    await this.stopAll(agentId)
    rmSync(join(this.deps.dataDir, 'computers', agentId), { recursive: true, force: true })
  }

  private env(): Promise<NodeJS.ProcessEnv> {
    return (this.deps.env ?? loginEnv)()
  }

  private async startService(agent: Agent, args: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<ToolOutcome> {
    const name = typeof args['name'] === 'string' ? args['name'].trim() : ''
    const command = typeof args['command'] === 'string' ? args['command'].trim() : ''
    const port = Number(args['port'])
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name)) return { result: textResult('Nome inválido: use letras, números, - ou _.', true) }
    if (!command) return { result: textResult('Faltou o comando.', true) }
    if (!Number.isInteger(port) || port < 1024 || port > 65_535 || RESERVED_PORTS.includes(port)) return { result: textResult(`Porta ${port} não serve: use uma acima de 1024 (e fora de ${RESERVED_PORTS.join(', ')}).`, true) }
    const taken = this.deps.db.services(agent.id).find((s) => s.port === port && s.name !== name)
    if (taken) return { result: textResult(`A porta ${port} já é do serviço "${taken.name}". Pare ele ou use outra porta.`, true) }
    if (this.deps.db.services(agent.id).some((s) => s.name === name)) await this.stopService(agent.id, name)
    if (await portOpen(port)) return { result: textResult(`A porta ${port} já está em uso no Mac por outro programa. Use outra.`, true) }

    const logs = join(this.folder(agent.id), '.logs')
    mkdirSync(logs, { recursive: true })
    mkdirSync(dirname(this.pidFile(agent.id, name)), { recursive: true })
    const log = join(logs, `${name}.log`)
    const fd = openSync(log, 'w')
    const child = spawn('/bin/bash', ['-c', command], { cwd, env: { ...(await this.env()), TERM: 'dumb' }, detached: true, stdio: ['ignore', fd, fd] })
    closeSync(fd)
    child.unref()
    if (!child.pid) return { result: textResult('Não consegui iniciar o processo.', true) }
    writeFileSync(this.pidFile(agent.id, name), String(child.pid))
    this.deps.db.saveService(agent.id, { name, command, port, startedAt: Date.now() })

    let open = false
    for (let i = 0; i < 60 && !signal?.aborted && alive(child.pid); i++) {
      if ((open = await portOpen(port))) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    this.refresh(agent)
    let tail = ''
    try {
      tail = readFileSync(log, 'utf8').split('\n').slice(-30).join('\n').trim()
    } catch {
      /* no log */
    }
    const withLog = (msg: string): string => `${msg}${tail ? `\n\nÚltimas linhas do log (${log}):\n${clipOutput(tail, 4000)}` : ''}`
    if (!alive(child.pid)) {
      unlinkSync(this.pidFile(agent.id, name))
      this.deps.db.removeServices(agent.id, name)
      return { result: textResult(withLog('O processo terminou logo depois de iniciar.'), true) }
    }
    if (!open) return { result: textResult(withLog(`Iniciou, mas a porta ${port} ainda não abriu depois de 60 s. Confira o log; ele continua rodando.`)), service: name }
    return { result: textResult(withLog(`"${name}" está no ar em http://localhost:${port}. O usuário vê um botão pra abrir no chat.`)), service: name }
  }

  private read(path: string): CallToolResult {
    try {
      if (statSync(path).isDirectory()) return textResult(`${path} é uma pasta.`, true)
      const buf = readFileSync(path)
      if (buf.subarray(0, 8000).includes(0)) return textResult(`${path} é binário. Use show_file pra mostrar ou bash pra inspecionar.`, true)
      const text = buf.toString('utf8')
      return textResult(text.length > MAX_FILE ? `${text.slice(0, MAX_FILE)}\n[… arquivo cortado em ${MAX_FILE} caracteres]` : text || '(arquivo vazio)')
    } catch (e) {
      return textResult(`Não consegui ler ${path}: ${e instanceof Error ? e.message : String(e)}`, true)
    }
  }

  private write(path: string, content: string): CallToolResult {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      return textResult(`Escrevi ${path} (${Buffer.byteLength(content)} bytes).`)
    } catch (e) {
      return textResult(`Não consegui escrever ${path}: ${e instanceof Error ? e.message : String(e)}`, true)
    }
  }

  private keep(agentId: string, ctx: { conversationId: string; messageId: string }, file: { name: string; title: string; source: string; data?: Buffer; path?: string }): Artifact | { error: string } {
    const name = file.name.replace(/[\\/]/g, '_') || 'arquivo'
    if (file.path) {
      try {
        const st = statSync(file.path)
        if (!st.isFile()) return { error: `${file.path} não é um arquivo.` }
        if (st.size > MAX_SHOW_BYTES) return { error: 'Só dá pra mostrar um arquivo de até 50 MB.' }
      } catch {
        return { error: `Não achei ${file.path}.` }
      }
    }
    const id = randomUUID()
    const dir = join(this.deps.dataDir, 'artifacts', id)
    mkdirSync(dir, { recursive: true })
    if (file.path) copyFileSync(file.path, join(dir, name))
    else writeFileSync(join(dir, name), file.data ?? Buffer.alloc(0))
    const artifact: Artifact = { id, agentId, conversationId: ctx.conversationId, messageId: ctx.messageId, kind: artifactKind(name), name, title: file.title, source: file.source, size: statSync(join(dir, name)).size, createdAt: Date.now() }
    this.deps.db.saveArtifact(artifact)
    this.deps.emit({ type: 'artifact', artifact })
    return artifact
  }

  private async screenshot(agent: Agent, args: Record<string, unknown>, ctx: { conversationId: string; messageId: string }): Promise<ToolOutcome> {
    if (!this.deps.shoot) return { result: textResult('Prints não estão disponíveis neste modo do app.', true) }
    const url = String(args['url'] ?? '')
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return { result: textResult(`URL inválida: ${url}`, true) }
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { result: textResult('Só URLs http e https.', true) }
    let png: Buffer
    try {
      png = await this.deps.shoot({ url: u.toString(), width: Math.min(2560, Math.max(320, Number(args['width']) || 1280)), height: 800, fullPage: args['full_page'] === true })
    } catch (e) {
      return { result: textResult(`Não consegui abrir ${url}: ${e instanceof Error ? e.message : String(e)}`, true) }
    }
    const file = `print-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
    const saved = join(this.folder(agent.id), '.prints', file)
    mkdirSync(dirname(saved), { recursive: true })
    writeFileSync(saved, png)
    const kept = this.keep(agent.id, ctx, { name: file, title: `Print de ${url}`, source: url, data: png })
    if ('error' in kept) return { result: textResult(kept.error, true) }
    return { result: { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: `Print de ${url}, mostrado no chat e salvo em ${saved}.` }] }, artifact: kept }
  }

  async call(agent: Agent, name: string, args: Record<string, unknown>, ctx: { conversationId: string; messageId: string; signal?: AbortSignal }): Promise<ToolOutcome> {
    const cwd = this.cwd(agent, ctx.conversationId)
    const path = (): string => macPath(String(args['path'] ?? ''), cwd)
    switch (name) {
      case 'bash': {
        const command = String(args['command'] ?? '').trim()
        if (!command) return { result: textResult('Faltou o comando.', true) }
        const t = Math.min(600, Math.max(1, Number(args['timeout_seconds']) || 120))
        const r = await run(command, { cwd, env: await this.env(), timeoutSeconds: t, signal: ctx.signal })
        return { result: textResult(formatExec(r, t), r.code !== 0) }
      }
      case 'read_file':
        return { result: this.read(path()) }
      case 'write_file':
        return { result: this.write(path(), String(args['content'] ?? '')) }
      case 'edit_file': {
        const file = path()
        const oldText = String(args['old_text'] ?? '')
        const newText = String(args['new_text'] ?? '')
        if (!oldText) return { result: textResult('old_text não pode ser vazio. Pra criar ou reescrever o arquivo, use write_file.', true) }
        const current = this.read(file)
        if (current.isError) return { result: current }
        const text = (current.content[0] as { text: string }).text
        const count = text.split(oldText).length - 1
        if (count === 0) return { result: textResult('O trecho não está no arquivo. Leia de novo e copie exatamente.', true) }
        if (count > 1 && args['replace_all'] !== true) return { result: textResult(`O trecho aparece ${count} vezes. Inclua mais contexto ou use replace_all.`, true) }
        const next = args['replace_all'] === true ? text.split(oldText).join(newText) : text.replace(oldText, () => newText)
        const r = this.write(file, next)
        return { result: r.isError ? r : textResult(`Editei ${file} (${count} troca${count > 1 ? 's' : ''}).`) }
      }
      case 'start_service':
        return this.startService(agent, args, cwd, ctx.signal)
      case 'stop_service': {
        const svc = String(args['name'] ?? '')
        if (!this.deps.db.services(agent.id).some((s) => s.name === svc)) return { result: textResult(`Não há serviço "${svc}".`, true) }
        await this.stopService(agent.id, svc)
        return { result: textResult(`Parei "${svc}".`) }
      }
      case 'screenshot':
        return this.screenshot(agent, args, ctx)
      case 'show_file': {
        const file = path()
        const title = (typeof args['title'] === 'string' && args['title'].trim()) || basename(file)
        const kept = this.keep(agent.id, ctx, { name: basename(file), title, source: file, path: file })
        if ('error' in kept) return { result: textResult(kept.error, true) }
        const image = seenImage(file)
        const said = { type: 'text' as const, text: image ? `Mostrei "${title}" no chat. A imagem está aqui pra você conferir.` : `Mostrei "${title}" no chat.` }
        return { result: { content: image ? [image, said] : [said] }, artifact: kept }
      }
      default:
        return { result: textResult(`Ferramenta desconhecida: ${name}`, true) }
    }
  }
}
