import { app, BrowserWindow, ipcMain, MessageChannelMain, Notification, safeStorage, shell, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'

let core: UtilityProcess | null = null

// The core (database, engines, runs) lives in its own process so agent work
// never blocks the window or the main process.
function startCore(): UtilityProcess {
  const child = utilityProcess.fork(join(import.meta.dirname, 'core.js'), [], {
    serviceName: 'agent-desk-core',
    env: { ...process.env, AGENT_DESK_DATA: process.env['AGENT_DESK_DATA'] ?? app.getPath('userData') }
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
  | { type: 'notify'; title: string; body: string }

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
  } else if (msg.type === 'notify') {
    if (Notification.isSupported()) new Notification({ title: msg.title, body: msg.body }).show()
  }
}

// Each page load asks for a port; one end goes to the core, the other to the page.
ipcMain.on('core:connect', (event) => {
  core ??= startCore()
  const { port1, port2 } = new MessageChannelMain()
  core.postMessage(null, [port1])
  event.sender.postMessage('core:port', null, [port2])
})

function createWindow(): void {
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
      nodeIntegration: false
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
}

app.whenReady().then(() => {
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
