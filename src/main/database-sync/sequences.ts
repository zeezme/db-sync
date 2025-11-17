import { createClient } from './connection'

export async function syncTableSequences(
  table: string,
  sourceUrl: string,
  targetUrl: string,
  sourceSSLEnabled: boolean,
  targetSSLEnabled: boolean,
  log: (message: string) => void
): Promise<void> {
  const sourceClient = await createClient(sourceUrl, sourceSSLEnabled)
  const targetClient = await createClient(targetUrl, targetSSLEnabled)

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

          log(`  ↻ Sequência ${formattedSequence} atualizada para ${safeValue}`)
        }
      } catch (seqError: any) {
        log(
          `  ⚠️  Erro ao sincronizar sequência "${sequenceName}" para tabela "${table}": ${seqError.message}`
        )
      }
    }
  } catch (error: any) {
    log(`Erro ao sincronizar sequências de "${table}": ${error.message}`)
  } finally {
    await sourceClient.end()
    await targetClient.end()
  }
}
