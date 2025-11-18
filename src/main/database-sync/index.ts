import { Client } from 'pg'
import { SyncConfig, ProgressInfo } from './types'
import { validateConfig } from './validation'
import { createClient } from './connection'
import { getTables, getTableMetadata } from './metadata'
import { getTableDependencies } from './dependencies'
import { dumpTableData } from './dump'
import { restoreTableData } from './restore'
import { syncTableSequences } from './sequences'
import { ensureTempDir, cleanupOldFiles, createLogger } from './utils'

export class DatabaseSync {
  private config: SyncConfig
  private intervalId: NodeJS.Timeout | null = null
  private isRunning: boolean = false
  private log: (message: string) => void
  private progressInfo: ProgressInfo = {
    currentTable: '',
    completedTables: 0,
    totalTables: 0,
    percentage: 0,
    status: 'starting'
  }

  constructor(config: SyncConfig, logCallback: (log: string) => void) {
    validateConfig(config)

    this.config = {
      ...config,
      maxParallelTables: config.maxParallelTables || 8,
      sourceSSLEnabled: config.sourceSSLEnabled ?? true,
      targetSSLEnabled: config.targetSSLEnabled ?? true
    }

    this.log = createLogger(logCallback, () => this.progressInfo)
  }

  private updateProgress(
    currentTable: string,
    completedTables: number,
    totalTables: number,
    status: ProgressInfo['status'],
    currentAction?: string
  ) {
    this.progressInfo = {
      currentTable,
      completedTables,
      totalTables,
      percentage: totalTables > 0 ? Math.round((completedTables / totalTables) * 100) : 0,
      status,
      currentAction
    }
  }

  private async syncTable(
    table: string,
    tableIndex: number,
    totalTables: number
  ): Promise<boolean> {
    try {
      this.updateProgress(table, tableIndex, totalTables, 'processing', 'iniciando')
      this.log(`Iniciando sync da tabela "${table}"`)

      const metadata = await getTableMetadata(
        table,
        this.config.sourceUrl,
        this.config.sourceSSLEnabled ?? false
      )
      this.log(`Metadados "${table}": ${metadata.rowCount} linhas, PK: ${metadata.primaryKey}`)

      const dumpFile = await dumpTableData(
        table,
        this.config.sourceUrl,
        this.config.sourceSSLEnabled ?? false,
        this.log
      )

      try {
        await restoreTableData(
          table,
          dumpFile,
          this.config.targetUrl,
          this.config.targetSSLEnabled ?? false,
          this.log
        )

        await syncTableSequences(
          table,
          this.config.sourceUrl,
          this.config.targetUrl,
          this.config.sourceSSLEnabled ?? false,
          this.config.targetSSLEnabled ?? false,
          this.log
        )

        this.updateProgress(table, tableIndex + 1, totalTables, 'completed')
        this.log(`✓ Sync concluído para "${table}"`)
        return true
      } catch (error) {
        this.log(`✗ Sync falhou para "${table}": ${error}`)
        return false
      }
    } catch (error) {
      this.updateProgress(table, tableIndex + 1, totalTables, 'error')
      this.log(`✗ Erro no sync de "${table}": ${error}`)
      return false
    }
  }

  private async processTableBatch(
    tables: string[],
    startIndex: number,
    totalTables: number
  ): Promise<number> {
    if (tables.length === 0) return 0

    const promises = tables.map((table, batchIndex) =>
      this.syncTable(table, startIndex + batchIndex, totalTables)
    )

    const results = await Promise.allSettled(promises)

    const successful = results.filter(
      (result) => result.status === 'fulfilled' && result.value === true
    ).length

    const failed = results.filter(
      (result) => result.status === 'fulfilled' && result.value === false
    ).length

    const errors = results.filter((result) => result.status === 'rejected').length

    if (failed > 0 || errors > 0) {
      this.log(`Batch: ${successful} sucesso, ${failed} falhas, ${errors} erros`)
    }

    return successful
  }

  private async preSyncValidation(): Promise<void> {
    this.log('Executando validações pré-sincronização...')

    await ensureTempDir(this.log)

    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)

