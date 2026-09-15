const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('computerOverlay', {
  act: (action, payload = {}) => ipcRenderer.invoke('desktop:computer-overlay-action', action, payload),
})
