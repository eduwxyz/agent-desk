#!/usr/bin/env node
// A small local MCP server (stdio) for trying connectors without any account:
// a to-do list saved to a JSON file. It has one tool of each class, and it
// publishes a new tool after the first call, to show that late tools come in
// disabled until reviewed.
//
//   node scripts/demo-mcp-server.mjs
//   DEMO_TASKS_FILE=/tmp/tasks.json node scripts/demo-mcp-server.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const file = process.env.DEMO_TASKS_FILE ?? join(tmpdir(), 'agent-desk-demo-tasks.json')
const load = () => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return [
      { id: 1, title: 'Revisar o PR do checkout', done: false },
      { id: 2, title: 'Escrever o post de lançamento', done: false },
      { id: 3, title: 'Atualizar dependências', done: true }
    ]
  }
}
const save = (tasks) => writeFileSync(file, JSON.stringify(tasks, null, 2))
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError })
const idArg = { type: 'object', properties: { id: { type: 'number', description: 'Id da tarefa' } }, required: ['id'] }

const TOOLS = [
  { name: 'list_tasks', description: 'Lista as tarefas, abertas e concluídas.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  {
    name: 'create_task',
    description: 'Cria uma tarefa.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
  },
  { name: 'complete_task', description: 'Marca uma tarefa como concluída.', inputSchema: idArg },
  { name: 'delete_task', description: 'Apaga uma tarefa de vez.', inputSchema: idArg, annotations: { destructiveHint: true } }
]
const LATE = { name: 'export_tasks', description: 'Exporta as tarefas em Markdown.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }
let late = false

const server = new Server({ name: 'agent-desk-demo', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: late ? [...TOOLS, LATE] : TOOLS }))
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const tasks = load()
  const args = params.arguments ?? {}
  const find = () => tasks.find((t) => t.id === Number(args.id))
  let result
  switch (params.name) {
    case 'list_tasks':
      result = text(tasks.map((t) => `#${t.id} [${t.done ? 'x' : ' '}] ${t.title}`).join('\n') || 'Nenhuma tarefa.')
      break
    case 'create_task': {
      const task = { id: Math.max(0, ...tasks.map((t) => t.id)) + 1, title: String(args.title ?? '').trim() || 'Sem título', done: false }
      save([...tasks, task])
      result = text(`Criada: #${task.id} ${task.title}`)
      break
    }
    case 'complete_task': {
      const t = find()
      if (!t) return text(`Tarefa #${args.id} não existe.`, true)
      t.done = true
      save(tasks)
      result = text(`Concluída: #${t.id} ${t.title}`)
      break
    }
    case 'delete_task': {
      const t = find()
      if (!t) return text(`Tarefa #${args.id} não existe.`, true)
      save(tasks.filter((x) => x !== t))
      result = text(`Apagada: #${t.id} ${t.title}`)
      break
    }
    case 'export_tasks':
      result = text(tasks.map((t) => `- [${t.done ? 'x' : ' '}] ${t.title}`).join('\n'))
      break
    default:
      return text(`Ferramenta desconhecida: ${params.name}`, true)
  }
  if (!late) {
    late = true
    setTimeout(() => void server.sendToolListChanged(), 50)
  }
  return result
})

await server.connect(new StdioServerTransport())
