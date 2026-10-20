// Screenshots of the browser live (M14): the card in the chat while the agent
// works, and the side panel. Real Claude Code, fresh data.
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
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
await win.click('.card:has(.card__head :text-is("Navegador")) button[role=radio]:text-is("Ligado")')
await win.waitForTimeout(400)
await win.click('text=Abrir DM')
await win.fill('.composer textarea', 'Abre o airbnb.com.br no seu navegador, escreve Chicago no campo Onde, escolhe a sugestão "Chicago, Illinois" e depois clica em Buscar. Me diz em uma frase quantas opções apareceram.')
await win.keyboard.press('Enter')
await win.waitForSelector('.browser-live', { timeout: 120_000 }).catch(() => errors.push('sem .browser-live'))
for (let i = 0; i < 12; i++) {
  await win.waitForTimeout(2500)
  await win.locator('.browser-live').first().screenshot({ path: `${out}/card-${String(i).padStart(2, '0')}.png` }).catch(() => {})
  if (i === 3) await shot('chat-trabalhando')
}
await win.click('.browser-live [title="Abrir ao lado"]').catch((e) => errors.push(String(e)))
await win.waitForTimeout(1500)
await shot('painel')
await win.waitForFunction(() => !document.querySelector('.composer .btn--stop'), null, { timeout: 150_000 }).catch(() => {})
await win.waitForTimeout(2500)
await shot('painel-fim')
await win.click('.side-panel [title="Fechar"]').catch(() => {})
await win.waitForTimeout(800)
await shot('chat-fim')
await win.click('.sidebar button[title="Trocar tema"]').catch((e) => errors.push(String(e)))
await win.waitForTimeout(800)
await shot('chat-fim-escuro')
console.log('erros:', errors)
await app.close()
