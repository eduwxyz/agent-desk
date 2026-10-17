import { contextBridge, ipcRenderer } from 'electron'

// The page asks for a port to the core; it arrives here and is handed to the
// page through window.postMessage, the only way to pass a port across
// context isolation.
ipcRenderer.on('core:port', (event) => {
  window.postMessage('core:port', '*', event.ports)
})

contextBridge.exposeInMainWorld('agentDesk', {
  connect: (): void => ipcRenderer.send('core:connect')
})
