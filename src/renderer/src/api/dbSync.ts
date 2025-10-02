/* eslint-disable @typescript-eslint/no-explicit-any */
export interface SyncConfig {
  sourceUrl: string
  targetUrl: string
  intervalMinutes: number
  excludeTables: string[]
}

export const dbSync: {
  saveConfig: (config: SyncConfig) => Promise<any>
  loadConfig: () => Promise<any>
  startSync: (config: SyncConfig) => Promise<any>
  stopSync: () => Promise<any>
  triggerSync: () => Promise<any>
  testConnection: (url: string) => Promise<any>
  onSyncLog: (callback: (log: string) => void) => void
} = {
  saveConfig: (config) => (window as any).dbSync.saveConfig(config),
  loadConfig: () => (window as any).dbSync.loadConfig(),
  startSync: (config) => (window as any).dbSync.startSync(config),
  stopSync: () => (window as any).dbSync.stopSync(),
  triggerSync: () => (window as any).dbSync.triggerSync(),
  testConnection: (url) => (window as any).dbSync.testConnection(url),
  onSyncLog: (callback) => (window as any).dbSync.onSyncLog(callback)
}
