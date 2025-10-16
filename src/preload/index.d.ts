import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: unknown
    dbSync: {
      saveConfig: (config: any) => Promise<any>
      loadConfig: () => Promise<any>
      startSync: (config: any) => Promise<any>
      stopSync: () => Promise<any>
      triggerSync: () => Promise<any>
      testConnection: (url: string, sslEnabled?: boolean) => Promise<any>
      runPrismaMigrations: (backendDir: string) => Promise<any>
      onSyncLog: (callback: (log: string) => void) => void
      setSourceSSL: (enabled: boolean) => Promise<{ success: boolean; error?: string }>
      setTargetSSL: (enabled: boolean) => Promise<{ success: boolean; error?: string }>
      getSSLStatus: () => Promise<{
        success: boolean
        status?: { source: boolean; target: boolean }
        error?: string
      }>
    }
    logsManager: {
      saveLogs: (log: string) => Promise<{ success: boolean }>
      getLogs: () => Promise<{ logs: string[]; isRunning: boolean }>
      clearLogs: () => Promise<{ success: boolean }>
      setSyncStatus: (status: boolean) => Promise<{ success: boolean }>
    }
    windowControls: {
      close: () => Promise<void>
    }
  }
}