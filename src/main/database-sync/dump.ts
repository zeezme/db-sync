import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'
import { getConnectionParams } from './connection'

export async function executeCommand(
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

export async function dumpTableData(
  table: string,
  sourceUrl: string,
  sourceSSLEnabled: boolean,
  log: (message: string) => void
): Promise<string> {
  const tempDir = path.join(tmpdir(), 'db-sync')
  await fs.mkdir(tempDir, { recursive: true })

  const dumpFile = path.join(tempDir, `${table}_${Date.now()}.dump`)

  const sourceParams = getConnectionParams(sourceUrl, sourceSSLEnabled)

  try {
    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)
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

  log(`Executando pg_dump para "${table}"...`)

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
            log(`Dump concluído para "${table}": ${stats.size} bytes`)
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
