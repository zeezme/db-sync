import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('dbSync', {
      saveConfig: (config: any) => ipcRenderer.invoke('save-config', config),
      loadConfig: () => ipcRenderer.invoke('load-config'),
      startSync: (config: any) => ipcRenderer.invoke('start-sync', config),
      stopSync: () => ipcRenderer.invoke('stop-sync'),
      triggerSync: () => ipcRenderer.invoke('trigger-sync'),
      testConnection: (url: string) => ipcRenderer.invoke('test-connection', url),
      runPrismaMigrations: (backendDir: string) =>
        ipcRenderer.invoke('run-prisma-migrations', backendDir),
      onSyncLog: (callback: (log: string) => void) => {
        ipcRenderer.on('sync-log', (_event, log) => callback(log))
      }
    })
    contextBridge.exposeInMainWorld('logsManager', {
      saveLogs: (log: string) => ipcRenderer.invoke('save-log', log),
      getLogs: () => ipcRenderer.invoke('get-logs'),
      clearLogs: () => ipcRenderer.invoke('clear-logs'),
      setSyncStatus: (status: boolean) => ipcRenderer.invoke('set-sync-status', status)
    })
    contextBridge.exposeInMainWorld('windowControls', {
      close: () => ipcRenderer.invoke('close-window')
    })
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
