import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'
import { ProgressInfo } from './types'

export function createLogger(
  logCallback: (log: string) => void,
  getProgress: () => ProgressInfo
): (message: string) => void {
  return (message: string) => {
    const timestamp = new Date().toISOString()
    const progress = getProgress()
    const progressMsg =
      progress.totalTables > 0
        ? `[${progress.percentage}% - ${progress.completedTables}/${progress.totalTables}] `
        : ''
    const logMessage = `[${timestamp}] ${progressMsg}${message}`
    logCallback(logMessage)
  }
}

export async function ensureTempDir(log: (message: string) => void): Promise<void> {
  const tempDir = path.join(tmpdir(), 'db-sync')

  try {
    await fs.mkdir(tempDir, { recursive: true })
    log(`✓ Diretório temporário: ${tempDir}`)
  } catch (error: any) {
    if (error.code === 'EEXIST') {
      log(`✓ Diretório temporário já existe: ${tempDir}`)
      return
    }
    throw new Error(`Erro ao criar diretório temporário: ${error.message}`)
  }
}

export async function cleanupOldFiles(log: (message: string) => void): Promise<void> {
  const tempDir = path.join(tmpdir(), 'db-sync')

  try {
    const files = await fs.readdir(tempDir)
    const now = Date.now()
    const maxAge = 24 * 60 * 60 * 1000

    let cleanedCount = 0
    for (const file of files) {
      const filePath = path.join(tempDir, file)
      try {
        const stats = await fs.stat(filePath)
        if (now - stats.mtimeMs > maxAge) {
          await fs.unlink(filePath)
          cleanedCount++
        }
      } catch (error) {
        log(`Erro ao limpar arquivo ${file}: ${error}`)
      }
    }

    if (cleanedCount > 0) {
      log(`Limpeza concluída: ${cleanedCount} arquivos temporários removidos`)
    }
  } catch (error) {
    log(`Erro na limpeza de arquivos temporários: ${error}`)
  }
}
