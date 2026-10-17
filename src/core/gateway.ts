// The gateway is a local MCP server and the only source of tools a CLI gets.
// Each turn opens a session with its own secret URL and its own tool list;
// the gateway answers tools/list with exactly that list and refuses any call
// outside it. The CLI never talks to connectors directly.
import { randomBytes } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'

export interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
}

export interface Session {
  tools: ToolDef[]
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>
}

export const textResult = (text: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text }], isError })

export class Gateway {
  private http: HttpServer | null = null
  private port = 0
  private sessions = new Map<string, Session>()

  async start(): Promise<void> {
    this.http = createServer((req, res) => {
      void this.handle(req, res).catch((e: unknown) => {
        console.error('[gateway]', e)
        if (!res.headersSent) res.writeHead(500).end()
      })
    })
    await new Promise<void>((resolve) => this.http!.listen(0, '127.0.0.1', resolve))
    this.port = (this.http.address() as AddressInfo).port
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()))
    this.http = null
  }

  // Returns the URL to hand to the CLI, and a function that revokes it.
  open(session: Session): { url: string; close: () => void } {
    const token = randomBytes(24).toString('hex')
    this.sessions.set(token, session)
    return { url: `http://127.0.0.1:${this.port}/mcp/${token}`, close: () => this.sessions.delete(token) }
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const token = /^\/mcp\/([a-f0-9]{48})$/.exec(req.url ?? '')?.[1]
    const session = token ? this.sessions.get(token) : undefined
    if (!session) {
      res.writeHead(404).end()
      return
    }

    // Stateless: a fresh MCP server per request, bound to this session's tools.
    const server = new Server({ name: 'agent-desk', version: '0.1.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: session.tools }))
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      const name = r.params.name
      // Defense in depth: a tool that was not listed for this turn never runs.
      if (!session.tools.some((t) => t.name === name)) return textResult(`Ferramenta não permitida: ${name}`, true)
      return session.call(name, (r.params.arguments ?? {}) as Record<string, unknown>)
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }
}
