import { exec, spawn, ChildProcess } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'
import { Client, ClientConfig } from 'pg'

const execAsync = promisify(exec)

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
interface ProgressInfo {
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
interface TableDependency {
  table: string
  dependsOn: string[]
  depth: number
}

/**
 * Main class for handling database synchronization between PostgreSQL databases
 */
export class DatabaseSync {
  private config: SyncConfig
  private intervalId: NodeJS.Timeout | null = null
  private isRunning: boolean = false
  private logCallback: (log: string) => void
  private tempDir: string
  private progressInfo: ProgressInfo = {
    currentTable: '',
    completedTables: 0,
    totalTables: 0,
    percentage: 0,
    status: 'starting'
  }
  private tempDirInitialized: boolean = false

  /**
   * Creates a new DatabaseSync instance
   * @param config - Synchronization configuration
   * @param logCallback - Callback function for logging messages
   */
  constructor(config: SyncConfig, logCallback: (log: string) => void) {
    this.validateConfig(config)

    this.config = {
      ...config,
      maxParallelTables: config.maxParallelTables || 3,
      sourceSSLEnabled: config.sourceSSLEnabled ?? true,
      targetSSLEnabled: config.targetSSLEnabled ?? true
    }

    this.logCallback = logCallback

    this.tempDir = path.join(tmpdir(), 'db-sync')
  }

