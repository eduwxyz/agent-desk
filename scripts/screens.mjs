// Opens the built app with Playwright and saves screenshots of the main flows.
// Uses a fresh data directory and the fake engines, so nothing touches your
// real database or spends your subscription. Pass --real to use the real CLIs.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? 'screens'
const real = process.argv.includes('--real')
mkdirSync(out, { recursive: true })

const data = mkdtempSync(join(tmpdir(), 'agent-desk-'))
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

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors')
console.log(`data: ${data}`)
await app.close()
