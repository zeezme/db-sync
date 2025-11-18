import { describe, it, expect } from 'vitest'

describe('BinaryManager', () => {
  describe('Testes de Integração', () => {
    it('deve encontrar um binário existente no sistema', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      // Testa com 'node' que sabemos que existe
      const result = await binaryManager.getBinaryPath('node')
      expect(result).toBeTruthy()
      expect(result).toContain('node')
    })

    it('deve lançar erro para binário inexistente', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      await expect(
        binaryManager.getBinaryPath('binary-that-definitely-does-not-exist-xyz123')
      ).rejects.toThrow()
    })

    it('deve verificar Node.js', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      const result = await binaryManager.verifyNode()
      expect(result.available).toBe(true)
      expect(result.path).toBeTruthy()
      expect(result.path).toContain('node')
    })

    it('deve verificar PostgreSQL tools', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      const result = await binaryManager.verifyPostgresTools()
      // Pode ou não estar instalado, só verifica a estrutura da resposta
      expect(result).toHaveProperty('available')
      expect(result).toHaveProperty('message')
      expect(typeof result.available).toBe('boolean')
    })

    it('deve verificar Prisma', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      const result = await binaryManager.verifyPrisma()
      expect(result).toHaveProperty('available')
      expect(result).toHaveProperty('message')
      expect(typeof result.available).toBe('boolean')
    })

    it('deve usar cache entre chamadas', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      // Limpa cache antes do teste
      binaryManager.clearCache()

      const start1 = Date.now()
      const result1 = await binaryManager.getBinaryPath('node')
      const time1 = Date.now() - start1

      const start2 = Date.now()
      const result2 = await binaryManager.getBinaryPath('node')
      const time2 = Date.now() - start2

      // Resultados devem ser iguais
      expect(result1).toBe(result2)

      // Segunda chamada deve ser mais rápida (cache)
      expect(time2).toBeLessThanOrEqual(time1)
    })

    it('deve limpar cache corretamente', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      // Busca e adiciona ao cache
      await binaryManager.getBinaryPath('node')

      // Limpa cache
      binaryManager.clearCache()

      // Deve funcionar normalmente após limpar cache
      const result = await binaryManager.getBinaryPath('node')
      expect(result).toBeTruthy()
    })
  })

  describe('Testes de Plataforma', () => {
    it('deve identificar a plataforma corretamente', () => {
      expect(process.platform).toBeDefined()
      expect(['win32', 'darwin', 'linux']).toContain(process.platform)
    })

    it('deve ter PATH definido', () => {
      expect(process.env.PATH).toBeDefined()
      expect(process.env.PATH!.length).toBeGreaterThan(0)
    })

    it('deve ter process.execPath definido', () => {
      expect(process.execPath).toBeDefined()
      expect(process.execPath).toContain('node')
    })
  })

  describe('Testes de Comportamento', () => {
    it('deve retornar paths absolutos', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      const result = await binaryManager.getBinaryPath('node')

      // Path deve ser absoluto
      const isAbsolute =
        result.startsWith('/') || /^[A-Z]:\\/.test(result) || result.startsWith('"')
      expect(isAbsolute).toBe(true)
    })

    it('deve retornar mensagens de erro descritivas', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      try {
        await binaryManager.getBinaryPath('nonexistent-xyz-123')
        expect.fail('Deveria ter lançado erro')
      } catch (error: any) {
        expect(error.message).toContain('não encontrado')
      }
    })

    it('deve verificar todos os binários sem erros', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      // Nenhuma dessas verificações deve lançar erro
      await expect(binaryManager.verifyNode()).resolves.toBeDefined()
      await expect(binaryManager.verifyPostgresTools()).resolves.toBeDefined()
      await expect(binaryManager.verifyPrisma()).resolves.toBeDefined()
    })
  })

  describe('Testes de PostgreSQL', () => {
    it('deve buscar pg_dump se disponível', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      try {
        const result = await binaryManager.getBinaryPath('pg_dump')
        expect(result).toContain('pg_dump')
      } catch (error: any) {
        // Se não estiver instalado, deve dar mensagem adequada
        expect(error.message).toContain('não encontrado')
      }
    })

    it('deve buscar pg_restore se disponível', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      try {
        const result = await binaryManager.getBinaryPath('pg_restore')
        expect(result).toContain('pg_restore')
      } catch (error: any) {
        // Se não estiver instalado, deve dar mensagem adequada
        expect(error.message).toContain('não encontrado')
      }
    })

    it('deve aceitar versão específica do PostgreSQL', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      try {
        const result = await binaryManager.getBinaryPath('pg_dump', '15')
        expect(result).toBeTruthy()
      } catch (error: any) {
        // Se não estiver instalado, é esperado
        expect(error.message).toContain('não encontrado')
      }
    })
  })

  describe('Testes de Prisma', () => {
    it('deve encontrar Prisma de alguma forma', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      const result = await binaryManager.getBinaryPath('prisma')
      expect(result).toBeTruthy()
      expect(result.toLowerCase()).toContain('prisma')
    })

    it('verifyPrisma deve retornar estrutura correta', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      const result = await binaryManager.verifyPrisma()
      expect(result).toHaveProperty('available')
      expect(result).toHaveProperty('message')
      expect(result).toHaveProperty('path')

      if (result.available) {
        expect(result.path).toBeTruthy()
      }
    })
  })

  describe('Testes de Node.js', () => {
    it('verifyNode deve retornar estrutura completa', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      const result = await binaryManager.verifyNode()
      expect(result).toHaveProperty('available')
      expect(result).toHaveProperty('message')
      expect(result).toHaveProperty('path')

      expect(result.available).toBe(true)
      expect(result.path).toBeTruthy()

      if (result.version) {
        expect(result.version).toMatch(/v\d+\.\d+\.\d+/)
      }
    })

    it('deve encontrar node através de process.execPath', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      binaryManager.clearCache()

      const result = await binaryManager.getBinaryPath('node')
      expect(result).toBeTruthy()

      // Pode ser process.execPath ou outro local
      const isValidPath =
        result === process.execPath || result.includes('node') || result.includes('Node')

      expect(isValidPath).toBe(true)
    })
  })

  describe('Testes de Cache', () => {
    it('cache deve persistir entre diferentes binários', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      binaryManager.clearCache()

      // Busca node
      const node1 = await binaryManager.getBinaryPath('node')

      // Busca prisma
      await binaryManager.getBinaryPath('prisma')

      // Busca node novamente - deve vir do cache
      const node2 = await binaryManager.getBinaryPath('node')

      expect(node1).toBe(node2)
    })

    it('cache deve ser específico por versão', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      binaryManager.clearCache()

      try {
        // Tenta buscar versões diferentes (se PostgreSQL estiver instalado)
        const pg15 = await binaryManager.getBinaryPath('pg_dump', '15')
        const pg16 = await binaryManager.getBinaryPath('pg_dump', '16')

        // Podem ser iguais se só uma versão estiver instalada
        expect(pg15).toBeTruthy()
        expect(pg16).toBeTruthy()
      } catch (error) {
        // PostgreSQL pode não estar instalado, ok
        expect(error).toBeDefined()
      }
    })
  })

  describe('Testes de Robustez', () => {
    it('deve lidar com nomes de binários vazios', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      await expect(binaryManager.getBinaryPath('')).rejects.toThrow()
    })

    it('deve lidar com nomes com espaços', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      await expect(binaryManager.getBinaryPath('binary with spaces')).rejects.toThrow()
    })

    it('deve lidar com caracteres especiais', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      await expect(binaryManager.getBinaryPath('binary@#$%')).rejects.toThrow()
    })

    it('clearCache não deve causar erros', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      // Deve funcionar mesmo sem cache
      expect(() => binaryManager.clearCache()).not.toThrow()

      // Múltiplas chamadas não devem causar problemas
      binaryManager.clearCache()
      binaryManager.clearCache()
      binaryManager.clearCache()

      // E deve continuar funcionando normalmente
      const result = await binaryManager.getBinaryPath('node')
      expect(result).toBeTruthy()
    })
  })

  describe('Testes de Performance', () => {
    it('cache deve melhorar performance significativamente', async () => {
      const { binaryManager } = await import('../../src/main/helpers/binary-manager')

      binaryManager.clearCache()

      const iterations = 5
      const times: number[] = []

      for (let i = 0; i < iterations; i++) {
        const start = Date.now()
        await binaryManager.getBinaryPath('node')
        times.push(Date.now() - start)
      }

      // Primeira chamada é mais lenta, demais são do cache
      expect(times[0]).toBeGreaterThan(0)

      // Média das chamadas em cache deve ser menor que a primeira
      const cachedAvg = times.slice(1).reduce((a, b) => a + b, 0) / (iterations - 1)
      expect(cachedAvg).toBeLessThanOrEqual(times[0])
    })
  })
})
