import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'
import { Client } from 'pg'

const execAsync = promisify(exec)

export interface SyncConfig {
  sourceUrl: string
  targetUrl: string
  intervalMinutes: number
  excludeTables: string[]
}

export class DatabaseSync {
  private config: SyncConfig
  private intervalId: NodeJS.Timeout | null = null
  private isRunning: boolean = false
  private logCallback: (log: string) => void
  private tempDir: string

  constructor(config: SyncConfig, logCallback: (log: string) => void) {
    this.config = config
    this.logCallback = logCallback
    this.tempDir = path.join(tmpdir(), 'db-sync')
  }

  private log(message: string) {
    const timestamp = new Date().toISOString()
    const logMessage = `[${timestamp}] ${message}`
    console.log(logMessage)
    this.logCallback(logMessage)
  }

  private getSSLConfig(url: string) {
    const isLocal = url.includes('localhost') || url.includes('127.0.0.1')
    return isLocal ? false : { rejectUnauthorized: false }
  }

  private getConnectionUrlWithSSL(url: string) {
    const isLocal = url.includes('localhost') || url.includes('127.0.0.1')
    if (isLocal) return url
    return url.includes('?') ? `${url}&sslmode=require` : `${url}?sslmode=require`
  }

  private async ensureTempDir() {
    await fs.mkdir(this.tempDir, { recursive: true }).catch((error) => {
      this.log(`Erro ao criar diretório temporário: ${(error as Error).message}`)
    })
  }

  private async getTables(): Promise<string[]> {
    this.log('Obtendo lista de tabelas...')

    const client = new Client({
      connectionString: this.config.sourceUrl,
      ssl: this.getSSLConfig(this.config.sourceUrl)
    })

    try {
      await client.connect()

      const query = `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        ${
          this.config.excludeTables.length > 0
            ? `AND table_name NOT IN (${this.config.excludeTables.map((t) => `'${t}'`).join(', ')})`
            : ''
        }
        ORDER BY table_name;
      `

      const result = await client.query(query)
      const tables = result.rows.map((row: { table_name: any }) => row.table_name)

      this.log(`Encontradas ${tables.length} tabelas`)
      return tables
    } finally {
      await client.end()
    }
  }

  private async dumpData(): Promise<string> {
    this.log('Iniciando dump dos dados...')
    const dumpFile = path.join(this.tempDir, `data-dump-${Date.now()}.sql`)

    const excludeTablesArgs = this.config.excludeTables
      .map((table) => `--exclude-table=${table}`)
      .join(' ')

    const connectionUrl = this.getConnectionUrlWithSSL(this.config.sourceUrl)

    const dumpCommand = `pg_dump "${connectionUrl}" \
      --data-only \
      --no-owner \
      --no-privileges \
      --column-inserts \
      ${excludeTablesArgs} \
      --file="${dumpFile}"`

    await execAsync(dumpCommand)
    this.log(`Dump concluído: ${dumpFile}`)
    return dumpFile
  }

  private async clearTargetData(tables: string[]) {
    this.log('Limpando dados do banco de destino...')

    const client = new Client({
      connectionString: this.config.targetUrl,
      ssl: this.getSSLConfig(this.config.targetUrl)
    })

    try {
      await client.connect()

      for (const table of tables) {
        try {
          await client.query(`TRUNCATE TABLE ${table} CASCADE;`)
          this.log(`Tabela ${table} truncada`)
        } catch (error: any) {
          this.log(`Aviso: Não foi possível truncar ${table}: ${error.message}`)
        }
      }
    } finally {
      await client.end()
    }
  }

  private async restoreData(dumpFile: string) {
    this.log('Restaurando dados no banco de destino...')

    const connectionUrl = this.getConnectionUrlWithSSL(this.config.targetUrl)

    const restoreCommand = `psql "${connectionUrl}" \
      -v ON_ERROR_STOP=0 \
      --single-transaction \
      -f "${dumpFile}"`

    try {
      await execAsync(restoreCommand)
      this.log('Dados restaurados com sucesso')
    } catch (error: any) {
      this.log(`Restore concluído com avisos: ${error.message}`)
    }
  }

