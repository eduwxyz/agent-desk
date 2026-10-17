import { app, BrowserWindow, ipcMain, MessageChannelMain, net, Notification, protocol, safeStorage, shell, utilityProcess, type UtilityProcess } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const dataDir = (): string => process.env['AGENT_DESK_DATA'] ?? app.getPath('userData')

// agentdesk://artifact/<id>/<name> serves what agents showed in the chat.
protocol.registerSchemesAsPrivileged([{ scheme: 'agentdesk', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

let core: UtilityProcess | null = null

// The core (database, engines, runs) lives in its own process so agent work
// never blocks the window or the main process.
function startCore(): UtilityProcess {
  const child = utilityProcess.fork(join(import.meta.dirname, 'core.js'), [], {
    serviceName: 'agent-desk-core',
    env: { ...process.env, AGENT_DESK_DATA: dataDir(), AGENT_DESK_PACKAGED: app.isPackaged ? '1' : '0' }
  })
  child.on('message', (msg: CoreRequest) => handleCore(child, msg))
  child.on('exit', (code) => {
    console.error(`[main] core exited with code ${code}`)
    if (core === child) core = null
  })
  return child
}

type CoreRequest =
  | { type: 'secret'; id: string; op: 'encrypt' | 'decrypt'; data: string }
  | { type: 'open'; url: string }
  | { type: 'open_path'; path: string }
  | { type: 'notify'; title: string; body: string; conversationId?: string }
  | { type: 'login_item'; open: boolean }
  | { type: 'screenshot'; id: string; url: string; width: number; height: number; fullPage: boolean }

// Things the core can't do itself: the OS keychain, the browser, notifications.
function handleCore(child: UtilityProcess, msg: CoreRequest): void {
  if (msg.type === 'secret') {
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('O cofre do sistema não está disponível.')
      const data =
        msg.op === 'encrypt' ? safeStorage.encryptString(msg.data).toString('base64') : safeStorage.decryptString(Buffer.from(msg.data, 'base64'))
      child.postMessage({ type: 'secret-result', id: msg.id, data })
    } catch (e) {
      child.postMessage({ type: 'secret-result', id: msg.id, error: e instanceof Error ? e.message : String(e) })
    }
  } else if (msg.type === 'open') {
    if (/^https?:\/\//.test(msg.url)) void shell.openExternal(msg.url)
  } else if (msg.type === 'open_path') {
    // Only folders the app keeps (an agent's computer), never an arbitrary path.
    if (normalize(msg.path).startsWith(join(dataDir(), 'computers') + sep)) void shell.openPath(msg.path)
  } else if (msg.type === 'notify') {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: msg.title, body: msg.body })
    n.on('click', () => showWindow(msg.conversationId))
    n.show()
  } else if (msg.type === 'login_item') {
    // Only the installed app: in dev this would register the bare Electron binary.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: msg.open })
  } else if (msg.type === 'screenshot') {
    screenshot(msg).then(
      (png) => child.postMessage({ type: 'screenshot-result', id: msg.id, data: png.toString('base64') }),
      (e: unknown) => child.postMessage({ type: 'screenshot-result', id: msg.id, error: e instanceof Error ? e.message : String(e) })
    )
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Loads the page in a hidden window with its own throwaway session (no cookies
// from anything else) and captures it.
async function screenshot(o: { url: string; width: number; height: number; fullPage: boolean }): Promise<Buffer> {
  if (!/^https?:\/\//.test(o.url)) throw new Error('só http e https')
  const win = new BrowserWindow({
    show: false,
    width: o.width,
    height: o.height,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'screenshots' }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    await Promise.race([win.loadURL(o.url), wait(30_000).then(() => Promise.reject(new Error('a página não carregou em 30 s')))])
    await wait(1200) // fonts, charts and client-side rendering
    if (o.fullPage) {
      const h = Number(await win.webContents.executeJavaScript('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)'))
      if (h > o.height) {
        win.setContentSize(o.width, Math.min(h, 6000))
        await wait(600)
      }
    }
    return (await win.webContents.capturePage()).toPNG()
  } finally {
    win.destroy()
  }
}

function serveArtifact(req: Request): Promise<Response> | Response {
  const u = new URL(req.url)
  const [id = '', name = ''] = u.pathname.slice(1).split('/')
  const dir = join(dataDir(), 'artifacts', id)
  const file = normalize(join(dir, decodeURIComponent(name)))
  if (u.host !== 'artifact' || !/^[0-9a-f-]{36}$/.test(id) || !file.startsWith(dir + sep)) return new Response('not found', { status: 404 })
  return net.fetch(pathToFileURL(file).toString()).then((r) => {
    const headers = new Headers(r.headers)
    // A page an agent made runs scripts, but in a sandbox with no access to the app.
    headers.set('Content-Security-Policy', 'sandbox allow-scripts allow-popups')
    return new Response(r.body, { status: r.status, headers })
  })
}

// Each page load asks for a port; one end goes to the core, the other to the page.
ipcMain.on('core:connect', (event) => {
  core ??= startCore()
  const { port1, port2 } = new MessageChannelMain()
  core.postMessage(null, [port1])
  event.sender.postMessage('core:port', null, [port2])
})

// Brings the window back (closing it keeps the app and its routines running),
// optionally opening a conversation.
function showWindow(conversationId?: string): void {
  const win = BrowserWindow.getAllWindows()[0] ?? createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (!conversationId) return
  const go = (): void => win.webContents.send('navigate', conversationId)
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go)
  else go()
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'agent-desk',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#f7f7f5',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true // the PDF viewer, for PDFs agents show
    }
  })

  win.once('ready-to-show', () => win.show())

  // Links in messages open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}

// One app per data folder: two would both run the same routines. Opening it
// again (Dock, Spotlight, at login) just brings the window back. A test run
// with its own data folder is a separate app.
if (process.env['AGENT_DESK_DATA']) app.setPath('userData', process.env['AGENT_DESK_DATA'])
const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()
app.on('second-instance', () => showWindow())

if (primary) app.whenReady().then(() => {
  protocol.handle('agentdesk', serveArtifact)
  core = startCore()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  core?.kill()
})
