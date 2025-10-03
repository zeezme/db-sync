import { exec, spawn, ChildProcess } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'
import { Client, ClientConfig } from 'pg'

const execAsync = promisify(exec)

export interface SyncConfig {
  sourceUrl: string
  targetUrl: string
  intervalMinutes: number
  excludeTables: string[]
  maxParallelTables?: number
}

interface ProgressInfo {
  currentTable: string
  completedTables: number
  totalTables: number
  percentage: number
  status: 'starting' | 'processing' | 'completed' | 'error'
  currentAction?: string
}

interface TableDependency {
  table: string
  dependsOn: string[]
  depth: number
}

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

  constructor(config: SyncConfig, logCallback: (log: string) => void) {
    this.validateConfig(config)

    this.config = {
      ...config,
      maxParallelTables: config.maxParallelTables || 3
    }
    this.logCallback = logCallback
    this.tempDir = path.join(tmpdir(), 'db-sync')
  }

  private validateConfig(config: SyncConfig): void {
    const errors: string[] = []

    if (!config.sourceUrl || !config.sourceUrl.startsWith('postgresql://')) {
      errors.push('sourceUrl deve ser uma URL PostgreSQL válida')
    }

    if (!config.targetUrl || !config.targetUrl.startsWith('postgresql://')) {
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

  private log(message: string) {
    const timestamp = new Date().toISOString()
    const progressMsg =
      this.progressInfo.totalTables > 0
        ? `[${this.progressInfo.percentage}% - ${this.progressInfo.completedTables}/${this.progressInfo.totalTables}] `
        : ''
    const logMessage = `[${timestamp}] ${progressMsg}${message}`

    // Debug para ver quantas vezes é chamado
    console.log(`[LOG-CALL] Chamando logCallback: "${message.substring(0, 50)}..."`)

    this.logCallback(logMessage)
  }

  private getConnectionParams(url: string): ClientConfig {
    try {
      const urlObj = new URL(url)

      // Determinar SSL mode baseado na URL
      const isLocalhost =
        urlObj.hostname.includes('localhost') || urlObj.hostname.includes('127.0.0.1')

      return {
        user: decodeURIComponent(urlObj.username),
        password: decodeURIComponent(urlObj.password),
        host: urlObj.hostname,
        port: parseInt(urlObj.port) || 5432,
        database: urlObj.pathname.replace('/', ''),
        ssl: isLocalhost ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 30000,
        idle_in_transaction_session_timeout: 30000
      }
    } catch (error) {
      throw new Error(`Erro ao analisar URL do banco de dados (${url}): ${error}`)
    }
  }

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

  private async validateDatabaseConnection(url: string): Promise<boolean> {
    try {
      const client = await this.createClient(url)
      const result = await client.query(
        'SELECT version() as db_version, current_database() as db_name'
      )
      this.log(`✓ Conexão válida com ${url} (${result.rows[0].db_name})`)
      await client.end()
      return true
    } catch (error) {
      this.log(`✗ Falha na validação da conexão com ${url}: ${error}`)
      return false
    }
  }

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
        ${
          this.config.excludeTables.length > 0
            ? `AND table_name NOT IN (${this.config.excludeTables.map((_, i) => `$${i + 1}`).join(', ')})`
            : ''
        }
        ORDER BY table_name;
      `

      const result = await client.query(
        query,
        this.config.excludeTables.length > 0 ? this.config.excludeTables : []
      )

      const tables = result.rows
        .map((row) => row.table_name)
        .filter(
          (table) => table && table.trim().length > 0 && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)
        )

      this.log(`Encontradas ${tables.length} tabelas no source`)

      if (tables.length === 0) {
        return []
      }

      // Verificar quais tabelas existem no destino
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

  private async getTableDependencies(tables: string[]): Promise<TableDependency[]> {
    if (tables.length === 0) return []

    const client = await this.createClient(this.config.sourceUrl)

    try {
      this.log(`Analisando dependências para ${tables.length} tabelas...`)
      this.log(`Tabelas: ${tables.join(', ')}`)

      // Buscar TODAS as FKs (incluindo externas)
      const result = await client.query(
        `
      SELECT DISTINCT
        tc.table_name as source_table,
        ccu.table_name as target_table,
        tc.constraint_name as constraint_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = ANY($1::text[])
      ORDER BY tc.table_name, ccu.table_name
      `,
        [tables]
      )

      this.log(`Encontradas ${result.rows.length} dependências de FK`)

      // Log de TODAS as FKs encontradas
      if (result.rows.length > 0) {
        this.log('\n=== TODAS AS FKs DETECTADAS ===')
        result.rows.forEach((row) => {
          const isInternal = tables.includes(row.target_table)
          const marker = isInternal ? '✓' : '⚠️ EXTERNA'
          this.log(`  ${marker} ${row.source_table} → ${row.target_table} (${row.constraint_name})`)
        })
        this.log('================================\n')
      }

      // Criar mapa de dependências
      const dependencyMap = new Map<string, string[]>()
      const externalDependencies = new Set<string>()

      // Inicializar todas as tabelas
      tables.forEach((table) => {
        dependencyMap.set(table, [])
      })

      // Preencher dependências
      for (const row of result.rows) {
        if (row.source_table !== row.target_table) {
          // Verificar se é dependência externa
          if (!tables.includes(row.target_table)) {
            externalDependencies.add(`${row.source_table} → ${row.target_table}`)
            this.log(
              `⚠️  AVISO: ${row.source_table} depende de ${row.target_table} que NÃO está sendo sincronizada!`
            )
          } else {
            // Dependência interna válida
            const currentDeps = dependencyMap.get(row.source_table) || []
            if (!currentDeps.includes(row.target_table)) {
              currentDeps.push(row.target_table)
              dependencyMap.set(row.source_table, currentDeps)
            }
          }
        }
      }

      // Avisar sobre dependências externas
      if (externalDependencies.size > 0) {
        this.log(`\n⚠️  ${externalDependencies.size} dependências externas detectadas!`)
        this.log('Isso pode causar erros de FK. Considere adicionar essas tabelas ao sync.\n')
      }

      // Log das dependências internas
      let hasDependencies = false
      dependencyMap.forEach((deps, table) => {
        if (deps.length > 0) {
          if (!hasDependencies) {
            this.log('Dependências INTERNAS encontradas:')
            hasDependencies = true
          }
          this.log(`  ${table} → ${deps.join(', ')}`)
        }
      })

      if (!hasDependencies) {
        this.log('Nenhuma dependência interna encontrada entre as tabelas')
      }

      // Converter para array de TableDependency
      const dependencies: TableDependency[] = []
      dependencyMap.forEach((dependsOn, table) => {
        dependencies.push({ table, dependsOn, depth: 0 })
      })

      // Calcular profundidades
      this.calculateDependencyDepth(dependencies)

      // Ordenar por profundidade e depois por nome
      const sorted = dependencies.sort((a, b) => {
        if (a.depth !== b.depth) return a.depth - b.depth
        return a.table.localeCompare(b.table)
      })

      this.log('\n=== ORDEM DE SINCRONIZAÇÃO CALCULADA ===')
      sorted.forEach((dep, index) => {
        const depsStr = dep.dependsOn.length > 0 ? ` (depende de: ${dep.dependsOn.join(', ')})` : ''
        this.log(`  ${index + 1}. ${dep.table} [nível ${dep.depth}]${depsStr}`)
      })

      // Verificação específica para empresa e configuracaoEtiqueta
      this.log('\n=== VERIFICAÇÃO ESPECÍFICA ===')
      const empresa = sorted.find((d) => d.table === 'empresa')
      const config = sorted.find((d) => d.table === 'configuracaoEtiqueta')

      if (empresa) {
        this.log(
          `✓ empresa encontrada: depth=${empresa.depth}, depende de [${empresa.dependsOn.join(', ') || 'nenhuma'}]`
        )
      } else {
        this.log(`✗ empresa NÃO encontrada na lista de tabelas a sincronizar!`)
      }

      if (config) {
        this.log(
          `✓ configuracaoEtiqueta encontrada: depth=${config.depth}, depende de [${config.dependsOn.join(', ') || 'nenhuma'}]`
        )
      } else {
        this.log(`✗ configuracaoEtiqueta NÃO encontrada na lista de tabelas a sincronizar!`)
      }

      if (empresa && config) {
        if (empresa.depth < config.depth) {
          this.log(
            `✓ ORDEM CORRETA: empresa (${empresa.depth}) será processada ANTES de configuracaoEtiqueta (${config.depth})`
          )
        } else if (empresa.depth === config.depth) {
          this.log(
            `⚠️  MESMO NÍVEL: empresa e configuracaoEtiqueta estão no nível ${empresa.depth} - podem ter race condition!`
          )
        } else {
          this.log(
            `✗ ORDEM ERRADA: configuracaoEtiqueta (${config.depth}) será processada ANTES de empresa (${empresa.depth})!`
          )
        }
      }
      this.log('================================\n')

      return sorted
    } catch (error) {
      this.log(`ERRO na análise de dependências: ${error}. Usando ordenação alfabética.`)
      // Fallback: ordenação alfabética
      return tables
        .map((table) => ({ table, dependsOn: [], depth: 0 }))
        .sort((a, b) => a.table.localeCompare(b.table))
    } finally {
      await client.end()
    }
  }

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
      // Verificar se tem updated_at
      const updatedAtResult = await client.query(
        `
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'updated_at'
        ) as has_updated_at
      `,
        [table]
      )

      // Obter chave primária
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

      // Contar registros
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

  private async getLastSyncTime(table: string): Promise<Date | null> {
    const client = await this.createClient(this.config.targetUrl)

    try {
      const result = await client.query(`
        SELECT MAX(updated_at) as last_sync FROM "${table}" WHERE updated_at IS NOT NULL
      `)
      return result.rows[0]?.last_sync || null
    } catch (error) {
      this.log(`Erro ao obter last sync de ${table}: ${error}`)
      return null
    } finally {
      await client.end()
    }
  }

  private async dumpTableData(
    table: string,
    hasUpdatedAt: boolean,
    lastSyncTime: Date | null
  ): Promise<string> {
    await this.ensureTempDir()
    const dumpFile = path.join(this.tempDir, `${table}_${Date.now()}.dump`)

    const sourceParams = this.getConnectionParams(this.config.sourceUrl)

    // Validar se pg_dump está disponível
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
      `--file=${dumpFile}`
    ]

    // Adicionar filtro por updated_at se disponível
    if (hasUpdatedAt && lastSyncTime) {
      args.push(`--where="updated_at>'${lastSyncTime.toISOString()}'"`)
    }

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

  private async restoreTableData(
    table: string,
    dumpFile: string,
    primaryKey: string
  ): Promise<void> {
    const targetParams = this.getConnectionParams(this.config.targetUrl)

    // Estratégia de restauração em 3 fases:

    // Fase 1: Tentar pg_restore normal
    try {
      const args = [
        `--dbname=postgresql://${targetParams.user}:${targetParams.password}@${targetParams.host}:${targetParams.port}/${targetParams.database}`,
        '--no-password',
        '--data-only',
        '--single-transaction',
        '--no-owner',
        '--no-privileges',
        '--verbose',
        dumpFile
      ]

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PGSSLMODE: targetParams.ssl ? 'require' : 'prefer'
      }

      this.log(`Restaurando dados para "${table}" (fase 1)...`)

      await this.executeCommand('pg_restore', args, env, 300000)
      this.log(`✓ Restore concluído para "${table}"`)
      return
    } catch (error: any) {
      this.log(`Fase 1 falhou para "${table}": ${error.message}`)
    }

    // Fase 2: Tentar UPSERT com fallback para FK errors
    try {
      await this.restoreWithUpsert(table, dumpFile, primaryKey)
      this.log(`✓ UPSERT concluído para "${table}"`)
      return
    } catch (error: any) {
      this.log(`Fase 2 falhou para "${table}": ${error.message}`)
    }

    // Fase 3: Tentar INSERT IGNORE (mais tolerante a FKs)
    try {
      await this.restoreWithInsertIgnore(table, dumpFile)
      this.log(`✓ INSERT IGNORE concluído para "${table}"`)
      return
    } catch (error: any) {
      this.log(`Fase 3 falhou para "${table}": ${error.message}`)
      throw new Error(`Todos os métodos de restauração falharam para "${table}"`)
    }
  }

  private async executeCommand(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    timeout: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const process: ChildProcess = spawn(command, args, { env })

      const timeoutId = setTimeout(() => {
        process.kill('SIGTERM')
        reject(new Error(`Timeout no ${command}`))
      }, timeout)

      let stderr = ''

      process.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      process.on('close', (code) => {
        clearTimeout(timeoutId)

        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`${command} falhou (código ${code}): ${stderr}`))
        }
      })

      process.on('error', (error) => {
        clearTimeout(timeoutId)
        reject(new Error(`Erro ao executar ${command}: ${error}`))
      })
    })
  }

  private async restoreWithUpsert(
    table: string,
    dumpFile: string,
    primaryKey: string
  ): Promise<void> {
    const targetParams = this.getConnectionParams(this.config.targetUrl)
    const sqlFile = dumpFile.replace('.dump', '.sql')

    try {
      // Converter dump para SQL
      const convertEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PGPASSWORD: String(targetParams.password) || '',
        PGSSLMODE: targetParams.ssl ? 'require' : 'prefer'
      }

      await this.executeCommand('pg_restore', ['--file=' + sqlFile, dumpFile], convertEnv, 300000)

      // Ler e modificar o SQL
      let sqlContent = await fs.readFile(sqlFile, 'utf8')

      // Substituir COPY por INSERT com ON CONFLICT
      sqlContent = this.convertCopyToUpsert(sqlContent, table, primaryKey)

      await fs.writeFile(sqlFile, sqlContent, 'utf8')

      // Executar SQL modificado
      const args = [
        `--host=${targetParams.host}`,
        `--port=${targetParams.port}`,
        `--username=${targetParams.user}`,
        `--dbname=${targetParams.database}`,
        '--no-password',
        '--file=' + sqlFile
      ]

      const psqlEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PGPASSWORD: String(targetParams.password) || '',
        PGSSLMODE: targetParams.ssl ? 'require' : 'prefer'
      }

      await this.executeCommand('psql', args, psqlEnv, 300000)
    } finally {
      await fs.unlink(sqlFile).catch(() => {})
    }
  }

  private async restoreWithInsertIgnore(table: string, dumpFile: string): Promise<void> {
    const targetParams = this.getConnectionParams(this.config.targetUrl)
    const sqlFile = dumpFile.replace('.dump', '.sql')

    try {
      // Converter dump para SQL
      const convertEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PGPASSWORD: String(targetParams.password) || '',
        PGSSLMODE: targetParams.ssl ? 'require' : 'prefer'
      }

      await this.executeCommand('pg_restore', ['--file=' + sqlFile, dumpFile], convertEnv, 300000)

      // Ler SQL
      let sqlContent = await fs.readFile(sqlFile, 'utf8')

      // Substituir COPY por INSERT com ON CONFLICT DO NOTHING
      sqlContent = this.convertCopyToInsertIgnore(sqlContent, table)

      await fs.writeFile(sqlFile, sqlContent, 'utf8')

      // Executar SQL
      const args = [
        `--host=${targetParams.host}`,
        `--port=${targetParams.port}`,
        `--username=${targetParams.user}`,
        `--dbname=${targetParams.database}`,
        '--no-password',
        '--file=' + sqlFile
      ]

      const psqlEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PGPASSWORD: String(targetParams.password) || '',
        PGSSLMODE: targetParams.ssl ? 'require' : 'prefer'
      }

      await this.executeCommand('psql', args, psqlEnv, 300000)
    } finally {
      await fs.unlink(sqlFile).catch(() => {})
    }
  }

  private convertCopyToUpsert(sqlContent: string, tableName: string, primaryKey: string): string {
    const copyPattern = /COPY "([^"]+)" \(([^)]+)\) FROM stdin;\n([\s\S]*?)\n\\\./g

    return sqlContent.replace(copyPattern, (match, extractedTableName, columns, data) => {
      if (extractedTableName !== tableName) return match

      const columnList = columns.split(', ').map((col) => col.replace(/"/g, ''))

      const valueLines = data
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('\\'))
        .map((line) => {
          const values = line.split('\t').map((val) => {
            if (val === '\\N') return 'NULL'
            return `'${val.replace(/'/g, "''")}'`
          })
          return `    (${values.join(', ')})`
        })

      if (valueLines.length === 0) return ''

      const upsertSQL =
        `INSERT INTO "${extractedTableName}" (${columnList.map((col) => `"${col}"`).join(', ')})\n` +
        `VALUES\n${valueLines.join(',\n')}\n` +
        `ON CONFLICT ("${primaryKey}") DO UPDATE SET\n` +
        columnList
          .filter((col) => col !== primaryKey)
          .map((col) => `  "${col}" = EXCLUDED."${col}"`)
          .join(',\n') +
        ';'

      return upsertSQL
    })
  }

  private convertCopyToInsertIgnore(sqlContent: string, tableName: string): string {
    const copyPattern = /COPY "([^"]+)" \(([^)]+)\) FROM stdin;\n([\s\S]*?)\n\\\./g

    return sqlContent.replace(copyPattern, (match, extractedTableName, columns, data) => {
      if (extractedTableName !== tableName) return match

      const columnList = columns.split(', ').map((col) => col.replace(/"/g, ''))

      const valueLines = data
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('\\'))
        .map((line) => {
          const values = line.split('\t').map((val) => {
            if (val === '\\N') return 'NULL'
            return `'${val.replace(/'/g, "''")}'`
          })
          return `    (${values.join(', ')})`
        })

      if (valueLines.length === 0) return ''

      const insertSQL =
        `INSERT INTO "${extractedTableName}" (${columnList.map((col) => `"${col}"`).join(', ')})\n` +
        `VALUES\n${valueLines.join(',\n')}\n` +
        `ON CONFLICT DO NOTHING;`

      return insertSQL
    })
  }

  private async syncTable(
    table: string,
    tableIndex: number,
    totalTables: number
  ): Promise<boolean> {
    try {
      this.updateProgress(table, tableIndex, totalTables, 'processing', 'iniciando')
      this.log(`Iniciando sync da tabela "${table}"`)

      // Obter metadados
      this.updateProgress(table, tableIndex, totalTables, 'processing', 'obtendo metadados')
      const metadata = await this.getTableMetadata(table)
      this.log(`Metadados "${table}": ${metadata.rowCount} linhas, PK: ${metadata.primaryKey}`)

      // Obter último sync se tiver updated_at
      let lastSyncTime: Date | null = null
      if (metadata.hasUpdatedAt) {
        this.updateProgress(table, tableIndex, totalTables, 'processing', 'verificando último sync')
        lastSyncTime = await this.getLastSyncTime(table)
        this.log(`Último sync "${table}": ${lastSyncTime || 'primeira execução'}`)
      }

      // Fazer dump
      this.updateProgress(table, tableIndex, totalTables, 'processing', 'fazendo dump')
      const dumpFile = await this.dumpTableData(table, metadata.hasUpdatedAt, lastSyncTime)

      try {
        // Restaurar dados
        this.updateProgress(table, tableIndex, totalTables, 'processing', 'restaurando dados')
        await this.restoreTableData(table, dumpFile, metadata.primaryKey)

        // Limpar arquivo temporário
        await fs.unlink(dumpFile).catch(() => {})

        this.updateProgress(table, tableIndex + 1, totalTables, 'completed')
        this.log(`✓ Sync concluído para "${table}"`)
        return true
      } catch (error) {
        // Limpar arquivo em caso de erro
        await fs.unlink(dumpFile).catch(() => {})
        throw error
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

      // Validação pré-sincronização
      await this.preSyncValidation()

      // Conectar ao banco target
      targetClient = await this.createClient(this.config.targetUrl)

      // Desabilitar ALL triggers em TODAS as tabelas
      this.log('Desabilitando triggers de foreign key em todas as tabelas...')

      // Obter lista de tabelas do target
      const tablesResult = await targetClient.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
    `)

      const allTables = tablesResult.rows.map((row) => row.tablename)

      // Desabilitar triggers em cada tabela
      for (const table of allTables) {
        try {
          await targetClient.query(`ALTER TABLE "${table}" DISABLE TRIGGER ALL;`)
        } catch (error) {
          this.log(`Aviso: não foi possível desabilitar triggers em ${table}: ${error}`)
        }
      }

      this.log(`✓ Triggers desabilitados em ${allTables.length} tabelas`)

      try {
        // Obter tabelas para sincronizar
        this.updateProgress('', 0, 0, 'processing', 'obtendo lista de tabelas')
        const tables = await this.getTables()

        if (tables.length === 0) {
          this.log('Nenhuma tabela para sincronizar')
          return
        }

        // Analisar dependências
        this.updateProgress('', 0, 0, 'processing', 'analisando dependências')
        const dependencies = await this.getTableDependencies(tables)

        this.updateProgress('', 0, tables.length, 'processing', 'iniciando sync')
        let successCount = 0

        // Processar tabelas em ordem de dependência
        const maxDepth = Math.max(...dependencies.map((d) => d.depth))

        for (let depth = 0; depth <= maxDepth; depth++) {
          const tablesAtDepth = dependencies
            .filter((dep) => dep.depth === depth)
            .map((dep) => dep.table)

          if (tablesAtDepth.length === 0) continue

          this.log(`Processando nível ${depth} (${tablesAtDepth.length} tabelas)`)

          // Processar em batches
          const batchSize = this.config.maxParallelTables!
          for (let i = 0; i < tablesAtDepth.length; i += batchSize) {
            const batch = tablesAtDepth.slice(i, i + batchSize)

            const currentIndex = dependencies.findIndex((dep) => dep.table === batch[0])
            const batchSuccess = await this.processTableBatch(batch, currentIndex, tables.length)
            successCount += batchSuccess

            // Pequena pausa entre batches
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
        // Reabilitar triggers em todas as tabelas
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

  private async preSyncValidation(): Promise<void> {
    this.log('Executando validações pré-sincronização...')

    // Validar diretório temporário
    await this.ensureTempDir()

    // Validar ferramentas
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

  async startScheduled(): Promise<void> {
    this.log(`Iniciando sincronização agendada (${this.config.intervalMinutes} minutos)...`)

    // Executar imediatamente
    await this.syncNow()

    // Agendar execuções periódicas
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

  getCurrentProgress(): ProgressInfo {
    return { ...this.progressInfo }
  }

  async cleanupOldFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.tempDir)
      const now = Date.now()
      const maxAge = 24 * 60 * 60 * 1000 // 24 horas

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