  /**
   * Validates the synchronization configuration
   * @param config - Configuration to validate
   * @throws Error if configuration is invalid
   */
  private validateConfig(config: SyncConfig): void {
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

  /**
   * Updates the current progress information
   */
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

  /**
   * Logs a message with timestamp and progress information
   */
  private log(message: string) {
    const timestamp = new Date().toISOString()
    const progressMsg =
      this.progressInfo.totalTables > 0
        ? `[${this.progressInfo.percentage}% - ${this.progressInfo.completedTables}/${this.progressInfo.totalTables}] `
        : ''
    const logMessage = `[${timestamp}] ${progressMsg}${message}`

    this.logCallback(logMessage)
  }

  /**
   * Parses database connection parameters from URL
   */
  private getConnectionParams(url: string): ClientConfig {
    try {
      const urlObj = new URL(url)

      const isSourceUrl = url === this.config.sourceUrl
      const sslEnabled = isSourceUrl ? this.config.sourceSSLEnabled : this.config.targetSSLEnabled

      const isLocalhost =
        urlObj.hostname.includes('localhost') || urlObj.hostname.includes('127.0.0.1')

      return {
        user: decodeURIComponent(urlObj.username),
        password: decodeURIComponent(urlObj.password),
        host: urlObj.hostname,
        port: parseInt(urlObj.port) || 5432,
        database: urlObj.pathname.replace('/', ''),
        ssl: isLocalhost || !sslEnabled ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 30000
      }
    } catch (error) {
      throw new Error(`Erro ao analisar URL do banco de dados (${url}): ${error}`)
    }
  }

  /**
   * Creates a PostgreSQL client connection
   */
  private async createClient(url: string) {
    const params = this.getConnectionParams(url)

    if (!params.host || !params.database || !params.user) {
      throw new Error('Parâmetros de conexão incompletos')
    }

    const client = new Client(params)

    const connectionTimeout = setTimeout(() => {
      client.end().catch(() => {})
      throw new Error('Timeout na conexão com o banco de dados (30s)')
    }, 30000)

    try {
      await client.connect()
      clearTimeout(connectionTimeout)
      await client.query('SELECT 1 as connectivity_test')
      return client
    } catch (error) {
      clearTimeout(connectionTimeout)
      await client.end().catch(() => {})
      throw new Error(`Falha na conexão com ${url}: ${error}`)
    }
  }

  /**
   * Validates database connection
   */
  private async validateDatabaseConnection(url: string): Promise<boolean> {
    try {
      const client = await this.createClient(url)
      const result = await client.query('SELECT current_database() as db_name')

      const parsed = new URL(url)
      if (parsed.password) parsed.password = '****'

      this.log(`✓ Conexão válida com ${parsed.host}/${result.rows[0].db_name}`)

      await client.end()

      return true
    } catch (error: any) {
      const host = (() => {
        try {
          return new URL(url).host
        } catch {
          return url
        }
      })()
      this.log(`✗ Falha na conexão com ${host}: ${error.message || error}`)
      return false
    }
  }

  /**
   * Checks if a table exists in the database
   */
  private async tableExists(client: Client, table: string): Promise<boolean> {
    try {
      if (!table || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
        return false
      }

      const result = await client.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1)`,
        [table]
      )
      return result.rows[0].exists
    } catch (error) {
      this.log(`Erro ao verificar existência da tabela ${table}: ${error}`)
      return false
    }
  }

  /**
   * Gets list of tables to synchronize
   */
  private async getTables(): Promise<string[]> {
    this.log('Obtendo lista de tabelas...')

    const sourceValid = await this.validateDatabaseConnection(this.config.sourceUrl)
    if (!sourceValid) {
      throw new Error('Não foi possível conectar ao banco de dados source')
    }

    const targetValid = await this.validateDatabaseConnection(this.config.targetUrl)
    if (!targetValid) {
      throw new Error('Não foi possível conectar ao banco de dados target')
    }

    const client = await this.createClient(this.config.sourceUrl)

    try {
      const query = `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        ORDER BY table_name;
      `
      const result = await client.query(query)

      const tables = result.rows
        .map((row) => row.table_name)
        .filter(
          (table) => table && table.trim().length > 0 && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)
        )

      this.log(`Encontradas ${tables.length} tabelas no source`)

      if (tables.length === 0) {
        return []
      }

      const targetClient = await this.createClient(this.config.targetUrl)
      const tablesToSync: string[] = []

      for (const table of tables) {
        try {
          const existsInTarget = await this.tableExists(targetClient, table)
          if (existsInTarget) {
            tablesToSync.push(table)
          } else {
            this.log(`Aviso: Tabela ${table} não existe no destino. Pulando.`)
          }
        } catch (error) {
          this.log(`Erro ao verificar tabela ${table} no destino: ${error}`)
        }
      }

      await targetClient.end()

      if (tablesToSync.length === 0) {
        throw new Error('Nenhuma tabela válida encontrada para sincronização')
      }

      this.log(`Tabelas válidas para sync: ${tablesToSync.length}`)
      return tablesToSync
    } finally {
      await client.end()
    }
  }

  /**
   * Analyzes table dependencies for proper synchronization order
   */
  private async getTableDependencies(tables: string[]): Promise<TableDependency[]> {
    if (tables.length === 0) return []

    const client = await this.createClient(this.config.sourceUrl)

    try {
      this.log(`Analisando dependências para ${tables.length} tabelas...`)

      const result = await client.query(
        `
      SELECT
        tc.table_name as source_table,
        ccu.table_name as target_table,
        kcu.column_name as source_column,
        ccu.column_name as target_column
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name IN (${tables.map((_, i) => `$${i + 1}`).join(', ')})
      ORDER BY tc.table_name, ccu.table_name
    `,
        tables
      )

      this.log(`Encontradas ${result.rows.length} dependências de FK`)

      if (result.rows.length > 0) {
        this.log('\n=== FKs DETECTADAS ===')
        result.rows.forEach((row) => {
          this.log(
            `  ${row.source_table}.${row.source_column} → ${row.target_table}.${row.target_column}`
          )
        })
        this.log('======================\n')
      }

      const dependencyMap = new Map<string, string[]>()

      tables.forEach((table) => {
        dependencyMap.set(table, [])
      })

      for (const row of result.rows) {
        if (row.source_table !== row.target_table && tables.includes(row.target_table)) {
          const currentDeps = dependencyMap.get(row.source_table) || []
          if (!currentDeps.includes(row.target_table)) {
            currentDeps.push(row.target_table)
            dependencyMap.set(row.source_table, currentDeps)
          }
        }
      }

      const dependencies: TableDependency[] = []
      dependencyMap.forEach((dependsOn, table) => {
        dependencies.push({ table, dependsOn, depth: 0 })
      })

      this.calculateDependencyDepth(dependencies)

      const sorted = dependencies.sort((a, b) => {
        if (a.depth !== b.depth) return a.depth - b.depth
        return a.table.localeCompare(b.table)
      })

      this.log('=== ORDEM DE SINCRONIZAÇÃO ===')
      sorted.forEach((dep, index) => {
        const depsStr = dep.dependsOn.length > 0 ? ` (depende de: ${dep.dependsOn.join(', ')})` : ''
        this.log(`  ${index + 1}. ${dep.table} [nível ${dep.depth}]${depsStr}`)
      })
      this.log('=============================\n')

      return sorted
    } catch (error) {
      this.log(`ERRO na análise de dependências: ${error}. Usando ordenação alfabética.`)
      return tables
        .map((table) => ({ table, dependsOn: [], depth: 0 }))
        .sort((a, b) => a.table.localeCompare(b.table))
    } finally {
      await client.end()
    }
  }

  /**
   * Calculates dependency depth for topological sorting
   */
  private calculateDependencyDepth(dependencies: TableDependency[]): void {
    let changed = true
    let iterations = 0
    const maxIterations = dependencies.length * 2

    while (changed && iterations < maxIterations) {
      changed = false
      iterations++

      for (const dep of dependencies) {
        const maxParentDepth =
          dep.dependsOn.length > 0
            ? Math.max(
                ...dep.dependsOn.map((parent) => {
                  const parentDep = dependencies.find((d) => d.table === parent)
                  return parentDep ? parentDep.depth : -1
                })
              )
            : -1

        const newDepth = maxParentDepth + 1
        if (newDepth > dep.depth) {
          dep.depth = newDepth
          changed = true
        }
      }
    }

    if (iterations >= maxIterations) {
      this.log('AVISO: Cálculo de profundidade atingiu limite máximo de iterações')
    }
  }

  /**
   * Ensures temporary directory exists
   */
  private async ensureTempDir(): Promise<void> {
    if (this.tempDirInitialized) {
      return
    }

    try {
      await fs.mkdir(this.tempDir, { recursive: true })
      this.tempDirInitialized = true
      this.log(`✓ Diretório temporário: ${this.tempDir}`)
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        this.tempDirInitialized = true
        this.log(`✓ Diretório temporário já existe: ${this.tempDir}`)
        return
      }
      throw new Error(`Erro ao criar diretório temporário: ${error.message}`)
    }
  }

  /**
   * Gets table metadata including primary key and row count
   */
  private async getTableMetadata(table: string): Promise<{
    hasUpdatedAt: boolean
    primaryKey: string
    rowCount: number
  }> {
    if (!table || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new Error(`Nome de tabela inválido: ${table}`)
    }

    const client = await this.createClient(this.config.sourceUrl)

    try {
      const updatedAtResult = await client.query(
        `
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'updated_at'
        ) as has_updated_at
      `,
        [table]
      )

      const pkResult = await client.query(
        `
        SELECT a.attname as column_name
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary
        LIMIT 1
      `,
        [`"${table}"`]
      )

      const countResult = await client.query(`SELECT COUNT(*) as count FROM "${table}"`)

      const metadata = {
        hasUpdatedAt: updatedAtResult.rows[0].has_updated_at,
        primaryKey: pkResult.rows[0]?.column_name || 'id',
        rowCount: parseInt(countResult.rows[0].count)
      }

      if (!metadata.primaryKey) {
        this.log(`AVISO: Tabela ${table} não possui chave primária definida.`)
      }

      if (metadata.rowCount > 1000000) {
        this.log(
          `AVISO: Tabela ${table} possui muitos registros (${metadata.rowCount.toLocaleString()}).`
        )
      }

      return metadata
    } finally {
      await client.end()
    }
  }

  /**
   * Gets common columns between source and target tables
   */
  private async getCommonColumns(table: string): Promise<string[]> {
    const sourceClient = await this.createClient(this.config.sourceUrl)
    const targetClient = await this.createClient(this.config.targetUrl)

    try {
      const sourceRes = await sourceClient.query(
        `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
        [table]
      )

