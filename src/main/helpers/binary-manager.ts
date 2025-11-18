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
    } catch (error) {
      console.log(`${binaryName} não encontrado no PATH:`, error)
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
      const { stdout } = await execAsync(`${command} ${binaryName}${ext}`, {
        env: this.getEnhancedEnv()
      } as any)

      const foundPath = stdout.toString().trim().split('\n')[0].trim()

      if (!foundPath) {
        return null
      }

      try {
        await fs.access(foundPath, fs.constants.X_OK)
        return foundPath
      } catch {
        if (process.platform === 'win32') {
          await fs.access(foundPath, fs.constants.F_OK)
          return foundPath
        }
        return null
      }
    } catch {
      return null
    }
  }

  /**
   * Retorna variáveis de ambiente melhoradas, incluindo locais comuns
   */
  private getEnhancedEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    const platform = process.platform
    const home = process.env.HOME || process.env.USERPROFILE || ''

    const additionalPaths: string[] = []

    if (platform === 'win32') {
      additionalPaths.push(
        'C:\\Program Files\\nodejs',
        'C:\\Program Files (x86)\\nodejs',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'),
        path.join(process.env.APPDATA || '', 'npm')
      )
    } else if (platform === 'darwin') {
      additionalPaths.push(
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
        path.join(home, '.nvm/current/bin'),
        path.join(home, '.volta/bin'),
        path.join(home, '.fnm/current/bin'),
        path.join(home, '.asdf/shims')
      )
    } else {
      additionalPaths.push(
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        path.join(home, '.nvm/current/bin'),
        path.join(home, '.volta/bin'),
        path.join(home, '.fnm/current/bin'),
        path.join(home, '.asdf/shims')
      )
    }

    const currentPath = env.PATH || ''
    const separator = platform === 'win32' ? ';' : ':'

    const newPaths = additionalPaths.filter((p) => !currentPath.includes(p))

    if (newPaths.length > 0) {
      env.PATH = [currentPath, ...newPaths].filter(Boolean).join(separator)
    }

    return env
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
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const possiblePaths: string[] = []

    if (process.execPath) {
      try {
        await fs.access(process.execPath, fs.constants.F_OK)
        possiblePaths.unshift(process.execPath)
      } catch {
        //
      }
    }

    if (platform === 'win32') {
      const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
      const localAppData = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local')
      const appData = process.env['APPDATA'] || path.join(home, 'AppData', 'Roaming')

      possiblePaths.push(
        path.join(programFiles, 'nodejs', 'node.exe'),
        path.join(programFilesX86, 'nodejs', 'node.exe'),
        'C:\\Program Files\\nodejs\\node.exe',
        path.join(localAppData, 'Programs', 'nodejs', 'node.exe'),

        path.join(appData, 'nvm', 'current', 'node.exe'),
        path.join(localAppData, 'fnm_multishells', '*', 'node.exe'),
        path.join(localAppData, 'Volta', 'tools', 'image', 'node', '*', 'bin', 'node.exe')
      )
    } else if (platform === 'darwin') {
      possiblePaths.push(
        '/usr/local/bin/node',
        '/opt/homebrew/bin/node',
        '/usr/bin/node',

        path.join(home, '.nvm', 'current', 'bin', 'node'),
        path.join(home, '.volta', 'bin', 'node'),
        path.join(home, '.fnm', 'current', 'bin', 'node'),
        path.join(home, '.asdf', 'shims', 'node')
      )

      try {
        const nvmDir = path.join(home, '.nvm', 'versions', 'node')
        const versions = await fs.readdir(nvmDir)
        if (versions.length > 0) {
          const latestVersion = versions.sort().reverse()[0]
          possiblePaths.push(path.join(nvmDir, latestVersion, 'bin', 'node'))
        }
      } catch {
        //
      }
    } else {
      possiblePaths.push(
        '/usr/bin/node',
        '/usr/local/bin/node',
        '/opt/node/bin/node',

        path.join(home, '.nvm', 'current', 'bin', 'node'),
        path.join(home, '.volta', 'bin', 'node'),
        path.join(home, '.fnm', 'current', 'bin', 'node'),
        path.join(home, '.asdf', 'shims', 'node')
      )

      try {
        const nvmDir = path.join(home, '.nvm', 'versions', 'node')
        const versions = await fs.readdir(nvmDir)
        if (versions.length > 0) {
          const latestVersion = versions.sort().reverse()[0]
          possiblePaths.push(path.join(nvmDir, latestVersion, 'bin', 'node'))
        }
      } catch {
        //
      }
    }

    for (const possiblePath of possiblePaths) {
      if (possiblePath.includes('*')) {
        try {
          const dir = path.dirname(possiblePath)
          const pattern = path.basename(possiblePath)
          const entries = await fs.readdir(dir)

          for (const entry of entries) {
            const fullPath = path.join(dir, entry, pattern.replace('*', ''))
            try {
              await fs.access(fullPath, fs.constants.F_OK)

              if (platform === 'win32' || (await this.isExecutable(fullPath))) {
                return fullPath
              }
            } catch {
              continue
            }
          }
        } catch {
          continue
        }
      } else {
        try {
          await fs.access(possiblePath, fs.constants.F_OK)

          if (platform === 'win32' || (await this.isExecutable(possiblePath))) {
            return possiblePath
          }
        } catch {
          continue
        }
      }
    }

    return null
  }

  private async isExecutable(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }

  private async getBundledPrismaPath(): Promise<string> {
    const isPackaged = process.resourcesPath !== undefined
    let prismaCliPath: string

    if (isPackaged) {
      prismaCliPath = path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        'prisma',
        'build',
        'index.js'
      )
    } else {
      prismaCliPath = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
    }

    await fs.access(prismaCliPath)

    const nodePath = await this.getBinaryPath('node')
    return `"${nodePath}" "${prismaCliPath}"`
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

  async verifyNode(): Promise<{
    available: boolean
    message: string
    path?: string
    version?: string
  }> {
    try {
      const nodePath = await this.getBinaryPath('node')

      try {
        const { stdout } = await execAsync(`"${nodePath}" --version`, {
          env: this.getEnhancedEnv()
        } as any)

        const version = stdout.toString().trim()

        return {
          available: true,
          message: `Node.js ${version} encontrado`,
          path: nodePath,
          version
        }
      } catch {
        return {
          available: true,
          message: 'Node.js encontrado',
          path: nodePath
        }
      }
    } catch (error) {
      console.error('Erro ao buscar Node.js:', error)
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
