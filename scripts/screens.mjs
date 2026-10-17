// Opens the built app with Playwright and saves screenshots of the main screens.
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'

const out = process.argv[2] ?? 'screens'
mkdirSync(out, { recursive: true })

const app = await electron.launch({ args: ['.'] })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 820 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const shot = async (name) => win.screenshot({ path: `${out}/${name}.png` })
await shot('01-engenharia')

await win.click('text=dados')
await shot('02-dados')

await win.click('.nav-item:has-text("Lia") >> nth=0')
await win.fill('.composer textarea', 'Consegue rodar os testes de novo?')
await win.keyboard.press('Enter')
await win.waitForTimeout(1600)
await shot('03-dm-streaming')
await win.waitForTimeout(3500)
await shot('04-dm-done')

await win.click('text=Aprovações')
await shot('05-aprovacoes')

await win.click('.section:has-text("Agentes") .nav-item:has-text("Theo")')
await shot('06-agente')

await win.click('text=Uso e limites')
await shot('07-uso')

await win.click('text=Conectores')
await shot('08-conectores')

await win.click('text=Configurações')
await shot('09-config')

await win.click('[title="Trocar tema"]')
await win.click('text=engenharia')
await win.fill('.composer textarea', '@')
await shot('10-dark-mention')

// Hold-to-approve on the high-risk approval card.
await win.fill('.composer textarea', '')
const hold = win.locator('.btn--hold')
const box = await hold.boundingBox()
await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await win.mouse.down()
await win.waitForTimeout(1700)
await win.mouse.up()
await win.waitForTimeout(1800)
await shot('11-approved')

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors')
await app.close()
