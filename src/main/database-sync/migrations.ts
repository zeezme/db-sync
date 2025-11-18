import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'
import { binaryManager } from '../helpers/binary-manager'

const execAsync = promisify(exec)

export async function runPrismaMigrations(
  backendDir: string,
  targetUrl: string,
  logCallback: (log: string) => void
): Promise<void> {
  const prismaCmd = await binaryManager.getBinaryPath('prisma')

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
    const { stdout, stderr } = await execAsync(`${prismaCmd} migrate deploy`, {
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
