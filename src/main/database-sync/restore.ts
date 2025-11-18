import * as fs from 'fs/promises'
import { getConnectionParams, createClient } from './connection'
import { executeCommand } from './dump'
import { getCommonColumns } from './metadata'
import { binaryManager } from '../helpers/binary-manager'

async function safeUnlink(filePath: string, log: (message: string) => void): Promise<void> {
  try {
    await fs.unlink(filePath)
    log(`Arquivo temporário excluído: ${filePath}`)
  } catch {
    //
  }
}

export async function restoreTableData(
  table: string,
  dumpFile: string,
  targetUrl: string,
  targetSSLEnabled: boolean,
  log: (message: string) => void
): Promise<void> {
  const targetParams = getConnectionParams(targetUrl, targetSSLEnabled)

  const sqlFile = dumpFile.replace('.dump', '.sql')

  const pgRestorePath = await binaryManager.getBinaryPath('pg_restore')

  try {
    log(`Convertendo dump para SQL para "${table}"...`)
    await executeCommand(
      pgRestorePath,
      ['--data-only', `--file=${sqlFile}`, dumpFile],
      { ...process.env },
      300000
    )

    log(`Removendo transaction_timeout do dump...`)
    let sqlContent = await fs.readFile(sqlFile, 'utf8')
    sqlContent = sqlContent.replace(/SET transaction_timeout = 0;\s*/g, '')
    await fs.writeFile(sqlFile, sqlContent, 'utf8')
    log(`SQL limpo salvo em ${sqlFile}`)

    log(`Restaurando dados para "${table}" com psql...`)

    const psqlPath = await binaryManager.getBinaryPath('psql')

    const psqlArgs = [
      `--host=${targetParams.host}`,
      `--port=${targetParams.port}`,
      `--username=${targetParams.user}`,
      `--dbname=${targetParams.database}`,
      '--no-password',
      '--single-transaction',
      `--file=${sqlFile}`
    ]

    const psqlEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PGPASSWORD: String(targetParams.password) || '',
      PGSSLMODE: targetParams.ssl ? 'require' : 'prefer'
    }

    const { stdout, stderr } = await executeCommand(psqlPath, psqlArgs, psqlEnv, 300000)
    if (stdout) log(`[psql:stdout] ${stdout}`)
    if (stderr) log(`[psql:stderr] ${stderr}`)

    if (stderr && (stderr.includes('ERROR:') || stderr.includes('duplicate key'))) {
      throw new Error(`Restore direto falhou (Erro psql). Tentando UPSERT...`)
    }

    log(`Restore concluído para "${table}"`)

    await safeUnlink(sqlFile, log)
    await safeUnlink(dumpFile, log)
  } catch (error: any) {
    await safeUnlink(sqlFile, log)

    if (
      error.message.includes('duplicate key') ||
      error.message.includes('Restore direto falhou')
    ) {
      log(`Tentando UPSERT para "${table}"...`)
      try {
        await restoreWithUpsert(table, dumpFile, targetUrl, targetSSLEnabled, log)
        log(`UPSERT concluído para "${table}"`)

        await safeUnlink(dumpFile, log)
        return
      } catch (upsertError: any) {
        log(`UPSERT falhou para "${table}": ${upsertError.message}`)
        await safeUnlink(dumpFile, log)
        throw new Error(`Todos os métodos de restauração falharam para "${table}"`)
      }
    } else {
      log(`Erro fatal no restore para "${table}": ${error.message}`)
      await safeUnlink(dumpFile, log)
      throw error
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
  let cleanupSuccessful = false

  try {
    if (!(await fs.stat(sqlFile).catch(() => null))) {
      await executeCommand(
        'pg_restore',
        ['--data-only', '--file=' + sqlFile, dumpFile],
        { ...process.env },
        300000
      )
    }

    const commonColumns = await getCommonColumns(
      table,
      targetUrl,
      targetUrl,
      targetSSLEnabled,
      targetSSLEnabled,
      log
    )
    if (commonColumns.length === 0) {
      log(`Aviso: Nenhuma coluna comum encontrada para "${table}".`)
      return
    }

    const pkRes = await client.query(
      `
      SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary LIMIT 1
    `,
      [`"${table}"`]
    )
    const primaryKey = pkRes.rows[0]?.attname || 'id'

    if (!commonColumns.includes(primaryKey)) {
      throw new Error(
        `Chave primária "${primaryKey}" não encontrada nas colunas comuns de "${table}".`
      )
    }

    const colsList = commonColumns.map((c) => `"${c}"`).join(', ')

    await client.query(`DROP TABLE IF EXISTS "${tempTable}" CASCADE`)
    await client.query(`CREATE TEMP TABLE "${tempTable}" (LIKE "${table}" INCLUDING ALL)`)

    await client.query(`INSERT INTO "${tempTable}" SELECT ${colsList} FROM "${table}"`)

    const sql = await fs.readFile(sqlFile, 'utf8')

    const match = sql.match(/COPY .*?\(([\s\S]*?)\)\s+FROM stdin;\n([\s\S]*?)\n\\\./)

    if (!match) throw new Error('Dados COPY não encontrados no arquivo SQL.')

    const copyCols = match[1].split(',').map((c) => c.trim().replace(/"/g, ''))
    const dataLines = match[2]
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('\\'))
      .map((l) => l.split('\t'))

    const onlyInSource = copyCols.filter((c) => !commonColumns.includes(c))
    const onlyInTarget = commonColumns.filter((c) => !copyCols.includes(c))
    if (onlyInSource.length) log(`Colunas apenas no SOURCE (ignoradas): ${onlyInSource.join(', ')}`)
    if (onlyInTarget.length) log(`Colunas apenas no TARGET (mantidas): ${onlyInTarget.join(', ')}`)

    const tempUpdatable =
      commonColumns
        .filter((c) => c !== primaryKey && copyCols.includes(c))
        .map((c) => `"${c}" = EXCLUDED."${c}"`)
        .join(', ') || `"${primaryKey}" = EXCLUDED."${primaryKey}"`

    for (let i = 0; i < dataLines.length; i += 1000) {
      const batch = dataLines.slice(i, i + 1000)
      await Promise.all(
        batch.map(async (line) => {
          const values = commonColumns.map((col) => {
            const idx = copyCols.indexOf(col)

            if (idx === -1) return null
            const v = line[idx]
            return v === '\\N' ? null : v
          })
          const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')

          await client.query(
            `INSERT INTO "${tempTable}" (${colsList}) VALUES (${placeholders}) 
            ON CONFLICT ("${primaryKey}") DO UPDATE SET ${tempUpdatable}`,
            values
          )
        })
      )
    }

    const updatable = commonColumns
      .filter((c) => c !== primaryKey && copyCols.includes(c))
      .map((c) => `"${c}" = EXCLUDED."${c}"`)
      .join(', ')

    const upsertSQL = `
      INSERT INTO "${table}" (${colsList})
      SELECT ${colsList} FROM "${tempTable}"
      ON CONFLICT ("${primaryKey}") DO UPDATE SET
      ${updatable || `"${primaryKey}" = EXCLUDED."${primaryKey}"`}
    `

    const result = await client.query(upsertSQL)
    log(`${result.rowCount} linhas sincronizadas corretamente`)
    cleanupSuccessful = true
  } catch (error: any) {
    log(`UPSERT falhou: ${error.message}`)
    throw error
  } finally {
    await client.query(`DROP TABLE IF EXISTS "${tempTable}"`).catch(() => {})
    await client.end().catch(() => {})
    if (cleanupSuccessful) {
      await safeUnlink(sqlFile, log)
      await safeUnlink(dumpFile, log)
    }
  }
}
