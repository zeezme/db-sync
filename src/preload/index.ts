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
      testConnection: (url: string, sslEnabled: boolean) => {
        return ipcRenderer.invoke('test-connection', {
          url: url,
          sslEnabled: sslEnabled
        })
      },
      runPrismaMigrations: (backendDir: string) =>
        ipcRenderer.invoke('run-prisma-migrations', backendDir),
      onSyncLog: (callback: (log: string) => void) => {
        ipcRenderer.on('sync-log', (_event, log) => callback(log))
      },
      setSourceSSL: async (enabled: boolean): Promise<{ success: boolean; error?: string }> => {
        return await ipcRenderer.invoke('set-source-ssl', enabled)
      },
      setTargetSSL: async (enabled: boolean): Promise<{ success: boolean; error?: string }> => {
        return await ipcRenderer.invoke('set-target-ssl', enabled)
      },
      getSSLStatus: async (): Promise<{
        success: boolean
        status?: { source: boolean; target: boolean }
        error?: string
      }> => {
        return await ipcRenderer.invoke('get-ssl-status')
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
