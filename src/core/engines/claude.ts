import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import type { Engine, EngineEvent, Turn } from './types'

// Flags that keep the CLI isolated: no built-in tools (shell, files, web), no
// user settings, hooks, plugins or MCP servers, and no saved session. Not
// --bare: it turns off the subscription login.
export function claudeArgs(turn: Pick<Turn, 'model' | 'effort' | 'system'>): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', turn.model,
    '--effort', turn.effort,
    '--system-prompt', turn.system,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--no-session-persistence'
  ]
}

export function claudeParser(): Parser {
  let doneTokens = 0 // tokens of model calls already finished in this turn
  let callInput = 0
  let callOutput = 0
  let finished = false

  return {
    line(line) {
      const ev = parseJson(line)
      if (!ev) return []
      const out: EngineEvent[] = []

      if (ev['type'] === 'stream_event') {
        const e = ev['event'] as Record<string, unknown> | undefined
        if (!e) return []
        if (e['type'] === 'message_start') {
          doneTokens += callInput + callOutput
          const u = ((e['message'] as Record<string, unknown> | undefined)?.['usage'] ?? {}) as Record<string, unknown>
          callInput = num(u['input_tokens']) + num(u['cache_read_input_tokens']) + num(u['cache_creation_input_tokens'])
          callOutput = 0
          out.push({ type: 'progress', tokens: doneTokens + callInput })
        } else if (e['type'] === 'content_block_delta') {
          const d = e['delta'] as Record<string, unknown> | undefined
          if (d?.['type'] === 'text_delta' && typeof d['text'] === 'string') out.push({ type: 'text', delta: d['text'] })
        } else if (e['type'] === 'message_delta') {
          callOutput = num((e['usage'] as Record<string, unknown> | undefined)?.['output_tokens'])
          out.push({ type: 'progress', tokens: doneTokens + callInput + callOutput })
        }
      } else if (ev['type'] === 'result') {
        finished = true
        const u = (ev['usage'] ?? {}) as Record<string, unknown>
        const text = typeof ev['result'] === 'string' ? ev['result'] : ''
        if (ev['is_error'] === true || ev['subtype'] !== 'success') {
          out.push({ type: 'error', message: text || `O Claude Code terminou com erro (${String(ev['subtype'])}).` })
        } else {
          const cacheRead = num(u['cache_read_input_tokens'])
          out.push({
            type: 'done',
            text,
            usage: {
              inputTokens: num(u['input_tokens']) + cacheRead + num(u['cache_creation_input_tokens']),
              cacheReadTokens: cacheRead,
              outputTokens: num(u['output_tokens']),
              apiCostUsd: typeof ev['total_cost_usd'] === 'number' ? ev['total_cost_usd'] : undefined
            }
          })
        }
      }
      return out
    },
    end(code, stderr) {
      if (finished) return []
      const detail = lastLines(stderr)
      return [{ type: 'error', message: `O Claude Code saiu sem resposta (código ${code ?? '?'}).${detail ? `\n${detail}` : ''}` }]
    }
  }
}

export function claudeEngine(bin: () => string | undefined): Engine {
  return {
    id: 'claude',
    async *run(turn) {
      const path = bin()
      if (!path) {
        yield { type: 'error', message: 'O Claude Code não está instalado. Veja em Configurações.' }
        return
      }
      yield* runCli({ bin: path, args: claudeArgs(turn), stdin: turn.prompt, cwd: turn.cwd, signal: turn.signal, parser: claudeParser() })
    }
  }
}
