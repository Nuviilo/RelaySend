const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('relayDesktop', {
  platform: process.platform,
  startFile: (payload) => ipcRenderer.invoke('relay:start-file', payload),
  appendChunk: (payload) => ipcRenderer.invoke('relay:append-chunk', payload),
  finishFile: (payload) => ipcRenderer.invoke('relay:finish-file', payload),
  abortFile: (payload) => ipcRenderer.invoke('relay:abort-file', payload),
});
