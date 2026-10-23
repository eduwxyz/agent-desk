// Frames of the opening (splash) of the introduction, on a new install.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2] ?? 'screens'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'agent-desk-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, AGENT_DESK_DATA: data, AGENT_DESK_FAKE_ENGINES: '1', AGENT_DESK_SEED: '0' } })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 800 })
await win.waitForSelector('.splash')
const start = Date.now()
console.log('áudio sem clique:', await win.evaluate(() => new AudioContext().state))
for (const ms of [150, 350, 470, 560, 900, 1000, 1350, 1700, 2000, 2400, 2900, 3400, 3900]) {
  await win.waitForTimeout(Math.max(0, ms - (Date.now() - start)))
  await win.screenshot({ path: `${out}/f-${String(ms).padStart(4, '0')}.png` })
}
console.log('depois:', await win.locator('.onb').count() ? 'boas-vindas' : 'ainda na abertura')
await app.close()
