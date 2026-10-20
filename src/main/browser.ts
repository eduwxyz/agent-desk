// Each agent's browser (spec §24): a hidden window of Electron's Chromium with
// a session of its own, so its logins stay apart from everything else and last
// between conversations. The core decides what to do; this file only drives the
// page and reports back. "Assumir" shows the same window so I can log in.
import { BrowserWindow, session, type WebContents } from 'electron'
import type { BrowserOp, BrowserReply as Reply } from '../shared/types'

const W = 1280
const H = 800
const WORLD = 1001 // an isolated world: same DOM, but the page can't see or touch our variables
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const KEYS: Record<string, { code: string; char?: string }> = {
  enter: { code: 'Enter', char: '\r' },
  escape: { code: 'Escape' },
  tab: { code: 'Tab' },
  backspace: { code: 'Backspace' },
  space: { code: 'Space', char: ' ' },
  arrowdown: { code: 'Down' },
  arrowup: { code: 'Up' },
  arrowleft: { code: 'Left' },
  arrowright: { code: 'Right' },
  pagedown: { code: 'PageDown' },
  pageup: { code: 'PageUp' }
}

// What can be clicked or filled, numbered, inside shadow roots too.
const SNAPSHOT = `(() => {
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=menuitem],[role=menuitemcheckbox],[role=option],[role=combobox],[role=switch],[role=textbox],[role=searchbox],[role=slider],[contenteditable=""],[contenteditable=true],[onclick]'
  const found = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.matches(SEL)) found.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const W = innerWidth, H = innerHeight, refs = [], out = []
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  // "Tudo Tudo": a visible label and a hidden copy for screen readers.
  const once = (s) => { const w = s.split(' '); const h = w.length / 2; return w.length % 2 === 0 && w.slice(0, h).join(' ') === w.slice(h).join(' ') ? w.slice(0, h).join(' ') : s }
  const ROLES = { button: 'botão', tab: 'aba', menuitem: 'item de menu', menuitemcheckbox: 'item de menu', option: 'opção', combobox: 'campo', textbox: 'campo', searchbox: 'campo', switch: 'chave', slider: 'controle' }
  const byIds = (ids) => clean((ids || '').split(/\\s+/).map((id) => { const n = id && (el.getRootNode().getElementById ? el.getRootNode() : document).getElementById(id); return n ? n.innerText || n.textContent : '' }).join(' '))
  let el
  for (el of found) {
    const r = el.getBoundingClientRect()
    if (r.width < 3 || r.height < 3) continue
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
    const tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase()
    const field = tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) || el.isContentEditable
    const aria = el.getAttribute('role')
    const role = (aria && (ROLES[aria] || aria)) || (tag === 'a' ? 'link' : tag === 'select' ? 'lista' : field ? 'campo' : tag === 'input' && (type === 'checkbox' || type === 'radio') ? type : 'botão')
    let label = clean(el.getAttribute('aria-label')) || byIds(el.getAttribute('aria-labelledby')) || clean(el.getAttribute('title'))
    if (!label && field) label = clean(el.labels && el.labels[0] && el.labels[0].innerText) || clean(el.getAttribute('placeholder')) || clean(el.getAttribute('name'))
    if (!label && !field) label = clean(el.innerText) || clean(el.getAttribute('alt')) || clean(el.querySelector && el.querySelector('img[alt]') && el.querySelector('img[alt]').alt) || clean(el.value)
    let value
    if (tag === 'select') value = clean(el.selectedOptions[0] && el.selectedOptions[0].text)
    else if (field && !el.isContentEditable) value = type === 'password' ? (el.value ? '••••' : '') : clean(el.value).slice(0, 80)
    else if (el.isContentEditable) value = clean(el.innerText).slice(0, 80)
    const c = el.checked !== undefined && (type === 'checkbox' || type === 'radio') ? el.checked : el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' ? true : undefined
    refs.push(new WeakRef(el))
    out.push({ ref: refs.length, role, label: once(label).slice(0, 100), value: value || undefined, checked: c, disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined, inView: r.bottom > 0 && r.right > 0 && r.top < H && r.left < W })
  }
  window.__adRefs = refs
  return { url: location.href, title: document.title, w: W, h: H, scrollY: Math.round(scrollY), scrollH: document.documentElement.scrollHeight, elements: out }
})()`

// Where to click an element of the last snapshot, brought into view first.
const POINT = (ref: number, focus: boolean): string => `(() => {
  const el = window.__adRefs && window.__adRefs[${ref - 1}] && window.__adRefs[${ref - 1}].deref()
  if (!el || !el.isConnected) return null
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const r = el.getBoundingClientRect()
  if (${focus}) {
    el.focus()
    if (el.select) el.select()
    else if (el.isContentEditable) getSelection().selectAllChildren(el)
  }
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, select: el.tagName === 'SELECT' }
})()`

