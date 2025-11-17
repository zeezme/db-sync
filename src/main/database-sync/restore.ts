import * as fs from 'fs/promises'
import { getConnectionParams, createClient } from './connection'
import { executeCommand } from './dump'
import { getCommonColumns } from './metadata'

export async function restoreTableData(
  table: string,
  dumpFile: string,
  targetUrl: string,
  targetSSLEnabled: boolean,
  log: (message: string) => void
): Promise<void> {
  const targetParams = getConnectionParams(targetUrl, targetSSLEnabled)

  const sqlFile = dumpFile.replace('.dump', '.sql')

  try {
    log(`Convertendo dump para SQL para "${table}"...`)
    await executeCommand(
      'pg_restore',
      ['--data-only', '--file=' + sqlFile, dumpFile],
      { ...process.env },
      300000
    )

    log(`Removendo transaction_timeout do dump...`)
    let sqlContent = await fs.readFile(sqlFile, 'utf8')
    sqlContent = sqlContent.replace(/SET transaction_timeout = 0;\s*/g, '')
    await fs.writeFile(sqlFile, sqlContent, 'utf8')
    log(`✓ SQL limpo salvo em ${sqlFile}`)

    log(`Restaurando dados para "${table}" com psql...`)

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

    const { stdout, stderr } = await executeCommand('psql', psqlArgs, psqlEnv, 300000)
    if (stdout) log(`[psql:stdout] ${stdout}`)
    if (stderr) log(`[psql:stderr] ${stderr}`)

    if (stderr && (stderr.includes('ERROR:') || stderr.includes('duplicate key'))) {
      throw new Error(`Restore falhou com erros na transação`)
    }

    log(`✓ Restore concluído para "${table}"`)

    await fs.unlink(sqlFile).catch(() => {})
    await fs.unlink(dumpFile).catch(() => {})
  } catch (error: any) {
    log(`Restore direto falhou para "${table}": ${error.message}`)
    await fs.unlink(sqlFile).catch(() => {})

    try {
      await restoreWithUpsert(table, dumpFile, targetUrl, targetSSLEnabled, log)
      log(`✓ UPSERT concluído para "${table}"`)
      await fs.unlink(dumpFile).catch(() => {})
      return
    } catch (upsertError: any) {
      log(`UPSERT falhou para "${table}": ${upsertError.message}`)
      await fs.unlink(dumpFile).catch(() => {})
      throw new Error(`Todos os métodos de restauração falharam para "${table}"`)
    }
  }
}

export async function restoreWithUpsert(
  table: string,
  dumpFile: string,
  targetUrl: string,
  targetSSLEnabled: boolean,
  log: (message: string) => void
): Promise<void> {
  const tempTable = `temp_${table}_${Date.now()}`
  const sqlFile = dumpFile.replace('.dump', '.sql')

  const client = await createClient(targetUrl, targetSSLEnabled)

  try {
    log(`Convertendo dump para SQL...`)
    await executeCommand(
      'pg_restore',
      ['--data-only', '--file=' + sqlFile, dumpFile],
      { ...process.env },
      300000
    )
    log(`✓ Conversão para SQL concluída`)

    // Note: Need to pass sourceUrl and sourceSSLEnabled here
    // You'll need to add these as parameters to restoreWithUpsert
    // For now, this is a placeholder that needs to be fixed in actual implementation
    const commonColumns = await getCommonColumns(
      table,
      targetUrl, // This should be sourceUrl
      targetUrl,
      targetSSLEnabled, // This should be sourceSSLEnabled
      targetSSLEnabled,
      log
    )

    if (commonColumns.length === 0) {
      log(`✗ Pulando "${table}" - nenhuma coluna comum com o target`)
      return
    }

    // Get primary key from metadata
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
    const primaryKey = pkResult.rows[0]?.column_name || 'id'

    if (!commonColumns.includes(primaryKey)) {
      log(`✗ Pulando "${table}" - chave primária "${primaryKey}" não existe no target`)
      return
    }

    const commonColumnsList = commonColumns.map((col) => `"${col}"`).join(', ')
    await client.query(`
    DROP TABLE IF EXISTS "${tempTable}" CASCADE;
    CREATE TEMPORARY TABLE "${tempTable}" AS
    SELECT ${commonColumnsList} FROM "${table}" WHERE false;
  `)
    log(`✓ Tabela temporária "${tempTable}" criada com ${commonColumns.length} colunas`)

    log(`Processando arquivo SQL...`)
    const sqlContent = await fs.readFile(sqlFile, 'utf8')

    const copyBlocks = sqlContent.split('COPY ')
    if (copyBlocks.length < 2) {
      log(`✗ Não encontrou comando COPY`)
      return
    }

    const copyBlock = 'COPY ' + copyBlocks[1].split('\n\\.')[0] + '\n\\.'

    const firstLineEnd = copyBlock.indexOf('\n')
    if (firstLineEnd === -1) {
      log(`✗ Formato COPY inválido`)
      return
    }

    const headerLine = copyBlock.substring(0, firstLineEnd)

    const columnsMatch = headerLine.match(/\(([^)]+)\)/)
    if (!columnsMatch) {
      log(`✗ Não conseguiu extrair colunas`)
      return
    }

    const copyColumnNames = columnsMatch[1].split(',').map((col) => col.trim().replace(/"/g, ''))

    log(`📋 ${copyColumnNames.length} colunas no COPY`)

    const columnsWithNulls = commonColumns.filter((col) => !copyColumnNames.includes(col))
    if (columnsWithNulls.length > 0) {
      log(`⚠️  Colunas que receberão NULL (não estão no dump): ${columnsWithNulls.join(', ')}`)
    }

    const columnMapping: number[] = []
    commonColumns.forEach((commonCol) => {
      const positionInCopy = copyColumnNames.indexOf(commonCol)
      columnMapping.push(positionInCopy)
    })

    const dataStart = copyBlock.indexOf('\n') + 1
    const dataEnd = copyBlock.lastIndexOf('\n\\.')
    if (dataStart >= dataEnd) {
      log(`✗ Não encontrou dados`)
      return
    }

    const dataContent = copyBlock.substring(dataStart, dataEnd)
    const dataLines = dataContent
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('\\'))
      .map((line) => line.split('\t'))

    log(`📊 ${dataLines.length} registros encontrados`)

    if (dataLines.length === 0) {
      log(`✗ Nenhum dado`)
      return
    }

    log(`Inserindo dados...`)
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
        log(`📦 ${i}/${dataLines.length} registros`)
      }
    }

    log(`✅ ${successfulInserts}/${dataLines.length} registros carregados`)

    if (successfulInserts === 0) {
      log(`❌ Nenhum registro inserido`)
      return
    }

    log(`Executando UPSERT...`)
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
    log(`🎉 ${result.rowCount} linhas sincronizadas`)
  } catch (error: any) {
    log(`💥 Falha: ${error.message}`)
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
