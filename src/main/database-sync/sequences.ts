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
    const lowerTable = table.toLowerCase()

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
      AND (
        table_name = $2  -- Tenta o nome em minúsculas (maioria)
        OR table_name = $3 -- Tenta o nome original/citado (CamelCase)
      )
      AND (
        pg_get_serial_sequence($1, column_name) IS NOT NULL
        OR column_default LIKE '%nextval%'
      )
  `
    const sequencesResult = await sourceClient.query(sequencesQuery, [
      formattedTable,
      lowerTable,
      table
    ])

    if (sequencesResult.rows.length === 0) {
      return
    }

    for (const row of sequencesResult.rows) {
      if (!row.sequence_name || !row.column_name) continue

      const sequenceNameWithSchema = row.sequence_name
      const columnName = row.column_name

      try {
        const sourceSeqValue = await sourceClient.query(
          `SELECT last_value, is_called FROM ${sequenceNameWithSchema}`
        )
        const lastValue = sourceSeqValue.rows[0]?.last_value

        const maxValueResult = await targetClient.query(
          `SELECT COALESCE(MAX("${columnName}"), 0) as max_value FROM ${formattedTable}`
        )

        const maxValue = parseInt(maxValueResult.rows[0]?.max_value) || 0

        if (lastValue !== undefined && lastValue !== null) {
          let targetValue = parseInt(lastValue)
          let isCalled = sourceSeqValue.rows[0]?.is_called

          // 1. Prioridade: Garantir que o valor setado seja no MÍNIMO o maxValue (Evita Duplicate Key)
          if (maxValue > targetValue) {
            targetValue = maxValue // Define o valor para o MAX(ID)
            isCalled = true // Garante que o próximo será MAX(ID) + 1
          } else if (maxValue === targetValue) {
            // Se o MAX(ID) é igual ao lastValue do source, mantemos o lastValue
            // mas garantimos que isCalled seja true para o nextval() avançar.
            isCalled = true
          }

          if (targetValue === 0 && maxValue === 0) {
            targetValue = 1
            isCalled = false
          }

          await targetClient.query(`SELECT setval($1, $2, $3)`, [
            sequenceNameWithSchema,
            targetValue,
            isCalled
          ])

          const nextId = isCalled ? targetValue + 1 : targetValue

          log(
            `  ↻ Sequência ${sequenceNameWithSchema} atualizada para ${targetValue} (Próximo ID: ${nextId})`
          )
        }
      } catch (seqError: any) {
        log(
          `  ⚠️  Erro ao sincronizar sequência "${sequenceNameWithSchema}" para tabela "${table}": ${seqError.message}`
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
