import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngineId, EngineStatus } from '../../shared/types'
import { userProvider } from './claude'
import { codexEnv } from './codex'

function run(bin: string, args: string[], timeout = 15_000, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, env }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

// Apps opened from Finder get a minimal PATH. Borrow the one from the user's
// login shell so `claude` and `codex` are found where the terminal finds them.
export async function adoptLoginShellPath(): Promise<void> {
  const shell = process.env['SHELL'] || '/bin/zsh'
  const { code, stdout } = await run(shell, ['-ilc', 'printf "__PATH__%s" "$PATH"'], 10_000)
  const path = stdout.split('__PATH__').pop()?.trim()
  if (code === 0 && path) process.env['PATH'] = path
}

async function which(cmd: string): Promise<string | undefined> {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (!dir) continue
    const p = join(dir, cmd)
    try {
      await access(p, constants.X_OK)
      return p
    } catch {
      // not here
    }
  }
  return undefined
}

const version = (out: string): string | undefined => out.match(/\d+\.\d+\.\d+/)?.[0]

export async function detectClaude(): Promise<EngineStatus> {
  const path = await which('claude')
  if (!path) return { installed: false, loggedIn: false }
  const [v, auth] = await Promise.all([run(path, ['--version']), run(path, ['auth', 'status'])])
  let status: Record<string, unknown> = {}
  try {
    status = JSON.parse(auth.stdout) as Record<string, unknown>
  } catch {
    // older CLI or not logged in
  }
  const loggedIn = status['loggedIn'] === true
  const subscription = typeof status['subscriptionType'] === 'string' ? status['subscriptionType'] : undefined
  const viaSubscription = status['authMethod'] === 'claude.ai'
  const gateway = gatewayHost(userProvider().env['ANTHROPIC_BASE_URL'])
  if (gateway) return { installed: true, path, version: version(v.stdout), loggedIn: true, account: `Gateway ${gateway} · pelo seu settings.json` }
  return {
    installed: true,
    path,
    version: version(v.stdout),
    loggedIn,
    account: loggedIn ? (viaSubscription ? `Assinatura Claude${subscription ? ` ${subscription[0]!.toUpperCase()}${subscription.slice(1)}` : ''}` : 'Chave de API') : undefined,
    warning: loggedIn && !viaSubscription ? 'Logado com chave de API: o uso será cobrado por token.' : undefined
  }
}

const gatewayHost = (url: string | undefined): string | undefined => {
  try {
    return url ? new URL(url).host : undefined
  } catch {
    return url
  }
}

// Checks the app's own Codex login (see codexEnv), not the user's.
export async function detectCodex(home: string): Promise<EngineStatus> {
  const path = await which('codex')
  if (!path) return { installed: false, loggedIn: false }
  const [v, auth] = await Promise.all([run(path, ['--version']), run(path, ['login', 'status'], 15_000, codexEnv(home))])
  const text = `${auth.stdout}\n${auth.stderr}`
  const loggedIn = auth.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text)
  const viaChatGpt = /chatgpt/i.test(text)
  return {
    installed: true,
    path,
    version: version(v.stdout),
    loggedIn,
    account: loggedIn ? (viaChatGpt ? 'Assinatura ChatGPT · login próprio do agent-desk' : 'Chave de API') : 'Precisa de um login próprio do agent-desk',
    warning: loggedIn && !viaChatGpt ? 'Logado com chave de API: o uso será cobrado por token.' : undefined
  }
}

export async function detectEngines(codexHome: string): Promise<Record<EngineId, EngineStatus>> {
  const [claude, codex] = await Promise.all([detectClaude(), detectCodex(codexHome)])
  return { claude, codex }
}
