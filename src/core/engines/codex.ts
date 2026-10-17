import { join } from 'node:path'
import { GATEWAY_NAME } from './claude'
import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import type { Engine, EngineEvent, Turn } from './types'

// Codex reads AGENTS.md, skills, plugins and memories from the user's home no
// matter which flags are passed, so agent-desk runs it with a home of its
// own. The user logs into Codex once more, for the app, through Codex itself.
export function codexEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex') }
}

// Built-in capabilities agents must not have: their tools come only from the gateway.
export const CODEX_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'code_mode_host',
  'apps',
  'plugins',
  'browser_use',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'multi_agent',
  'goals',
  'view_image',
  'tool_suggest',
  'skill_search',
  'hooks',
  'memories'
]

// Flags that keep the CLI isolated: ignore config and rules, no skills, no web
// search, no project docs, built-in tools off, no saved session, and a
// read-only sandbox in an empty directory as a last line of defense. The prompt comes from stdin ("-"). The app's gateway,
// when given, is the only MCP server, with its tools approved up front: the
// gateway decides what runs.
export function codexArgs(turn: Pick<Turn, 'model' | 'effort' | 'system' | 'cwd' | 'mcpUrl'>): string[] {
  const gateway = turn.mcpUrl
    ? [
        '-c', `mcp_servers.${GATEWAY_NAME}.url=${JSON.stringify(turn.mcpUrl)}`,
        '-c', `mcp_servers.${GATEWAY_NAME}.default_tools_approval_mode="approve"`
      ]
    : []
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '-s', 'read-only',
    '-C', turn.cwd,
    '-m', turn.model,
    '-c', `model_reasoning_effort=${JSON.stringify(turn.effort)}`,
    '-c', `developer_instructions=${JSON.stringify(turn.system)}`,
    '-c', 'skills.include_instructions=false',
    '-c', 'skills.bundled.enabled=false',
    '-c', 'web_search="disabled"',
    '-c', 'project_doc_max_bytes=0',
    ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
    ...gateway,
    '-'
  ]
}

export function codexParser(): Parser {
  let text = ''
  let finished = false

  return {
    line(line) {
      const ev = parseJson(line)
      if (!ev) return []
      const out: EngineEvent[] = []
      const type = ev['type']

      if (type === 'item.completed') {
        const item = ev['item'] as Record<string, unknown> | undefined
        if (item?.['type'] === 'agent_message' && typeof item['text'] === 'string') {
          const delta = text ? `\n\n${item['text']}` : item['text']
          text += delta
          out.push({ type: 'text', delta })
        }
      } else if (type === 'turn.completed') {
        finished = true
        const u = (ev['usage'] ?? {}) as Record<string, unknown>
        const usage = {
          inputTokens: num(u['input_tokens']),
          cacheReadTokens: num(u['cached_input_tokens']),
          outputTokens: num(u['output_tokens'])
        }
        out.push({ type: 'progress', tokens: usage.inputTokens + usage.outputTokens })
        out.push({ type: 'done', text, usage })
      } else if (type === 'turn.failed' || type === 'error') {
        finished = true
        const err = ev['error'] as Record<string, unknown> | undefined
        const message = (typeof err?.['message'] === 'string' && err['message']) || (typeof ev['message'] === 'string' && ev['message']) || 'O Codex terminou com erro.'
        out.push({ type: 'error', message })
      }
      return out
    },
    end(code, stderr) {
      if (finished) return []
      const detail = lastLines(stderr)
      return [{ type: 'error', message: `O Codex saiu sem resposta (código ${code ?? '?'}).${detail ? `\n${detail}` : ''}` }]
    }
  }
}

export function codexEngine(bin: () => string | undefined, home: string): Engine {
  return {
    id: 'codex',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: 'O Codex não está instalado. Veja em Configurações.' }
        return
      }
      yield* runCli({ bin: path, args: codexArgs(turn), stdin: turn.prompt, cwd: turn.cwd, signal: turn.signal, parser: codexParser(), env: codexEnv(home) })
    }
  }
}
