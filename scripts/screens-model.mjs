// Screenshot of the agent page with a model name the app doesn't list (a company gateway's).
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'agent-desk-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, AGENT_DESK_DATA: data } })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1360, height: 880 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
const models = win.locator('.models')
await models.scrollIntoViewIfNeeded()
await models.screenshot({ path: `${out}/modelos-antes.png` })
await win.click('.model--custom')
await win.fill('.model__name', 'claude-sonnet-4-5-empresa')
await win.waitForTimeout(300)
await models.screenshot({ path: `${out}/modelos-outro.png` })
await win.click('.page button.btn--primary:has-text("Salvar")').catch((e) => errors.push(String(e)))
await win.waitForTimeout(500)
await win.reload()
await win.waitForSelector('.sidebar')
await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
await win.locator('.models').scrollIntoViewIfNeeded()
await win.locator('.models').screenshot({ path: `${out}/modelos-salvo.png` })
console.log('valor salvo:', await win.inputValue('.model__name'), 'erros:', errors)
await app.close()