// A <select> takes the option whose text matches, like a person picking it.
const PICK = (ref: number, text: string): string => `(() => {
  const el = window.__adRefs[${ref - 1}].deref(), want = ${JSON.stringify(text.toLowerCase())}
  const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === want) || [...el.options].find((o) => o.text.toLowerCase().includes(want))
  if (!opt) return [...el.options].map((o) => o.text.trim())
  el.value = opt.value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`

// The text a person reads on the page, shadow roots included, line by block.
const TEXT = `(() => {
  const out = [], SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG'])
  const walk = (node) => {
    for (const c of (node.shadowRoot || node).childNodes) {
      if (c.nodeType === 3) { const t = c.data.replace(/\\s+/g, ' ').trim(); if (t) out.push(t + ' ') }
      else if (c.nodeType === 1 && !SKIP.has(c.tagName)) {
        if (c.checkVisibility && !c.checkVisibility()) continue
        const d = getComputedStyle(c).display
        const block = d !== 'inline' && d !== 'contents' && d !== 'inline-block'
        if (block) out.push('\\n')
        walk(c)
        if (block) out.push('\\n')
      }
    }
  }
  walk(document.body)
  return out.join('').replace(/ +\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim()
})()`

export class Browsers {
  private wins = new Map<string, BrowserWindow>()
  private reopening = new Map<string, Promise<void>>()
  private quitting = false

  constructor(private onShown: (agentId: string, shown: boolean) => void) {}

  quit(): void {
    this.quitting = true
    for (const w of this.wins.values()) w.destroy()
    this.wins.clear()
  }

  private partition(agentId: string): string {
    return `persist:navegador-${agentId}`
  }

  private win(agentId: string): BrowserWindow {
    const existing = this.wins.get(agentId)
    if (existing && !existing.isDestroyed()) return existing
    const ses = session.fromPartition(this.partition(agentId))
    // A plain Chrome, as far as sites can tell: some refuse logins in "embedded" browsers.
    ses.setUserAgent(ses.getUserAgent().replace(/\s(agent-desk|Electron)\/\S+/g, ''))
    ses.setPermissionRequestHandler((_wc, _perm, done) => done(false)) // no camera, mic, location, notifications
    ses.on('will-download', (_e, item) => item.cancel())
    const win = new BrowserWindow({
      show: false,
      width: W,
      height: H,
      useContentSize: true,
      title: 'Navegador',
      webPreferences: { partition: this.partition(agentId), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    })
    // New tabs open in place while the agent drives; as real windows while I do.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (win.isVisible()) return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { partition: this.partition(agentId), sandbox: true } } }
      if (/^https?:\/\//.test(url)) void win.loadURL(url).catch(() => {})
      return { action: 'deny' }
    })
    // Closing it hands the browser back to the agent; it keeps its page and logins.
    win.on('close', (e) => {
      if (this.quitting) return
      e.preventDefault()
      win.hide()
      this.fresh(agentId, win)
    })
    win.on('hide', () => {
      this.onShown(agentId, false)
      setImmediate(() => this.fresh(agentId, win))
    })
    win.on('show', () => this.onShown(agentId, true))
    this.wins.set(agentId, win)
    return win
  }

  // A window that was shown and hidden again stops painting (captures fail or
  // hang), so handing it back swaps it for a new hidden one on the same page.
  // The logins live in the session, so they stay.
  private fresh(agentId: string, old: BrowserWindow): void {
    if (this.quitting || this.wins.get(agentId) !== old) return
    const url = old.webContents.getURL()
    this.wins.delete(agentId) // from now on every action goes to the new window
    setImmediate(() => old.destroy())
    this.onShown(agentId, false)
    const wc = this.win(agentId).webContents
    const p = /^https?:/.test(url) ? wc.loadURL(url).catch(() => {}).then(() => this.settle(wc)) : Promise.resolve()
    this.reopening.set(agentId, p)
    void p.finally(() => this.reopening.get(agentId) === p && this.reopening.delete(agentId))
  }

