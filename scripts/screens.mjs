// Opens the built app with Playwright and saves screenshots of the main flows.
// Uses a fresh data directory and the fake engines, so nothing touches your
// real database or spends your subscription. Pass --real to use the real CLIs.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? 'screens'
const real = process.argv.includes('--real')
mkdirSync(out, { recursive: true })

const data = mkdtempSync(join(tmpdir(), 'agent-desk-'))
for (const dir of [tmpdir(), '/tmp']) rmSync(join(dir, 'agent-desk-demo-tasks.json'), { force: true }) // the demo connector starts from its sample list
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, AGENT_DESK_DATA: data, ...(real ? {} : { AGENT_DESK_FAKE_ENGINES: '1' }) }
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 820 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const shot = async (name) => win.screenshot({ path: `${out}/${name}.png` })
const busy = '.msg .shimmer, .msg .typing, .system-line.is-pending'
// Waits until nothing is routing or answering, including replies that start later (handoffs).
async function settle() {
  const deadline = Date.now() + (real ? 180_000 : 15_000)
  let quiet = 0
  while (Date.now() < deadline && quiet < (real ? 6 : 3)) {
    await win.waitForTimeout(500)
    quiet = (await win.locator(busy).count()) === 0 ? quiet + 1 : 0
  }
}
async function send(text) {
  await win.fill('.composer textarea', text)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(400)
}

await shot('01-inicio')

// No mention, two agents: the router picks.
await send('O build do checkout quebrou depois do último merge. Alguém consegue olhar o que pode ser?')
await win.waitForSelector('.system-line')
await shot('02-router-escolhendo')
await settle()
await shot('03-router-escolheu')

// The agent asks a question with ask_user; the next message answers it.
await send('@lia antes de sugerir qualquer coisa, use a ferramenta de pergunta pra me perguntar qual é o meu prazo.')
await settle()
await shot('04-pergunta')
await send('Até sexta.')
await settle()
await shot('05-respondeu-pergunta')

// Handoff: Lia mentions Theo, who answers next.
await send('@lia peça pro Theo calcular a mediana de 3, 9 e 4, mencionando ele com arroba. Você não calcula.')
await settle()
await shot('06-handoff')

await win.click('text=Uso e limites')
await shot('07-uso')

// ---------- M3: connector, grant, tools, approval ----------

await win.click('.nav-item:has-text("Conectores")')
await win.click('text=Adicionar conector')
await win.click('button[role=radio]:has-text("Local")')
await win.click('text=Preencher com o servidor de demonstração')
await shot('08-novo-conector')
await win.click('button:has-text("Conectar")')
await win.waitForSelector('.connector .tag:has-text("conectado")', { timeout: 20_000 })
await win.click('.connector__head')
await shot('09-conector-ferramentas')

// Give Lia read and write on it.
await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
await win.click('.grant:has-text("Tarefas") button:has-text("Ler e escrever")')
await win.click('button:has-text("Salvar")')
await win.waitForSelector('.saved')
await shot('10-grant')

await win.click('text=Abrir DM')
await send('Liste as minhas tarefas.')
await settle()
await shot('11-consultou')

await send('Apague a tarefa 2, por favor.')
await settle()
await win.waitForSelector('.approval', { timeout: real ? 60_000 : 5000 })
await shot('12-pedido-de-aprovacao')

await win.click('.approval button:has-text("Aprovar")')
await settle()
await shot('13-aprovado')

await win.click('.nav-item:has-text("Aprovações")')
await shot('14-aprovacoes')

await win.click('.nav-item:has-text("Conectores")')
await win.click('.connector__head')
await shot('15-ferramenta-nova')

// Theo (Codex) reads the same connector.
await win.click('.section:has-text("Agentes") .nav-item:has-text("Theo")')
await win.click('.grant:has-text("Tarefas") button:has-text("Ler"):not(:has-text("escrever"))')
await win.click('button:has-text("Salvar")')
await win.waitForSelector('.saved')
await win.click('text=Abrir DM')
await send('Quais tarefas ainda estão abertas?')
await settle()
await shot('16-codex-consultou')

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors')
console.log(`data: ${data}`)
await app.close()
