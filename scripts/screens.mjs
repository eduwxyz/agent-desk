// Opens the built app with Playwright and saves screenshots of the main screens.
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
const settle = (ms = real ? 30_000 : 4000) => win.waitForSelector('.steps__toggle:not(:has(.shimmer))', { timeout: ms })

await shot('01-engenharia')

// Channel without a mention: the hint about @mentions.
await win.fill('.composer textarea', 'Alguém aí?')
await win.keyboard.press('Enter')
await win.waitForSelector('.system-line')
await shot('02-sem-mencao')

// Mention in a channel: Lia answers.
await win.fill('.composer textarea', '@lia em uma frase: o que é um utility process no Electron?')
await win.keyboard.press('Enter')
await win.waitForSelector('.msg .typing, .msg .shimmer')
await shot('03-streaming')
await settle()
await win.waitForTimeout(300)
await shot('04-respondeu')

// DM with Theo (Codex).
await win.click('.section:has-text("Agentes") .nav-item:has-text("Theo")')
await win.click('text=Abrir DM')
await win.fill('.composer textarea', 'Em uma frase: média ou mediana pra tempo de resposta?')
await win.keyboard.press('Enter')
await win.waitForTimeout(500)
await settle(real ? 60_000 : 4000)
await win.waitForTimeout(300)
await win.click('.receipt__line')
await shot('05-dm-codex')

await win.click('text=Uso e limites')
await shot('06-uso')

await win.click('text=Configurações')
await shot('07-config')

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors')
console.log(`data: ${data}`)
await app.close()
