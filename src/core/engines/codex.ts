import { GATEWAY_NAME } from './claude'
import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import type { Engine, EngineEvent, Turn } from './types'

// Flags that keep the CLI isolated: ignore the user's config, rules, MCP
// servers and plugins; no saved session; the shell is sandboxed read-only in
// an empty directory. The prompt comes from stdin ("-"). The app's gateway,
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

export function codexEngine(bin: () => string | undefined): Engine {
  return {
    id: 'codex',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: 'O Codex não está instalado. Veja em Configurações.' }
        return
      }
      yield* runCli({ bin: path, args: codexArgs(turn), stdin: turn.prompt, cwd: turn.cwd, signal: turn.signal, parser: codexParser() })
    }
  }
}
