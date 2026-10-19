// Issue to PR (spec §22). Agents' computers have no credentials; their git
// talks to GitHub through this proxy, which adds the token on the way out and
// lets through only what the project allows: fetching the project's repository,
// and pushing only to branches agent/*, for agents that may change the folder.
// Opening the PR is a tool that becomes an approval; the app opens it with the API.
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { Agent, Conversation } from '../shared/types'
import type { Db } from './db'
import type { Secrets } from './secrets'

export const GIT_PROXY_PORT = 47_718
export const GITHUB = 'github' // the approvals' connector id for abrir_pr
export const ABRIR_PR = 'abrir_pr'
const TOKEN = 'github:token'
const KEY = 'github:proxy-key'
const MAX_PUSH = 300 * 1024 * 1024
const AGENT_BRANCH = /^refs\/heads\/agent\/[A-Za-z0-9._\/-]+$/
const ZERO = /^0{40}$/

type Fetch = typeof fetch

// "owner/name" of a folder's origin on GitHub, read from its git config as text
// (git itself is never run on a folder an agent can write to). Worktrees included.
export function githubRepo(folder: string): string | undefined {
  try {
    let gitDir = join(folder, '.git')
    if (statSync(gitDir).isFile()) {
      gitDir = resolve(folder, /gitdir:\s*(.+)/.exec(readFileSync(gitDir, 'utf8'))![1]!.trim())
      const common = join(gitDir, 'commondir')
      if (existsSync(common)) gitDir = resolve(gitDir, readFileSync(common, 'utf8').trim())
    }
    const config = readFileSync(join(gitDir, 'config'), 'utf8')
    const origin = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] ?? ''
    const url = /^\s*url\s*=\s*(.+)$/m.exec(origin)?.[1]?.trim() ?? ''
    return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1]
  } catch {
    return undefined
  }
}

// The ref updates at the start of a receive-pack request: pkt-lines up to the first flush.
export function pushedRefs(body: Buffer): { old: string; next: string; ref: string; caps?: string }[] | undefined {
  const refs: { old: string; next: string; ref: string; caps?: string }[] = []
  let i = 0
  while (i + 4 <= body.length) {
    const len = parseInt(body.subarray(i, i + 4).toString('ascii'), 16)
    if (Number.isNaN(len)) return undefined
    if (len === 0) return refs
    if (len < 4 || i + len > body.length) return undefined
    const [line, caps] = body.subarray(i + 4, i + len).toString('utf8').split('\0')
    const [old, next, ref] = line!.trim().split(' ')
    if (!old || !next || !ref) return undefined
    refs.push({ old, next, ref, ...(caps ? { caps: caps.trim() } : {}) })
    i += len
  }
  return undefined
}

export interface GitHubDeps {
  secrets: Pick<Secrets, 'get' | 'set'>
  db: Db
  post: (conversationId: string, text: string) => void // a line in the project's channel when something is published
  changed: () => void
  fetch?: Fetch
  upstream?: string // where git goes; https://github.com except in tests
}

export class GitHub {
  private user?: string
  private error?: string
  private server?: Server
  private key?: string

  constructor(private deps: GitHubDeps) {}

  private get f(): Fetch {
    return this.deps.fetch ?? fetch
  }

  info(): { user?: string; error?: string } {
    return { user: this.user, error: this.error }
  }

