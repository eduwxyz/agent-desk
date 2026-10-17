import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Parser } from '../src/core/engines/cli'
import { claudeArgs, claudeParser } from '../src/core/engines/claude'
import { CODEX_DISABLED_FEATURES, codexArgs, codexEnv, codexParser } from '../src/core/engines/codex'
import type { EngineEvent } from '../src/core/engines/types'

// Fixtures are real CLI output (Claude Code 2.1.286, Codex 0.153.4), trimmed of local paths.
const fixture = (name: string): string[] => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8').split('\n')

function feed(parser: Parser, lines: string[], exit = 0, stderr = ''): EngineEvent[] {
  return [...lines.flatMap((l) => (l.trim() ? parser.line(l) : [])), ...parser.end(exit, stderr)]
}

const text = (events: EngineEvent[]): string => events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')

describe('Claude Code stream', () => {
  it('streams the text and reports the final usage', () => {
    const events = feed(claudeParser(), fixture('claude-stream.jsonl'))
    expect(text(events)).toBe('oi, tudo certo.')
    const done = events.find((e) => e.type === 'done')
    expect(done).toEqual({
      type: 'done',
      text: 'oi, tudo certo.',
      usage: { inputTokens: 10 + 6617, cacheReadTokens: 6617, outputTokens: 84, apiCostUsd: 0.0010917 }
    })
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('reports growing progress while streaming', () => {
    const progress = feed(claudeParser(), fixture('claude-stream.jsonl')).flatMap((e) => (e.type === 'progress' ? [e.tokens] : []))
    expect(progress.length).toBeGreaterThan(0)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(progress.at(-1)).toBe(10 + 6617 + 84)
  })

  it('turns an error result into an error event', () => {
    const events = feed(claudeParser(), ['{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}'])
    expect(events).toEqual([{ type: 'error', message: 'Not logged in · Please run /login' }])
  })

  it('reports an error when the process exits without a result', () => {
    const events = feed(claudeParser(), [], 1, 'boom\nsomething failed')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error' })
    expect((events[0] as { message: string }).message).toContain('something failed')
  })

  it('ignores lines that are not JSON or not known', () => {
    expect(feed(claudeParser(), ['not json', '{"type":"rate_limit_event"}', '{"type":"something_new"}'], 0)).toHaveLength(1) // only the "no result" error
  })

  it('separates text from model calls before and after a tool call', () => {
    const start = '{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":5}}}}'
    const delta = (t: string): string => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })
    expect(text(feed(claudeParser(), [start, delta('Vou perguntar.'), start, delta('Pronto.')]))).toBe('Vou perguntar.\n\nPronto.')
  })

  it('gets the gateway as its only MCP server, with its tools pre-allowed', () => {
    const args = claudeArgs({ model: 'sonnet', effort: 'low', system: 'x', mcpUrl: 'http://127.0.0.1:1/mcp/abc' })
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!)).toEqual({ mcpServers: { agentdesk: { type: 'http', url: 'http://127.0.0.1:1/mcp/abc' } } })
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__agentdesk')
    expect(args).toContain('--strict-mcp-config')
    expect(claudeArgs({ model: 'sonnet', effort: 'low', system: 'x' })).not.toContain('--mcp-config')
  })

  it('runs isolated: no built-in tools, no user settings, no session, never --bare', () => {
    const args = claudeArgs({ model: 'sonnet', effort: 'medium', system: 'x' })
    expect(args).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--no-session-persistence']))
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('x')
    expect(args).not.toContain('--bare')
  })
})

describe('Codex exec stream', () => {
  it('collects agent messages and reports the turn usage', () => {
    const events = feed(codexParser(), fixture('codex-exec.jsonl'))
    expect(text(events)).toBe('oi, tudo certo.')
    expect(events.find((e) => e.type === 'done')).toEqual({
      type: 'done',
      text: 'oi, tudo certo.',
      usage: { inputTokens: 14839, cacheReadTokens: 10368, outputTokens: 9 }
    })
    // The "error" item in the fixture is a hook warning, not a failure.
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('turns a failed turn into an error event', () => {
    const events = feed(codexParser(), ['{"type":"turn.failed","error":{"message":"usage limit reached"}}'])
    expect(events).toEqual([{ type: 'error', message: 'usage limit reached' }])
  })

  it('runs isolated from the user config, read-only, with instructions as developer_instructions', () => {
    const args = codexArgs({ model: 'gpt-5.6-luna', effort: 'low', system: 'Você é "Theo".', cwd: '/tmp/x' })
    expect(args).toEqual(expect.arrayContaining(['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules']))
    expect(args[args.indexOf('-s') + 1]).toBe('read-only')
    expect(args[args.indexOf('-C') + 1]).toBe('/tmp/x')
    expect(args).toContain('developer_instructions="Você é \\"Theo\\"."')
    expect(args.at(-1)).toBe('-')
  })

  it('turns off skills, web search, project docs and every built-in tool', () => {
    const args = codexArgs({ model: 'gpt-5.6-luna', effort: 'low', system: 'x', cwd: '/tmp/x' })
    expect(args).toEqual(expect.arrayContaining(['skills.include_instructions=false', 'skills.bundled.enabled=false', 'web_search="disabled"', 'project_doc_max_bytes=0']))
    for (const f of ['shell_tool', 'unified_exec', 'plugins', 'computer_use', 'multi_agent']) {
      expect(CODEX_DISABLED_FEATURES).toContain(f)
      expect(args[args.indexOf(f) - 1]).toBe('--disable')
    }
  })

  it('runs in the app\'s own home, so the user\'s AGENTS.md, skills and memories never load', () => {
    expect(codexEnv('/data/codex-home')).toMatchObject({ HOME: '/data/codex-home', CODEX_HOME: '/data/codex-home/.codex' })
  })

  it('gets the gateway as its only MCP server, with approval delegated to the gateway', () => {
    const args = codexArgs({ model: 'gpt-5.6-luna', effort: 'low', system: 'x', cwd: '/tmp/x', mcpUrl: 'http://127.0.0.1:1/mcp/abc' })
    expect(args).toContain('mcp_servers.agentdesk.url="http://127.0.0.1:1/mcp/abc"')
    expect(args).toContain('mcp_servers.agentdesk.default_tools_approval_mode="approve"')
    expect(args.at(-1)).toBe('-')
  })
})
