/**
 * Configuration interface for database synchronization
 */
export interface SyncConfig {
  sourceUrl: string
  targetUrl: string
  intervalMinutes: number
  excludeTables: string[]
  maxParallelTables?: number
  sourceSSLEnabled?: boolean
  targetSSLEnabled?: boolean
}

/**
 * Progress information during synchronization
 */
export interface ProgressInfo {
  currentTable: string
  completedTables: number
  totalTables: number
  percentage: number
  status: 'starting' | 'processing' | 'completed' | 'error'
  currentAction?: string
}

/**
 * Table dependency information for ordering synchronization
 */
export interface TableDependency {
  table: string
  dependsOn: string[]
  depth: number
}
