import { TableDependency } from './types'
import { createClient } from './connection'

export async function getTableDependencies(
  tables: string[],
  sourceUrl: string,
  sourceSSLEnabled: boolean,
  log: (message: string) => void
): Promise<TableDependency[]> {
  if (tables.length === 0) return []

  const client = await createClient(sourceUrl, sourceSSLEnabled)

  try {
    log(`Analisando dependências para ${tables.length} tabelas...`)

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

    log(`Encontradas ${result.rows.length} dependências de FK`)

    if (result.rows.length > 0) {
      log('\n=== FKs DETECTADAS ===')
      result.rows.forEach((row) => {
        log(`  ${row.source_table}.${row.source_column} → ${row.target_table}.${row.target_column}`)
      })
      log('======================\n')
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

    calculateDependencyDepth(dependencies, log)

    const sorted = dependencies.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth
      return a.table.localeCompare(b.table)
    })

    log('=== ORDEM DE SINCRONIZAÇÃO ===')
    sorted.forEach((dep, index) => {
      const depsStr = dep.dependsOn.length > 0 ? ` (depende de: ${dep.dependsOn.join(', ')})` : ''
      log(`  ${index + 1}. ${dep.table} [nível ${dep.depth}]${depsStr}`)
    })
    log('=============================\n')

    return sorted
  } catch (error) {
    log(`ERRO na análise de dependências: ${error}. Usando ordenação alfabética.`)
    return tables
      .map((table) => ({ table, dependsOn: [], depth: 0 }))
      .sort((a, b) => a.table.localeCompare(b.table))
  } finally {
    await client.end()
  }
}

export function calculateDependencyDepth(
  dependencies: TableDependency[],
  log: (message: string) => void
): void {
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
    log('AVISO: Cálculo de profundidade atingiu limite máximo de iterações')
  }
}