    const tools = ['pg_dump', 'pg_restore', 'psql']
    for (const tool of tools) {
      try {
        await execAsync(`${tool} --version`)
        this.log(`✓ ${tool} encontrado`)
      } catch {
        throw new Error(`Ferramenta ${tool} não encontrada`)
      }
    }
  }

  async syncNow(): Promise<void> {
    if (this.isRunning) {
      this.log('Sincronização já em andamento...')
      return
    }

    this.isRunning = true
    const startTime = Date.now()
    let targetClient: Client | null = null

    try {
      this.updateProgress('', 0, 0, 'starting', 'iniciando sincronização')
      this.log('=== INICIANDO SINCRONIZAÇÃO ===')

      await this.preSyncValidation()

      targetClient = await createClient(
        this.config.targetUrl,
        this.config.targetSSLEnabled ?? false
      )

      this.log('Desabilitando triggers de foreign key em todas as tabelas...')

      const tablesResult = await targetClient.query(`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
      `)

      const allTables = tablesResult.rows.map((row) => row.tablename)

      for (const table of allTables) {
        try {
          await targetClient.query(`ALTER TABLE "${table}" DISABLE TRIGGER ALL;`)
        } catch (error) {
          this.log(`Aviso: não foi possível desabilitar triggers em ${table}: ${error}`)
        }
      }

      this.log(`✓ Triggers desabilitados em ${allTables.length} tabelas`)

      try {
        this.updateProgress('', 0, 0, 'processing', 'obtendo lista de tabelas')
        const tables = await getTables(
          this.config.sourceUrl,
          this.config.targetUrl,
          this.config.sourceSSLEnabled ?? false,
          this.config.targetSSLEnabled ?? false,
          this.log
        )

        if (tables.length === 0) {
          this.log('Nenhuma tabela para sincronizar')
          return
        }

        this.updateProgress('', 0, 0, 'processing', 'analisando dependências')
        const dependencies = await getTableDependencies(
          tables,
          this.config.sourceUrl,
          this.config.sourceSSLEnabled ?? false,
          this.log
        )

        this.updateProgress('', 0, tables.length, 'processing', 'iniciando sync')
        let successCount = 0

        const maxDepth = Math.max(...dependencies.map((d) => d.depth))

        for (let depth = 0; depth <= maxDepth; depth++) {
          const tablesAtDepth = dependencies
            .filter((dep) => dep.depth === depth)
            .map((dep) => dep.table)

          if (tablesAtDepth.length === 0) continue

          this.log(`Processando nível ${depth} (${tablesAtDepth.length} tabelas)`)

          const batchSize = this.config.maxParallelTables!
          for (let i = 0; i < tablesAtDepth.length; i += batchSize) {
            const batch = tablesAtDepth.slice(i, i + batchSize)

            const excluded = this.config.excludeTables ?? []
            const batchToProcess = batch.filter((table) => !excluded.includes(table))

            const skipped = batch.filter((table) => excluded.includes(table))
            if (skipped.length > 0) {
              this.log(`Pulando inserção de dados para tabelas: ${skipped.join(', ')}`)
            }

            if (batchToProcess.length > 0) {
              const currentIndex = dependencies.findIndex((dep) => dep.table === batchToProcess[0])
              const batchSuccess = await this.processTableBatch(
                batchToProcess,
                currentIndex,
                tables.length
              )
              successCount += batchSuccess
            }

            if (i + batchSize < tablesAtDepth.length) {
              await new Promise((resolve) => setTimeout(resolve, 1000))
            }
          }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2)
        this.updateProgress('', tables.length, tables.length, 'completed')
        this.log(
          `=== SINCRONIZAÇÃO CONCLUÍDA: ${successCount}/${tables.length} tabelas em ${duration}s ===`
        )
      } finally {
        if (targetClient) {
          this.log('Reabilitando triggers de foreign key...')

          for (const table of allTables) {
            try {
              await targetClient.query(`ALTER TABLE "${table}" ENABLE TRIGGER ALL;`)
            } catch (error) {
              this.log(`Aviso: não foi possível reabilitar triggers em ${table}: ${error}`)
            }
          }

          this.log(`✓ Triggers reabilitados em ${allTables.length} tabelas`)
        }
      }
    } catch (error: any) {
      const errorMessage = error?.message.toLowerCase()

      if (
        errorMessage.includes('timeout') ||
        errorMessage.includes('getaddrinfo') ||
        errorMessage.includes('não foi possível conectar')
      ) {
        this.log(`Falha de Conexão ou Timeout: ${error.message}`)
      }

      this.updateProgress('', 0, 0, 'error')

      this.log(`=== ERRO NA SINCRONIZAÇÃO: ${error} ===`)

      throw error
    } finally {
      if (targetClient) {
        await targetClient.end().catch(() => {})
      }

      this.isRunning = false
    }
  }

  async startScheduled(): Promise<void> {
    this.log(`Iniciando sincronização agendada (${this.config.intervalMinutes} minutos)...`)

    await this.syncNow()

    this.intervalId = setInterval(
      () => {
        this.syncNow().catch((error) => {
          this.log(`Erro na sincronização agendada: ${error}`)
        })
      },
      this.config.intervalMinutes * 60 * 1000
    )

    this.log(`✓ Sincronização agendada iniciada`)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      this.log('Sincronização agendada parada')
    }
  }

  setSourceSSL(enabled: boolean): void {
    this.config.sourceSSLEnabled = enabled
    this.log(`SSL do source ${enabled ? 'ativado' : 'desativado'}`)
  }

  setTargetSSL(enabled: boolean): void {
    this.config.targetSSLEnabled = enabled
    this.log(`SSL do target ${enabled ? 'ativado' : 'desativado'}`)
  }

  getSSLStatus(): { source: boolean; target: boolean } {
    return {
      source: this.config.sourceSSLEnabled ?? true,
      target: this.config.targetSSLEnabled ?? true
    }
  }

  getCurrentProgress(): ProgressInfo {
    return { ...this.progressInfo }
  }

  async cleanupOldFiles(): Promise<void> {
    await cleanupOldFiles(this.log)
  }
}

export * from './types'
export { runPrismaMigrations } from './migrations'
