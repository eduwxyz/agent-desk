import { contextBridge, ipcRenderer } from 'electron'

// The page asks for a port to the core; it arrives here and is handed to the
// page through window.postMessage, the only way to pass a port across
// context isolation.
ipcRenderer.on('core:port', (event) => {
  window.postMessage('core:port', '*', event.ports)
})

contextBridge.exposeInMainWorld('agentDesk', {
  connect: (): void => ipcRenderer.send('core:connect'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder') as Promise<string | null>,
  // A click on a notification opens its conversation.
  onNavigate: (cb: (conversationId: string) => void): void => {
    ipcRenderer.on('navigate', (_e, id: unknown) => typeof id === 'string' && cb(id))
  }
})
