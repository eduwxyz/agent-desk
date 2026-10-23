// Screenshots of the Mac computer (M13): the choice, the confirmation, a command
// run on the Mac with the badge, and turning it off. Fake engines, fresh data.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens-mac'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'agent-desk-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, AGENT_DESK_DATA: data, AGENT_DESK_SEED: '1', AGENT_DESK_FAKE_ENGINES: '1' } })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 860 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
const card = (name) => win.locator('.card:has(.card__head :text-is("Computador"))').first().screenshot({ path: `${out}/${name}.png` })
const step = async (name, fn) => {
  try {
    await fn()
  } catch (e) {
    errors.push(`${name}: ${String(e).split('\n')[0]}`)
    await shot(`erro-${name}`)
  }
}

await step('escolha', async () => {
  await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
  await card('01-computador-nenhum')
  await win.click('.card:has(.card__head :text-is("Computador")) button[role=radio]:has-text("Este Mac")')
  await win.waitForSelector('.mac-confirm')
  await card('02-confirmar-mac')
  await win.click('button:has-text("Liberar o Mac pra ele")')
  await win.waitForSelector('.card:has(.card__head :text-is("Computador")) .tag:has-text("no seu Mac")')
  await card('03-mac-ligado')
  await shot('04-pagina-com-selo')
})

await step('comando', async () => {
  await win.click('text=Abrir DM')
  await win.fill('.composer textarea', 'rode `pwd && which ffmpeg python3 && sw_vers -productName && echo "HOME=$HOME"`')
  await win.keyboard.press('Enter')
  await win.waitForSelector('.msg:has(.tag:has-text("no seu Mac"))', { timeout: 20_000 })
  await win.waitForTimeout(2500)
  await shot('05-comando-no-mac')
  const step = win.locator('.msg .step, .msg [class*=step]').last()
  if (await step.count()) await step.click().catch(() => {})
  await win.waitForTimeout(500)
  await shot('06-passo-aberto')
})

await step('desligar', async () => {
  await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
  await win.click('.card:has(.card__head :text-is("Computador")) button[role=radio]:has-text("Nenhum")')
  await win.waitForTimeout(400)
  await card('07-de-volta-nenhum')
})

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors')
await app.close()
