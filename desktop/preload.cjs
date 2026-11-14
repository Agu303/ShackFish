const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('shackfish', {
  analyze: request => ipcRenderer.invoke('engine:analyze', request),
  stop: () => ipcRenderer.invoke('engine:stop'),
  openPgn: () => ipcRenderer.invoke('pgn:open'),
  savePgn: pgn => ipcRenderer.invoke('pgn:save', pgn),
  history: request => ipcRenderer.invoke('history:games', request),
  scoutReview: request => ipcRenderer.invoke('scouting:review', request),
  stopScouting: () => ipcRenderer.invoke('scouting:stop'),
  selectEngine: slot => ipcRenderer.invoke('autopsy:select', slot),
  comparePosition: request => ipcRenderer.invoke('autopsy:position', request),
  stopComparison: () => ipcRenderer.invoke('autopsy:stop'),
  exportAutopsy: report => ipcRenderer.invoke('autopsy:export', report),
  onEngine: callback => ipcRenderer.on('engine:event', (_event, message) => callback(message)),
})