  async run(agentId: string, op: BrowserOp, args: Record<string, unknown> = {}): Promise<Reply> {
    await this.reopening.get(agentId)
    if (op === 'close' || op === 'clear') {
      this.wins.get(agentId)?.destroy()
      this.wins.delete(agentId)
      if (op === 'clear') await session.fromPartition(this.partition(agentId)).clearData()
      return { url: '', title: '' }
    }
    const win = this.win(agentId)
    const wc = win.webContents
    const iso = <T>(code: string): Promise<T> => wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]) as Promise<T>
    const here = (): Reply => ({ url: wc.getURL(), title: wc.getTitle(), shown: win.isVisible() })

    switch (op) {
      case 'show':
        if (typeof args['title'] === 'string') win.setTitle(args['title'])
        win.show()
        win.focus()
        return here()
      case 'hide':
        win.hide()
        this.fresh(agentId, win)
        return { url: wc.getURL(), title: wc.getTitle(), shown: false }
      case 'open': {
        const url = String(args['url'] ?? '')
        if (!/^https?:\/\//.test(url)) throw new Error('Só endereços http e https.')
        await Promise.race([
          wc.loadURL(url).catch((e: Error) => {
            // A redirect or a page that changes itself aborts the first load; the page still comes.
            if (!/ERR_ABORTED/.test(e.message)) throw e
          }),
          wait(30_000)
        ])
        await this.settle(wc)
        return { ...here(), frame: await this.frame(win) }
      }
      case 'snapshot':
        return { ...(await iso<Reply>(SNAPSHOT)), shown: win.isVisible() }
      case 'click': {
        const at = typeof args['ref'] === 'number' ? await iso<{ x: number; y: number } | null>(POINT(args['ref'], false)) : { x: Number(args['x']), y: Number(args['y']) }
        if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) throw new Error('Esse elemento não está mais na página. Leia a página de novo.')
        await wait(80) // after scrolling it into view
        this.click(wc, at.x, at.y)
        await this.settle(wc)
        return { ...here(), frame: await this.frame(win) }
      }
      case 'type': {
        const ref = Number(args['ref'])
        const text = String(args['text'] ?? '')
        const at = await iso<{ x: number; y: number; select: boolean } | null>(POINT(ref, false))
        if (!at) throw new Error('Esse campo não está mais na página. Leia a página de novo.')
        if (at.select) {
          const r = await iso<true | string[]>(PICK(ref, text))
          if (r !== true) throw new Error(`Essa lista não tem "${text}". As opções são: ${r.join(', ')}.`)
        } else {
          await wait(80)
          this.click(wc, at.x, at.y)
          await wait(120)
          await iso(POINT(ref, true)) // focus, and select what's there so the text replaces it
          await wc.insertText(text)
          await wait(150) // the page reacts to the input (autocomplete, validation) before Enter
        }
        if (args['enter'] === true) this.key(wc, 'enter')
        await this.settle(wc)
        return { ...here(), frame: await this.frame(win) }
      }
      case 'key': {
        const key = String(args['key'] ?? '').toLowerCase().replace(/[^a-z]/g, '')
        if (!KEYS[key]) throw new Error(`Tecla desconhecida. Use uma destas: ${Object.keys(KEYS).join(', ')}.`)
        this.key(wc, key)
        await this.settle(wc)
        return { ...here(), frame: await this.frame(win) }
      }
      case 'scroll': {
        const [w, h] = win.getContentSize() as [number, number]
        wc.sendInputEvent({ type: 'mouseWheel', x: Math.round(w / 2), y: Math.round(h / 2), deltaX: 0, deltaY: -Number(args['dy'] ?? 600) })
        await wait(500)
        return { ...here(), frame: await this.frame(win) }
      }
      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
        await this.settle(wc)
        return { ...here(), frame: await this.frame(win) }
      case 'text':
        return { ...here(), text: wc.getURL() === '' ? '' : await iso<string>(TEXT) }
      case 'frame':
        return { ...here(), frame: await this.frame(win) }
    }
  }

  private click(wc: WebContents, x: number, y: number): void {
    const p = { x: Math.round(x), y: Math.round(y) }
    wc.sendInputEvent({ type: 'mouseMove', ...p })
    wc.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 })
  }

  private key(wc: WebContents, name: string): void {
    const k = KEYS[name]!
    wc.sendInputEvent({ type: 'keyDown', keyCode: k.code })
    if (k.char) wc.sendInputEvent({ type: 'char', keyCode: k.char })
    wc.sendInputEvent({ type: 'keyUp', keyCode: k.code })
  }

  // Lets what an action started finish: a navigation, a request, a re-render.
  private async settle(wc: WebContents): Promise<void> {
    await wait(300)
    if (wc.isLoading()) await Promise.race([new Promise<void>((r) => wc.once('did-stop-loading', () => r())), wait(15_000)])
    await wait(400)
  }

  // Never waits more than 5 s: a page that can't be painted gives no frame, not a stuck agent.
  private async frame(win: BrowserWindow): Promise<string | undefined> {
    let img = await Promise.race([win.webContents.capturePage(undefined, { stayHidden: true }).catch(() => null), wait(5000).then(() => null)])
    if (!img || img.isEmpty()) return undefined
    if (img.getSize().width > W) img = img.resize({ width: W, quality: 'good' })
    return img.toJPEG(70).toString('base64')
  }
}