      const targetRes = await targetClient.query(
        `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
        [table]
      )

      const sourceCols = sourceRes.rows.map((r) => r.column_name)
      const targetCols = new Set(targetRes.rows.map((r) => r.column_name))

      const common = sourceCols.filter((col) => targetCols.has(col))
      const onlyInSource = sourceCols.filter((col) => !targetCols.has(col))
      const onlyInTarget = targetRes.rows
        .map((r) => r.column_name)
        .filter((col) => !sourceCols.includes(col))

      if (onlyInSource.length > 0) {
        this.log(`⚠️  Colunas apenas no SOURCE (serão ignoradas): ${onlyInSource.join(', ')}`)
      }
      if (onlyInTarget.length > 0) {
        this.log(`⚠️  Colunas apenas no TARGET (não serão preenchidas): ${onlyInTarget.join(', ')}`)
      }

      this.log(
        `Colunas comuns para "${table}": ${common.join(', ')} (source: ${sourceCols.length}, target: ${targetRes.rows.length}, comuns: ${common.length})`
      )

      if (common.length === 0) {
        this.log(`AVISO: Nenhuma coluna comum encontrada para "${table}", pulando sync`)
        return []
      }

      return common
    } finally {
      await sourceClient.end()
      await targetClient.end()
    }
  }

  /**
   * Dumps table data to a temporary file
   */
  private async dumpTableData(table: string): Promise<string> {
    await this.ensureTempDir()
    const dumpFile = path.join(this.tempDir, `${table}_${Date.now()}.dump`)

    const sourceParams = this.getConnectionParams(this.config.sourceUrl)

    try {
      await execAsync('pg_dump --version')
    } catch {
      throw new Error('pg_dump não encontrado. Certifique-se de que o PostgreSQL está instalado.')
    }

    const args = [
      `--host=${sourceParams.host}`,
      `--port=${sourceParams.port}`,
      `--username=${sourceParams.user}`,
      `--dbname=${sourceParams.database}`,
      '--no-password',
      '--format=custom',
      '--data-only',
      '--no-owner',
      '--no-privileges',
      `--table="${table}"`,
      `--file=${dumpFile}`,
      '--no-sync'
    ]

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PGPASSWORD: String(sourceParams.password) || '',
      PGSSLMODE: sourceParams.ssl ? 'require' : 'prefer'
    }

    this.log(`Executando pg_dump para "${table}"...`)

    return new Promise((resolve, reject) => {
      const dumpProcess: ChildProcess = spawn('pg_dump', args, { env })

      const timeout = setTimeout(() => {
        dumpProcess.kill('SIGTERM')
        reject(new Error(`Timeout no pg_dump para ${table} (5 minutos)`))
      }, 300000)

      let stderr = ''

      dumpProcess.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      dumpProcess.on('close', (code) => {
        clearTimeout(timeout)

        if (code === 0) {
          fs.stat(dumpFile).then((stats) => {
            if (stats.size > 100) {
              this.log(`Dump concluído para "${table}": ${stats.size} bytes`)
              resolve(dumpFile)
            } else {
              fs.unlink(dumpFile).catch(() => {})
              reject(new Error(`Dump vazio para "${table}"`))
            }
          })
        } else {
          fs.unlink(dumpFile).catch(() => {})
          reject(new Error(`pg_dump falhou para "${table}" (código ${code}): ${stderr}`))
        }
      })

      dumpProcess.on('error', (error) => {
        clearTimeout(timeout)
        reject(new Error(`Erro ao executar pg_dump para "${table}": ${error}`))
      })
    })
  }

  /**
   * Restores table data from dump file using multiple strategies
   */
  private async restoreTableData(
    table: string,
    dumpFile: string,
    primaryKey: string
  ): Promise<void> {
    const targetParams = this.getConnectionParams(this.config.targetUrl)

    if (table === 'pessoa') {
      this.log(`🔍 [DEBUG] Processando tabela pessoa - PK: ${primaryKey}`)
      const commonCols = await this.getCommonColumns('pessoa')
      this.log(`🔍 [DEBUG] Colunas comuns de pessoa: ${commonCols.join(', ')}`)
    }

    const sqlFile = dumpFile.replace('.dump', '.sql')

    try {
      this.log(`Convertendo dump para SQL para "${table}"...`)
      await this.executeCommand(
        'pg_restore',
        ['--data-only', '--file=' + sqlFile, dumpFile],
        { ...process.env },
        300000
      )

      this.log(`Removendo transaction_timeout do dump...`)
      let sqlContent = await fs.readFile(sqlFile, 'utf8')
      sqlContent = sqlContent.replace(/SET transaction_timeout = 0;\s*/g, '')
      await fs.writeFile(sqlFile, sqlContent, 'utf8')
      this.log(`✓ SQL limpo salvo em ${sqlFile}`)

      this.log(`Restaurando dados para "${table}" com psql...`)

      const psqlArgs = [
        `--host=${targetParams.host}`,
        `--port=${targetParams.port}`,
        `--username=${targetParams.user}`,
        `--dbname=${targetParams.database}`,
        '--no-password',
        '--single-transaction',
        '--file=' + sqlFile
      ]

      const psqlEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PGPASSWORD: String(targetParams.password) || '',
        PGSSLMODE: targetParams.ssl ? 'require' : 'prefer'
      }

      const { stdout, stderr } = await this.executeCommand('psql', psqlArgs, psqlEnv, 300000)
      if (stdout) this.log(`[psql:stdout] ${stdout}`)
      if (stderr) this.log(`[psql:stderr] ${stderr}`)

      if (stderr && (stderr.includes('ERROR:') || stderr.includes('duplicate key'))) {
        throw new Error(`Restore falhou com erros na transação`)
      }

      this.log(`✓ Restore concluído para "${table}"`)

      await fs.unlink(sqlFile).catch(() => {})
    } catch (error: any) {
      this.log(`Restore direto falhou para "${table}": ${error.message}`)
      await fs.unlink(sqlFile).catch(() => {})

      try {
        await this.restoreWithUpsert(table, dumpFile, primaryKey)
        this.log(`✓ UPSERT concluído para "${table}"`)
        return
      } catch (upsertError: any) {
        this.log(`UPSERT falhou para "${table}": ${upsertError.message}`)
        throw new Error(`Todos os métodos de restauração falharam para "${table}"`)
      }
    }
  }

  /**
   * Executes a shell command with timeout
   */
  private async executeCommand(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    timeout: number
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { env })
      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      proc.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`${command} falhou com código ${code}: ${stderr}`))
        } else {
          resolve({ stdout, stderr })
        }
      })

      setTimeout(() => {
        proc.kill()
        reject(new Error(`${command} timed out após ${timeout}ms`))
      }, timeout)
    })
  }

  /**
   * Restores data using UPSERT strategy
   */
  private async restoreWithUpsert(
    table: string,
    dumpFile: string,
    primaryKey: string
  ): Promise<void> {
    const tempTable = `temp_${table}_${Date.now()}`
    const sqlFile = dumpFile.replace('.dump', '.sql')

    const client = await this.createClient(this.config.targetUrl)

    try {
      this.log(`Convertendo dump para SQL...`)
      await this.executeCommand(
        'pg_restore',
        ['--data-only', '--file=' + sqlFile, dumpFile],
        { ...process.env },
        300000
      )
      this.log(`✓ Conversão para SQL concluída`)

      const commonColumns = await this.getCommonColumns(table)
      if (commonColumns.length === 0) {
        this.log(`✗ Pulando "${table}" - nenhuma coluna comum com o target`)
        return
      }
      if (!commonColumns.includes(primaryKey)) {
        this.log(`✗ Pulando "${table}" - chave primária "${primaryKey}" não existe no target`)
        return
      }

      const commonColumnsList = commonColumns.map((col) => `"${col}"`).join(', ')
      await client.query(`
      DROP TABLE IF EXISTS "${tempTable}" CASCADE;
      CREATE TEMPORARY TABLE "${tempTable}" AS
      SELECT ${commonColumnsList} FROM "${table}" WHERE false;
    `)
      this.log(`✓ Tabela temporária "${tempTable}" criada com ${commonColumns.length} colunas`)

      this.log(`Processando arquivo SQL...`)
      const sqlContent = await fs.readFile(sqlFile, 'utf8')

      const copyBlocks = sqlContent.split('COPY ')
      if (copyBlocks.length < 2) {
        this.log(`✗ Não encontrou comando COPY`)
        return
      }

      const copyBlock = 'COPY ' + copyBlocks[1].split('\n\\.')[0] + '\n\\.'

      const firstLineEnd = copyBlock.indexOf('\n')
      if (firstLineEnd === -1) {
        this.log(`✗ Formato COPY inválido`)
        return
      }

      const headerLine = copyBlock.substring(0, firstLineEnd)

      const columnsMatch = headerLine.match(/\(([^)]+)\)/)
      if (!columnsMatch) {
        this.log(`✗ Não conseguiu extrair colunas`)
        return
      }

      const copyColumnNames = columnsMatch[1].split(',').map((col) => col.trim().replace(/"/g, ''))

      this.log(`📋 ${copyColumnNames.length} colunas no COPY`)

      const columnsWithNulls = commonColumns.filter((col) => !copyColumnNames.includes(col))
      if (columnsWithNulls.length > 0) {
        this.log(
          `⚠️  Colunas que receberão NULL (não estão no dump): ${columnsWithNulls.join(', ')}`
        )
      }

      const columnMapping: number[] = []
      commonColumns.forEach((commonCol) => {
        const positionInCopy = copyColumnNames.indexOf(commonCol)
        columnMapping.push(positionInCopy)
      })

      const dataStart = copyBlock.indexOf('\n') + 1
      const dataEnd = copyBlock.lastIndexOf('\n\\.')
      if (dataStart >= dataEnd) {
        this.log(`✗ Não encontrou dados`)
        return
      }

      const dataContent = copyBlock.substring(dataStart, dataEnd)
      const dataLines = dataContent
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('\\'))
        .map((line) => line.split('\t'))

      this.log(`📊 ${dataLines.length} registros encontrados`)

      if (dataLines.length === 0) {
        this.log(`✗ Nenhum dado`)
        return
      }

      this.log(`Inserindo dados...`)
      let successfulInserts = 0

      const batchSize = 1000

      for (let i = 0; i < dataLines.length; i += batchSize) {
        const batch = dataLines.slice(i, i + batchSize)

        const batchPromises = batch.map(async (lineValues) => {
          try {
            const mappedValues = columnMapping.map((copyIndex) => {
              if (copyIndex === -1 || copyIndex >= lineValues.length) return null
              const value = lineValues[copyIndex]
              return value === '\\N' ? null : value
            })

            const placeholders = commonColumns.map((_, idx) => `$${idx + 1}`).join(', ')
            const insertSQL = `INSERT INTO "${tempTable}" (${commonColumnsList}) VALUES (${placeholders})`

            await client.query(insertSQL, mappedValues)
            return true
          } catch {
            return false
          }
        })

        const batchResults = await Promise.all(batchPromises)
        successfulInserts += batchResults.filter(Boolean).length

        if (i > 0 && i % 5000 === 0) {
          this.log(`📦 ${i}/${dataLines.length} registros`)
        }
      }

      this.log(`✅ ${successfulInserts}/${dataLines.length} registros carregados`)

      if (successfulInserts === 0) {
        this.log(`❌ Nenhum registro inserido`)
        return
      }

      this.log(`Executando UPSERT...`)
      const upsertSQL = `
      INSERT INTO "${table}" (${commonColumnsList})
      SELECT ${commonColumnsList} FROM "${tempTable}"
      ON CONFLICT ("${primaryKey}") DO UPDATE SET
        ${commonColumns
          .filter((c) => c !== primaryKey)
          .map((c) => `"${c}" = EXCLUDED."${c}"`)
          .join(', ')};
    `

      const result = await client.query(upsertSQL)
      this.log(`🎉 ${result.rowCount} linhas sincronizadas`)
    } catch (error: any) {
      this.log(`💥 Falha: ${error.message}`)
      throw error
    } finally {
      try {
        await client.query(`DROP TABLE IF EXISTS "${tempTable}"`).catch(() => {})
      } catch {
        //
      }
      await client.end().catch(() => {})
      await fs.unlink(sqlFile).catch(() => {})
    }
  }

  /**
   * Synchronizes sequences for a table
   */
  private async syncTableSequences(table: string): Promise<void> {
    const sourceClient = await this.createClient(this.config.sourceUrl)
    const targetClient = await this.createClient(this.config.targetUrl)

    try {
      const formattedTable = `"${table}"`

      const sequencesQuery = `
      SELECT DISTINCT
        CASE 
          WHEN pg_get_serial_sequence($1, column_name) IS NOT NULL 
          THEN pg_get_serial_sequence($1, column_name)
          ELSE SUBSTRING(column_default FROM 'nextval\\(''([^'']+)')
        END as sequence_name,
        column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' 
        AND table_name = $1
        AND (
          pg_get_serial_sequence($1, column_name) IS NOT NULL
          OR column_default LIKE '%nextval%'
        )
    `

      const sequencesResult = await sourceClient.query(sequencesQuery, [table])

      if (sequencesResult.rows.length === 0) {
        return
      }

      for (const row of sequencesResult.rows) {
        if (!row.sequence_name || !row.column_name) continue

        const sequenceName = row.sequence_name.replace('public.', '')
        const columnName = row.column_name

        try {
          const formattedSequence = `"${sequenceName}"`

          const sourceSeqValue = await sourceClient.query(
            `SELECT last_value, is_called FROM ${formattedSequence}`
          )
          const lastValue = sourceSeqValue.rows[0]?.last_value
          const isCalled = sourceSeqValue.rows[0]?.is_called

          const maxValueResult = await targetClient.query(
            `SELECT COALESCE(MAX("${columnName}"), 0) as max_value FROM ${formattedTable}`
          )

          const maxValue = parseInt(maxValueResult.rows[0]?.max_value) || 0

          if (lastValue) {
            const safeValue = Math.max(parseInt(lastValue), maxValue)

            await targetClient.query(`SELECT setval($1, $2, $3)`, [
              formattedSequence,
              safeValue,
              isCalled
            ])

            this.log(`  ↻ Sequência ${formattedSequence} atualizada para ${safeValue}`)
          }
        } catch (seqError: any) {
          this.log(
            `  ⚠️  Erro ao sincronizar sequência "${sequenceName}" para tabela "${table}": ${seqError.message}`
          )
        }
      }
    } catch (error: any) {
      this.log(`Erro ao sincronizar sequências de "${table}": ${error.message}`)
    } finally {
      await sourceClient.end()
      await targetClient.end()
    }
  }

  /**
   * Synchronizes a single table
   */
  private async syncTable(
    table: string,
    tableIndex: number,
    totalTables: number
  ): Promise<boolean> {
    try {
      this.updateProgress(table, tableIndex, totalTables, 'processing', 'iniciando')
      this.log(`Iniciando sync da tabela "${table}"`)

      const metadata = await this.getTableMetadata(table)
      this.log(`Metadados "${table}": ${metadata.rowCount} linhas, PK: ${metadata.primaryKey}`)

      const dumpFile = await this.dumpTableData(table)

      try {
        await this.restoreTableData(table, dumpFile, metadata.primaryKey)

        // Sincroniza as sequências após restaurar os dados
        await this.syncTableSequences(table)

        await fs.unlink(dumpFile).catch(() => {})

        this.updateProgress(table, tableIndex + 1, totalTables, 'completed')
        this.log(`✓ Sync concluído para "${table}"`)
        return true
      } catch (error) {
        this.log(`✗ Sync falhou para "${table}": ${error}`)
        await fs.unlink(dumpFile).catch(() => {})
        return false
      }
    } catch (error) {
      this.updateProgress(table, tableIndex + 1, totalTables, 'error')
      this.log(`✗ Erro no sync de "${table}": ${error}`)
      return false
    }
  }

  /**
   * Processes a batch of tables in parallel
   */
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

  /**
   * Executes immediate synchronization
   */
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

      targetClient = await this.createClient(this.config.targetUrl)

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
        const tables = await this.getTables()

        if (tables.length === 0) {
          this.log('Nenhuma tabela para sincronizar')
          return
        }

        this.updateProgress('', 0, 0, 'processing', 'analisando dependências')
        const dependencies = await this.getTableDependencies(tables)

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
    } catch (error) {
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

  /**
   * Performs pre-synchronization validation
   */
  private async preSyncValidation(): Promise<void> {
    this.log('Executando validações pré-sincronização...')

    await this.ensureTempDir()

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

  /**
   * Starts scheduled synchronization
   */
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

  /**
   * Ativa ou desativa SSL para a conexão source
   * @param enabled - true para ativar SSL, false para desativar
   */
  setSourceSSL(enabled: boolean): void {
    this.config.sourceSSLEnabled = enabled
    this.log(`SSL do source ${enabled ? 'ativado' : 'desativado'}`)
  }

  /**
   * Ativa ou desativa SSL para a conexão target
   * @param enabled - true para ativar SSL, false para desativar
   */
  setTargetSSL(enabled: boolean): void {
    this.config.targetSSLEnabled = enabled
    this.log(`SSL do target ${enabled ? 'ativado' : 'desativado'}`)
  }

  /**
   * Obtém status atual do SSL para source e target
   */
  getSSLStatus(): { source: boolean; target: boolean } {
    return {
      source: this.config.sourceSSLEnabled ?? true,
      target: this.config.targetSSLEnabled ?? true
    }
  }

  /**
   * Stops scheduled synchronization
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      this.log('Sincronização agendada parada')
    }
  }

  /**
   * Gets current synchronization progress
   */
  getCurrentProgress(): ProgressInfo {
    return { ...this.progressInfo }
  }

  /**
   * Cleans up old temporary files
   */
  async cleanupOldFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.tempDir)
      const now = Date.now()
      const maxAge = 24 * 60 * 60 * 1000

      let cleanedCount = 0
      for (const file of files) {
        const filePath = path.join(this.tempDir, file)
        try {
          const stats = await fs.stat(filePath)
          if (now - stats.mtimeMs > maxAge) {
            await fs.unlink(filePath)
            cleanedCount++
          }
        } catch (error) {
          this.log(`Erro ao limpar arquivo ${file}: ${error}`)
        }
      }

      if (cleanedCount > 0) {
        this.log(`Limpeza concluída: ${cleanedCount} arquivos temporários removidos`)
      }
    } catch (error) {
      this.log(`Erro na limpeza de arquivos temporários: ${error}`)
    }
  }

  /**
   * Runs Prisma migrations on target database
   * @param backendDir - Backend directory containing Prisma schemas
   * @param targetUrl - Target database URL
   * @param logCallback - Callback function for logging
   */
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

      if (stdout) log(`[prisma:stdout] ${stdout}`)
      if (stderr) log(`[prisma:stderr] ${stderr}`)
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
}
