import { SyncConfig } from './types'

/**
 * Validates the synchronization configuration
 * @param config - Configuration to validate
 * @throws Error if configuration is invalid
 */
export function validateConfig(config: SyncConfig): void {
  const errors: string[] = []

  const isValidPostgresUrl = (url?: string) => {
    if (typeof url !== 'string') return false

    try {
      const parsed = new URL(url)
      const validProtocol = ['postgres:', 'postgresql:'].includes(parsed.protocol)
      const hasHost = !!parsed.hostname
      const hasDatabase = !!parsed.pathname && parsed.pathname !== '/'

      return validProtocol && hasHost && hasDatabase
    } catch {
      return false
    }
  }

  if (!isValidPostgresUrl(config.sourceUrl)) {
    errors.push('sourceUrl deve ser uma URL PostgreSQL válida')
  }

  if (!isValidPostgresUrl(config.targetUrl)) {
    errors.push('targetUrl deve ser uma URL PostgreSQL válida')
  }

  if (config.intervalMinutes < 1) {
    errors.push('intervalMinutes deve ser pelo menos 1 minuto')
  }

  if (config.maxParallelTables && config.maxParallelTables < 1) {
    errors.push('maxParallelTables deve ser pelo menos 1')
  }

  if (config.maxParallelTables && config.maxParallelTables > 10) {
    errors.push('maxParallelTables não pode ser maior que 10')
  }

  if (!Array.isArray(config.excludeTables)) {
    errors.push('excludeTables deve ser um array')
  }

  if (errors.length > 0) {
    throw new Error(`Configuração inválida: ${errors.join(', ')}`)
  }
}
