import { exec } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as fs from 'fs/promises'

const execAsync = promisify(exec)

class BinaryManager {
  private binaryCache: Map<string, string> = new Map()

  /**
   * Tenta encontrar o binário nesta ordem:
   * 1. No PATH do sistema (preferido)
   * 2. Empacotado na aplicação (para Prisma)
   * 3. Em locais comuns de instalação
   */
  async getBinaryPath(binaryName: string, version?: string): Promise<string> {
    const cacheKey = `${binaryName}_${version || 'default'}`

    if (this.binaryCache.has(cacheKey)) {
      return this.binaryCache.get(cacheKey)!
    }

    try {
      const systemPath = await this.findInPath(binaryName)
      if (systemPath) {
        this.binaryCache.set(cacheKey, systemPath)
        return systemPath
      }
    } catch {
      console.log(`${binaryName} não encontrado no PATH`)
    }

    if (binaryName === 'pg_dump' || binaryName === 'pg_restore') {
      const pgPath = await this.findPostgresBinary(binaryName, version)
      if (pgPath) {
        this.binaryCache.set(cacheKey, pgPath)
        return pgPath
      }
    }

    if (binaryName === 'prisma') {
      const bundledPath = await this.getBundledPrismaPath()
      this.binaryCache.set(cacheKey, bundledPath)
      return bundledPath
    }

    if (binaryName === 'node') {
      const nodePath = await this.findNodeBinary()
      if (nodePath) {
        this.binaryCache.set(cacheKey, nodePath)
        return nodePath
      }
    }

    throw new Error(
      `${binaryName} não encontrado. Por favor, instale ${binaryName === 'pg_dump' || binaryName === 'pg_restore' ? 'o PostgreSQL Client Tools' : binaryName}.`
    )
  }

  private async findInPath(binaryName: string): Promise<string | null> {
    const command = process.platform === 'win32' ? 'where' : 'which'
    const ext = process.platform === 'win32' ? '.exe' : ''

    try {
      const { stdout } = await execAsync(`${command} ${binaryName}${ext}`)
      const foundPath = stdout.trim().split('\n')[0]

      await fs.access(foundPath, fs.constants.X_OK)
      return foundPath
    } catch {
      return null
    }
  }

