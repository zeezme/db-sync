import { Client } from 'pg'
import { createClient, validateDatabaseConnection } from './connection'

export async function tableExists(client: Client, table: string): Promise<boolean> {
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
  } catch {
    return false
  }
}

export async function getTables(
  sourceUrl: string,
  targetUrl: string,
  sourceSSLEnabled: boolean,
  targetSSLEnabled: boolean,
  log: (message: string) => void
): Promise<string[]> {
  log('Obtendo lista de tabelas...')

  const sourceValid = await validateDatabaseConnection(sourceUrl, sourceSSLEnabled, log)
  if (!sourceValid) {
    throw new Error('Não foi possível conectar ao banco de dados source')
  }

  const targetValid = await validateDatabaseConnection(targetUrl, targetSSLEnabled, log)
  if (!targetValid) {
    throw new Error('Não foi possível conectar ao banco de dados target')
  }

  const client = await createClient(sourceUrl, sourceSSLEnabled)

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
      .filter((table) => table && table.trim().length > 0 && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table))

    log(`Encontradas ${tables.length} tabelas no source`)

    if (tables.length === 0) {
      return []
    }

    const targetClient = await createClient(targetUrl, targetSSLEnabled)
    const tablesToSync: string[] = []

    for (const table of tables) {
      try {
        const existsInTarget = await tableExists(targetClient, table)
        if (existsInTarget) {
          tablesToSync.push(table)
        } else {
          log(`Aviso: Tabela ${table} não existe no destino. Pulando.`)
        }
      } catch (error) {
        log(`Erro ao verificar tabela ${table} no destino: ${error}`)
      }
    }

    await targetClient.end()

    if (tablesToSync.length === 0) {
      throw new Error('Nenhuma tabela válida encontrada para sincronização')
    }

    log(`Tabelas válidas para sync: ${tablesToSync.length}`)
    return tablesToSync
  } finally {
    await client.end()
  }
}

export async function getTableMetadata(
  table: string,
  sourceUrl: string,
  sourceSSLEnabled: boolean
): Promise<{
  hasUpdatedAt: boolean
  primaryKey: string
  rowCount: number
}> {
  if (!table || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(`Nome de tabela inválido: ${table}`)
  }

  const client = await createClient(sourceUrl, sourceSSLEnabled)

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

    return {
      hasUpdatedAt: updatedAtResult.rows[0].has_updated_at,
      primaryKey: pkResult.rows[0]?.column_name || 'id',
      rowCount: parseInt(countResult.rows[0].count)
    }
  } finally {
    await client.end()
  }
}

export async function getCommonColumns(
  table: string,
  sourceUrl: string,
  targetUrl: string,
  sourceSSLEnabled: boolean,
  targetSSLEnabled: boolean,
  log: (message: string) => void
): Promise<string[]> {
  const sourceClient = await createClient(sourceUrl, sourceSSLEnabled)
  const targetClient = await createClient(targetUrl, targetSSLEnabled)

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
      log(`⚠️  Colunas apenas no SOURCE (serão ignoradas): ${onlyInSource.join(', ')}`)
    }
    if (onlyInTarget.length > 0) {
      log(`⚠️  Colunas apenas no TARGET (não serão preenchidas): ${onlyInTarget.join(', ')}`)
    }

    log(
      `Colunas comuns para "${table}": ${common.join(', ')} (source: ${sourceCols.length}, target: ${targetRes.rows.length}, comuns: ${common.length})`
    )

    if (common.length === 0) {
      log(`AVISO: Nenhuma coluna comum encontrada para "${table}", pulando sync`)
      return []
    }

    return common
  } finally {
    await sourceClient.end()
    await targetClient.end()
  }
}