  private async cleanup(dumpFile: string) {
    await fs.unlink(dumpFile).catch((error) => {
      this.log(`Aviso: Não foi possível remover arquivo temporário: ${(error as Error).message}`)
    })
  }

  async syncNow() {
    if (this.isRunning) {
      this.log('Sincronização já em andamento...')
      return
    }

    this.isRunning = true
    const startTime = Date.now()
    this.log('=== INICIANDO SINCRONIZAÇÃO ===')

    try {
      await this.ensureTempDir()
      const tables = await this.getTables()
      const dumpFile = await this.dumpData()
      await this.clearTargetData(tables)
      await this.restoreData(dumpFile)
      await this.cleanup(dumpFile)

      const duration = ((Date.now() - startTime) / 1000).toFixed(2)
      this.log(`=== SINCRONIZAÇÃO CONCLUÍDA EM ${duration}s ===`)
    } catch (error: any) {
      this.log(`=== ERRO NA SINCRONIZAÇÃO: ${error.message} ===`)
      throw error
    } finally {
      this.isRunning = false
    }
  }

  async startScheduled() {
    this.log(`Iniciando sincronização agendada (${this.config.intervalMinutes} minutos)...`)

    await this.syncNow()

    this.intervalId = setInterval(
      () => this.syncNow().catch((err) => this.log(`Erro: ${err.message}`)),
      this.config.intervalMinutes * 60 * 1000
    )
  }

  async isTargetEmpty(connectionString: string): Promise<boolean> {
    const client = new Client({
      connectionString,
      ssl: this.getSSLConfig(connectionString)
    })
    try {
      await client.connect()
      const res = await client.query(`
        SELECT COUNT(*) as count
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type='BASE TABLE';
      `)
      return parseInt(res.rows[0].count) === 0
    } finally {
      await client.end()
    }
  }

  static async runPrismaMigrations(
    backendDir: string,
    targetUrl: string,
    logCallback: (log: string) => void
  ) {
    const tempDir = path.join(tmpdir(), 'db-sync')
    const tempMigrationDir = path.join(tempDir, 'prisma-migration')

    const log = (message: string) => {
      const timestamp = new Date().toISOString()
      const logMessage = `[${timestamp}] ${message}`
      console.log(logMessage)
      logCallback(logMessage)
    }

    try {
      log('Preparando ambiente para migrations...')
      await fs.mkdir(tempMigrationDir, { recursive: true })

      const sourcePrismaDir = path.join(backendDir, 'prisma', 'schema')
      const targetPrismaDir = path.join(tempMigrationDir, 'prisma')

      await fs.mkdir(targetPrismaDir, { recursive: true })

      log('Copiando schemas...')
      const schemaFiles = await fs.readdir(sourcePrismaDir)
      for (const file of schemaFiles) {
        if (file.endsWith('.prisma')) {
          await fs.copyFile(path.join(sourcePrismaDir, file), path.join(targetPrismaDir, file))
          log(`  ✓ ${file}`)
        }
      }

      log('Copiando migrations...')
      const migrationsSource = path.join(sourcePrismaDir, 'migrations')
      const migrationsTarget = path.join(targetPrismaDir, 'migrations')
      await fs.cp(migrationsSource, migrationsTarget, { recursive: true })
      log('  ✓ Migrations copiadas')

      log('Executando prisma migrate deploy...')
      const { stdout, stderr } = await execAsync('npx prisma migrate deploy', {
        cwd: tempMigrationDir,
        env: {
          ...process.env,
          DATABASE_URL: targetUrl,
          DATABASE_DIRECT_URL: targetUrl
        }
      })

      if (stdout) log(stdout)
      if (stderr) log(`Avisos: ${stderr}`)

      log('✓ Migrations aplicadas com sucesso no banco alvo!')

      await fs.rm(tempMigrationDir, { recursive: true, force: true })
      log('Ambiente temporário limpo')
    } catch (error: any) {
      log(`✗ Erro ao aplicar migrations: ${error.message}`)
      if (error.stdout) log(`Output: ${error.stdout}`)
      if (error.stderr) log(`Error: ${error.stderr}`)
      throw error
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      this.log('Sincronização agendada parada')
    }
  }
}