  async start(): Promise<void> {
    this.key = (await this.deps.secrets.get(KEY)) ?? undefined
    if (!this.key) {
      this.key = randomBytes(24).toString('hex')
      await this.deps.secrets.set(KEY, this.key)
    }
    const token = await this.deps.secrets.get(TOKEN)
    if (token) {
      try {
        this.user = await this.whoami(token)
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e)
      }
      this.deps.changed()
    }
  }

  listen(port = GIT_PROXY_PORT): Server {
    this.server = createServer((req, res) => void this.proxy(req, res).catch((e: unknown) => send(res, 502, `agent-desk: ${e instanceof Error ? e.message : String(e)}\n`)))
    this.server.on('error', (e) => console.error(`[github] porta ${port}:`, e.message))
    this.server.listen(port, '127.0.0.1')
    return this.server
  }

  stop(): void {
    this.server?.close()
  }

  async setToken(token: string | null): Promise<void> {
    const t = token?.trim()
    if (t) this.user = await this.whoami(t)
    else this.user = undefined
    this.error = undefined
    await this.deps.secrets.set(TOKEN, t || undefined)
    this.deps.changed()
  }

  private async whoami(token: string): Promise<string> {
    let res: Response
    try {
      res = await this.f('https://api.github.com/user', { headers: headers(token), signal: AbortSignal.timeout(10_000) })
    } catch {
      throw new Error('Não consegui falar com o GitHub. Confira a internet.')
    }
    if (res.status === 401) throw new Error('O GitHub recusou esse token.')
    if (!res.ok) throw new Error(`O GitHub respondeu ${res.status}.`)
    return ((await res.json()) as { login: string }).login
  }

  // ---------- what an agent may do ----------

  // The path prefix that identifies an agent to the proxy, from a key only the app knows.
  agentToken(agentId: string): string | undefined {
    return this.key && createHmac('sha256', this.key).update(agentId).digest('hex').slice(0, 32)
  }

  // The git config that sends an agent's GitHub traffic through the proxy.
  gitRemote(agentId: string): string | undefined {
    const t = this.agentToken(agentId)
    return t && `http://host.docker.internal:${GIT_PROXY_PORT}/git/${t}/`
  }

  // The project channels whose repository is `repo`, with this agent's access to the folder.
  private access(agent: Agent, repo: string): { conv: Conversation; write: boolean } | undefined {
    for (const f of agent.folders ?? []) {
      const conv = f.channelId ? this.deps.db.conversation(f.channelId) : undefined
      if (!conv?.project || githubRepo(conv.project.folder)?.toLowerCase() !== repo.toLowerCase()) continue
      return { conv, write: !f.readOnly }
    }
    return undefined
  }

  // For the prompt and the tools: the repository of this project channel, if the agent can push there.
  pushable(agent: Agent, conv: Conversation): string | undefined {
    if (!this.user || !conv.project) return undefined
    const repo = githubRepo(conv.project.folder)
    return repo && this.access(agent, repo)?.write ? repo : undefined
  }

  // ---------- the proxy ----------

  private async proxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = /^\/git\/([0-9a-f]{32})\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)(\?.*)?$/.exec(req.url ?? '')
    if (!m) return send(res, 404, 'agent-desk: endereço desconhecido\n')
    const [, token, owner, name, path, query = ''] = m
    const agent = this.deps.db.agents().find((a) => this.agentToken(a.id) === token)
    if (!agent) return send(res, 403, 'agent-desk: agente desconhecido\n')
    const repo = `${owner}/${name}`
    const access = this.access(agent, repo)
    if (!access) return send(res, 403, `agent-desk: ${repo} não é o repositório de um projeto seu\n`)
    const pushing = path === 'git-receive-pack' || query.includes('service=git-receive-pack')
    if (pushing && !access.write) return send(res, 403, 'agent-desk: você só lê este projeto\n')
    const gh = await this.deps.secrets.get(TOKEN)
    if (!gh) return send(res, 403, 'agent-desk: o GitHub não está conectado no app (Configurações → GitHub)\n')

    const body = req.method === 'POST' ? await read(req, MAX_PUSH) : undefined
    let refs: { old: string; next: string; ref: string }[] | undefined
    if (path === 'git-receive-pack' && body) {
      const raw = req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body
      refs = pushedRefs(raw)
      if (!refs) return send(res, 400, 'agent-desk: pedido de push que não entendi\n')
      const bad = refs.find((r) => !AGENT_BRANCH.test(r.ref))
      if (bad) return refuse(res, refs, (r) => (AGENT_BRANCH.test(r.ref) ? 'o push tinha outra branch fora de agent/*' : 'agent-desk aceita so branches agent/<assunto>'))
    }

    const upstream = await this.f(`${this.deps.upstream ?? 'https://github.com'}/${repo}.git/${path}${query}`, {
      method: req.method,
      headers: {
        Authorization: `Basic ${Buffer.from(`x-access-token:${gh}`).toString('base64')}`,
        'User-Agent': String(req.headers['user-agent'] ?? 'git/agent-desk'),
        ...pick(req.headers, ['content-type', 'accept', 'git-protocol', 'content-encoding'])
      },
      body: body ? new Uint8Array(body) : undefined
    })
    const out = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(upstream.status, pick(Object.fromEntries(upstream.headers), ['content-type', 'cache-control', 'expires', 'pragma']))
    res.end(out)

    if (refs && upstream.ok) {
      const branches = refs.map((r) => `${ZERO.test(r.next) ? 'apagou' : 'publicou'} \`${r.ref.replace('refs/heads/', '')}\``).join(', ')
      this.deps.post(access.conv.id, `**${agent.name}** ${branches} no GitHub (${repo}).`)
    }
  }

  // ---------- the PR, once approved ----------

  async openPr(args: Record<string, unknown>): Promise<{ url: string; number: number }> {
    const gh = await this.deps.secrets.get(TOKEN)
    if (!gh) throw new Error('o GitHub não está conectado no app')
    const repo = String(args['repo'])
    const res = await this.f(`https://api.github.com/repos/${repo}/pulls`, {
      method: 'POST',
      headers: { ...headers(gh), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: args['title'], head: args['head'], base: args['base'], body: args['body'], draft: false }),
      signal: AbortSignal.timeout(20_000)
    })
    const body = (await res.json().catch(() => ({}))) as { html_url?: string; number?: number; message?: string; errors?: { message?: string }[] }
    if (!res.ok) throw new Error(`o GitHub recusou: ${body.errors?.[0]?.message ?? body.message ?? res.status}`)
    return { url: body.html_url!, number: body.number! }
  }
}

const headers = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agent-desk', 'X-GitHub-Api-Version': '2022-11-28' })

function pick(h: Record<string, string | string[] | undefined>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of keys) if (typeof h[k] === 'string') out[k] = h[k]
  return out
}

const pkt = (s: string | Buffer): Buffer => {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(s)
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b])
}

// A refused push answered like a git server would, so git shows
// "! [remote rejected] main -> main (agent-desk aceita so branches agent/<assunto>)".
function refuse(res: ServerResponse, refs: { ref: string; caps?: string }[], why: (r: { ref: string }) => string): void {
  const report = Buffer.concat([pkt('unpack ok\n'), ...refs.map((r) => pkt(`ng ${r.ref} ${why(r)}\n`)), Buffer.from('0000')])
  const banded = refs[0]?.caps?.includes('side-band') ? Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), report])), Buffer.from('0000')]) : report
  res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-cache' }).end(banded)
}

function send(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) return void res.end()
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text)
}

function read(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        fail(new Error('push grande demais'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => ok(Buffer.concat(chunks)))
    req.on('error', fail)
  })
}

