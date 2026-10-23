// Screenshots of the browser (M14) with the real Claude Code: turning it on,
// a search on the Airbnb watched live in the panel, "Assumir", and a risky
// click that waits for approval. Fresh data; a local page for the risky click.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens-browser'
mkdirSync(out, { recursive: true })
const page = `<html><head><title>Loja de teste</title></head><body style="font:18px sans-serif;padding:24px"><h1>Loja de teste</h1><p>Caneca do agent-desk, R$ 49,90</p><button onclick="out.textContent='Pedido feito!'">Comprar agora</button><p id=out></p></body></html>`
const srv = createServer((_q, r) => (r.setHeader('content-type', 'text/html; charset=utf-8'), r.end(page))).listen(0)
const shop = `http://127.0.0.1:${srv.address().port}/`

const data = mkdtempSync(join(tmpdir(), 'agent-desk-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, AGENT_DESK_DATA: data, AGENT_DESK_SEED: '1' } })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1360, height: 880 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
const card = (title, name) => win.locator(`.card:has(.card__head :text-is("${title}"))`).first().screenshot({ path: `${out}/${name}.png` })
const step = async (name, fn) => {
  try {
    await fn()
  } catch (e) {
    errors.push(`${name}: ${String(e).split('\n')[0]}`)
    await shot(`erro-${name}`)
  }
}
const idle = async (timeout = 240_000) => {
  await win.waitForTimeout(3000)
  await win.waitForFunction(() => !document.querySelector('.msg .is-running, .msg [data-status="working"], .composer .btn--stop'), null, { timeout }).catch(() => {})
  await win.waitForTimeout(1500)
}
const send = async (text) => {
  await win.fill('.composer textarea', text)
  await win.keyboard.press('Enter')
}

await step('ligar', async () => {
  await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
  await win.click('.card:has(.card__head :text-is("Navegador")) button[role=radio]:text-is("Ligado")')
  await win.waitForTimeout(400)
  await card('Navegador', '01-navegador-ligado')
  await win.click('.nav-item:has-text("Configurações")').catch(() => {})
  await win.waitForTimeout(400)
  await card('Navegador dos agentes', '02-configuracoes')
})

await step('busca', async () => {
  await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
  await win.click('text=Abrir DM')
  await send('Abre o airbnb.com.br no seu navegador, escreve Chicago no campo Onde e escolhe a sugestão "Chicago, Illinois". Não clique em Buscar. Me diz em uma frase o que apareceu na tela depois.')
  await win.waitForSelector('.browser-card', { timeout: 120_000 })
  await win.waitForTimeout(4000)
  await shot('03-trabalhando')
  await idle()
  await shot('04-resposta')
  await win.click('.browser-card')
  await win.waitForSelector('.browser-view')
  await win.waitForTimeout(600)
  await shot('05-painel-ao-vivo')
})

await step('assumir', async () => {
  await win.click('.side-panel button:has-text("Assumir")')
  await win.waitForSelector('.browser-view__note', { timeout: 10_000 })
  await shot('06-assumido')
  await win.click('.side-panel button:has-text("Devolver")')
  await win.waitForSelector('.side-panel button:has-text("Assumir")', { timeout: 10_000 })
})

await step('aprovacao', async () => {
  await send(`Abre ${shop} e compra a caneca.`)
  await win.waitForSelector('.approval, [class*=approval]', { timeout: 180_000 })
  await idle()
  await shot('07-pedido-de-aprovacao')
  await win.click('button:has-text("Aprovar")')
  await win.waitForTimeout(3000)
  await idle()
  await shot('08-depois-de-aprovar')
})

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors')
await app.close()
srv.close()