  private async findPostgresBinary(binaryName: string, version?: string): Promise<string | null> {
    const ext = process.platform === 'win32' ? '.exe' : ''
    const possiblePaths: string[] = []

    if (process.platform === 'win32') {
      const versions = version ? [version] : ['17', '16', '15', '14', '13']
      for (const v of versions) {
        possiblePaths.push(
          `C:\\Program Files\\PostgreSQL\\${v}\\bin\\${binaryName}${ext}`,
          `C:\\Program Files (x86)\\PostgreSQL\\${v}\\bin\\${binaryName}${ext}`,
          `C:\\PostgreSQL\\${v}\\bin\\${binaryName}${ext}`
        )
      }
    } else if (process.platform === 'linux') {
      possiblePaths.push(
        `/usr/bin/${binaryName}`,
        `/usr/local/bin/${binaryName}`,
        `/usr/pgsql-${version || '*'}/bin/${binaryName}`,
        `/opt/postgresql/${version || '*'}/bin/${binaryName}`
      )

      if (!version) {
        try {
          const entries = await fs.readdir('/usr/lib/postgresql', { withFileTypes: true })
          const versions = entries
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))

          for (const v of versions) {
            possiblePaths.push(`/usr/lib/postgresql/${v}/bin/${binaryName}`)
          }
        } catch {
          //
        }
      } else {
        possiblePaths.push(`/usr/lib/postgresql/${version}/bin/${binaryName}`)
      }
    } else if (process.platform === 'darwin') {
      possiblePaths.push(
        `/usr/local/bin/${binaryName}`,
        `/opt/homebrew/bin/${binaryName}`,
        `/Library/PostgreSQL/${version || '*'}/bin/${binaryName}`,
        `/Applications/Postgres.app/Contents/Versions/latest/bin/${binaryName}`
      )

      if (version) {
        possiblePaths.push(
          `/Applications/Postgres.app/Contents/Versions/${version}/bin/${binaryName}`
        )
      }
    }

    for (const possiblePath of possiblePaths) {
      try {
        await fs.access(possiblePath, fs.constants.X_OK)
        return possiblePath
      } catch {
        continue
      }
    }

    return null
  }

  private async findNodeBinary(): Promise<string | null> {
    const platform = process.platform
    const possiblePaths: string[] = []

    if (platform === 'win32') {
      const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'

      possiblePaths.push(
        path.join(programFiles, 'nodejs', 'node.exe'),
        path.join(programFilesX86, 'nodejs', 'node.exe'),
        'C:\\Program Files\\nodejs\\node.exe',
        path.join(process.env['LOCALAPPDATA'] || '', 'Programs', 'nodejs', 'node.exe')
      )
    } else if (platform === 'darwin') {
      possiblePaths.push(
        '/usr/local/bin/node',
        '/opt/homebrew/bin/node',
        '/usr/bin/node',
        path.join(process.env['HOME'] || '', '.nvm', 'current', 'bin', 'node')
      )
    } else {
      possiblePaths.push(
        '/usr/bin/node',
        '/usr/local/bin/node',
        '/opt/node/bin/node',
        path.join(process.env['HOME'] || '', '.nvm', 'current', 'bin', 'node')
      )
    }

    for (const possiblePath of possiblePaths) {
      try {
        await fs.access(possiblePath, fs.constants.X_OK)
        return possiblePath
      } catch {
        continue
      }
    }

    return null
  }

  private async getBundledPrismaPath(): Promise<string> {
    const isPackaged = process.resourcesPath !== undefined

    if (isPackaged) {
      const basePath = process.resourcesPath
      const prismaCliPath = path.join(
        basePath,
        'app.asar.unpacked',
        'node_modules',
        'prisma',
        'build',
        'index.js'
      )

      await fs.access(prismaCliPath)
      return prismaCliPath
    } else {
      return path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
    }
  }

  async verifyPostgresTools(): Promise<{ available: boolean; message: string; paths?: any }> {
    try {
      const pgDumpPath = await this.getBinaryPath('pg_dump')
      const pgRestorePath = await this.getBinaryPath('pg_restore')

      return {
        available: true,
        message: 'PostgreSQL Client Tools encontrado',
        paths: {
          pg_dump: pgDumpPath,
          pg_restore: pgRestorePath
        }
      }
    } catch {
      return {
        available: false,
        message:
          `PostgreSQL Client Tools não encontrado. Por favor, instale:\n\n` +
          `Windows: Baixe de https://www.postgresql.org/download/windows/\n` +
          `Linux: sudo apt install postgresql-client\n` +
          `macOS: brew install postgresql@17`
      }
    }
  }

  async verifyPrisma(): Promise<{ available: boolean; message: string; path?: string }> {
    try {
      const prismaPath = await this.getBinaryPath('prisma')
      return {
        available: true,
        message: 'Prisma CLI encontrado',
        path: prismaPath
      }
    } catch (error: any) {
      return {
        available: false,
        message: error.message
      }
    }
  }

  async verifyNode(): Promise<{ available: boolean; message: string; path?: string }> {
    try {
      const nodePath = await this.getBinaryPath('node')

      try {
        const { stdout } = await execAsync(`"${nodePath}" --version`)
        const version = stdout.trim()

        return {
          available: true,
          message: `Node.js ${version} encontrado`,
          path: nodePath
        }
      } catch {
        return {
          available: true,
          message: 'Node.js encontrado',
          path: nodePath
        }
      }
    } catch {
      return {
        available: false,
        message:
          `Node.js não encontrado. Por favor, instale:\n\n` +
          `Windows: Baixe de https://nodejs.org/\n` +
          `Linux: sudo apt install nodejs\n` +
          `macOS: brew install node`
      }
    }
  }

  clearCache(): void {
    this.binaryCache.clear()
  }
}

export const binaryManager = new BinaryManager()
