import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'pg'
import { DatabaseSync, SyncConfig } from '../../src/main/database-sync'
import { GenericContainer, StartedTestContainer } from 'testcontainers'

describe('DatabaseSync', () => {
  let sourceContainer: StartedTestContainer
  let targetContainer: StartedTestContainer
  let sourceUrl: string
  let targetUrl: string
  let sourceClient: Client
  let targetClient: Client
  const logs: string[] = []

  const logCallback = (log: string) => {
    logs.push(log)
    console.log(log)
  }

  beforeAll(async () => {
    // Iniciar containers PostgreSQL para origem e destino
    console.log('Iniciando containers PostgreSQL...')

    sourceContainer = await new GenericContainer('postgres:17.5-alpine')
      .withEnvironment({
        POSTGRES_USER: 'testuser',
        POSTGRES_PASSWORD: 'testpass',
        POSTGRES_DB: 'sourcedb'
      })
      .withExposedPorts(5432)
      .start()

    targetContainer = await new GenericContainer('postgres:17.5-alpine')
      .withEnvironment({
        POSTGRES_USER: 'testuser',
        POSTGRES_PASSWORD: 'testpass',
        POSTGRES_DB: 'targetdb'
      })
      .withExposedPorts(5432)
      .start()

    const sourcePort = sourceContainer.getMappedPort(5432)
    const targetPort = targetContainer.getMappedPort(5432)

    sourceUrl = `postgresql://testuser:testpass@localhost:${sourcePort}/sourcedb`
    targetUrl = `postgresql://testuser:testpass@localhost:${targetPort}/targetdb`

    console.log(`Source DB: ${sourceUrl}`)
    console.log(`Target DB: ${targetUrl}`)

    // Aguardar bancos de dados ficarem prontos
    await new Promise((resolve) => setTimeout(resolve, 2000))

    sourceClient = new Client({ connectionString: sourceUrl })
    targetClient = new Client({ connectionString: targetUrl })

    await sourceClient.connect()
    await targetClient.connect()

    console.log('✓ Containers PostgreSQL prontos')
  }, 120000)

  afterAll(async () => {
    await sourceClient?.end()
    await targetClient?.end()
    await sourceContainer?.stop()
    await targetContainer?.stop()
  })

  beforeEach(() => {
    logs.length = 0
  })

  describe('Validação de Configuração', () => {
    it('deve lançar erro para URL de origem inválida', () => {
      expect(() => {
        new DatabaseSync(
          {
            sourceUrl: 'invalid-url',
            targetUrl: 'postgresql://localhost/test',
            intervalMinutes: 1,
            excludeTables: []
          },
          logCallback
        )
      }).toThrow('sourceUrl deve ser uma URL PostgreSQL válida')
    })

    it('deve lançar erro para URL de destino inválida', () => {
      expect(() => {
        new DatabaseSync(
          {
            sourceUrl: 'postgresql://localhost/test',
            targetUrl: 'invalid-url',
            intervalMinutes: 1,
            excludeTables: []
          },
          logCallback
        )
      }).toThrow('targetUrl deve ser uma URL PostgreSQL válida')
    })

    it('deve lançar erro para intervalo inválido', () => {
      expect(() => {
        new DatabaseSync(
          {
            sourceUrl: 'postgresql://localhost/source',
            targetUrl: 'postgresql://localhost/target',
            intervalMinutes: 0,
            excludeTables: []
          },
          logCallback
        )
      }).toThrow('intervalMinutes deve ser pelo menos 1 minuto')
    })

    it('deve aceitar configuração válida', () => {
      expect(() => {
        new DatabaseSync(
          {
            sourceUrl: 'postgresql://localhost/source',
            targetUrl: 'postgresql://localhost/target',
            intervalMinutes: 5,
            excludeTables: ['test'],
            maxParallelTables: 3
          },
          logCallback
        )
      }).not.toThrow()
    })
  })

  describe('Sincronização Básica de Tabelas', () => {
    beforeEach(async () => {
      // Limpar tabelas existentes
      await sourceClient.query('DROP TABLE IF EXISTS usuarios CASCADE')
      await targetClient.query('DROP TABLE IF EXISTS usuarios CASCADE')
    })

    it('deve sincronizar tabela vazia', async () => {
      // Criar tabela na origem
      await sourceClient.query(`
        CREATE TABLE usuarios (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      // Criar mesma tabela no destino
      await targetClient.query(`
        CREATE TABLE usuarios (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      const config: SyncConfig = {
        sourceUrl,
        targetUrl,
        intervalMinutes: 1,
        excludeTables: []
      }

      const dbSync = new DatabaseSync(config, logCallback)
      await dbSync.syncNow()

      const result = await targetClient.query('SELECT COUNT(*) as count FROM usuarios')
      expect(parseInt(result.rows[0].count)).toBe(0)
    })

    it('deve sincronizar tabela com dados usando INSERT', async () => {
      // Criar e popular tabela de origem
      await sourceClient.query(`
        CREATE TABLE usuarios (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      await sourceClient.query(`
        INSERT INTO usuarios (nome, email) VALUES
        ('Alice', 'alice@exemplo.com'),
        ('Bob', 'bob@exemplo.com'),
        ('Carlos', 'carlos@exemplo.com')
      `)

      // Criar tabela vazia no destino
      await targetClient.query(`
        CREATE TABLE usuarios (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      const config: SyncConfig = {
        sourceUrl,
        targetUrl,
        intervalMinutes: 1,
        excludeTables: []
      }

      const dbSync = new DatabaseSync(config, logCallback)
      await dbSync.syncNow()

      const result = await targetClient.query('SELECT * FROM usuarios ORDER BY id')
      expect(result.rows).toHaveLength(3)
      expect(result.rows[0].nome).toBe('Alice')
      expect(result.rows[1].nome).toBe('Bob')
      expect(result.rows[2].nome).toBe('Carlos')
    })

    it('deve sincronizar tabela com UPSERT quando existem duplicatas', async () => {
      await sourceClient.query(`
        CREATE TABLE usuarios (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          idade INTEGER,
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      await sourceClient.query(`
        INSERT INTO usuarios (id, nome, email, idade) VALUES
        (1, 'Alice Atualizada', 'alice@exemplo.com', 30),
        (2, 'Bob Atualizado', 'bob@exemplo.com', 25),
        (3, 'Carlos', 'carlos@exemplo.com', 35)
      `)

      await targetClient.query(`
        CREATE TABLE usuarios (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          idade INTEGER,
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      await targetClient.query(`
        INSERT INTO usuarios (id, nome, email, idade) VALUES
        (1, 'Alice Antiga', 'alice@exemplo.com', 28),
        (2, 'Bob Antigo', 'bob@exemplo.com', 23)
      `)

      const config: SyncConfig = {
        sourceUrl,
        targetUrl,
        intervalMinutes: 1,
        excludeTables: []
      }

      const dbSync = new DatabaseSync(config, logCallback)
      await dbSync.syncNow()

      const result = await targetClient.query('SELECT * FROM usuarios ORDER BY id')
      expect(result.rows).toHaveLength(3)
      expect(result.rows[0].nome).toBe('Alice Atualizada')
      expect(result.rows[0].idade).toBe(30)
      expect(result.rows[1].nome).toBe('Bob Atualizado')
      expect(result.rows[1].idade).toBe(25)
      expect(result.rows[2].nome).toBe('Carlos')
      expect(result.rows[2].idade).toBe(35)

      const upsertLog = logs.find((log) => log.includes('UPSERT concluído'))
      expect(upsertLog).toBeDefined()
    })
  })

  describe('Compatibilidade de Colunas', () => {
    beforeEach(async () => {
      await sourceClient.query('DROP TABLE IF EXISTS produtos CASCADE')
      await targetClient.query('DROP TABLE IF EXISTS produtos CASCADE')
    })

    it('deve lidar com coluna extra na origem (SOURCE) - copiar ignorando coluna extra', async () => {
      await sourceClient.query(`
        CREATE TABLE produtos (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100),
          preco DECIMAL(10,2),
          descricao TEXT,           -- Coluna extra na origem
          categoria VARCHAR(50),    -- Coluna extra na origem
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      await sourceClient.query(`
        INSERT INTO produtos (nome, preco, descricao, categoria) VALUES
        ('Produto A', 19.99, 'Descrição detalhada A', 'Eletrônicos'),
        ('Produto B', 29.99, 'Descrição detalhada B', 'Casa')
      `)

      await targetClient.query(`
        CREATE TABLE produtos (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100),
          preco DECIMAL(10,2),
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      const config: SyncConfig = {
        sourceUrl,
        targetUrl,
        intervalMinutes: 1,
        excludeTables: []
      }

      const dbSync = new DatabaseSync(config, logCallback)
      await dbSync.syncNow()

      const result = await targetClient.query('SELECT * FROM produtos ORDER BY id')
      expect(result.rows).toHaveLength(2)

      expect(result.rows[0].nome).toBe('Produto A')
      expect(parseFloat(result.rows[0].preco)).toBe(19.99)
      expect(result.rows[1].nome).toBe('Produto B')
      expect(parseFloat(result.rows[1].preco)).toBe(29.99)

      expect(result.rows[0].descricao).toBeUndefined()
      expect(result.rows[0].categoria).toBeUndefined()

      const warningLog = logs.find((log) => log.includes('Colunas apenas no SOURCE'))
      expect(warningLog).toBeDefined()
    })

    it('deve lidar com coluna extra no destino (TARGET) - manter valor inalterado', async () => {
      await sourceClient.query(`
    CREATE TABLE produtos (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(100),
      preco DECIMAL(10,2)
    )
  `)

      await sourceClient.query(`
    INSERT INTO produtos (nome, preco) VALUES
    ('Produto C', 39.99),
    ('Produto D', 49.99)
  `)

      // Destino tem colunas extras
      await targetClient.query(`
    CREATE TABLE produtos (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(100),
      preco DECIMAL(10,2),
      estoque INTEGER DEFAULT 10,     -- Coluna extra com valor padrão
      ativo BOOLEAN DEFAULT true,     -- Coluna extra com valor padrão
      categoria VARCHAR(50)           -- Coluna extra sem valor padrão
    )
  `)

      // **INSERIR DADOS INICIAIS NO TARGET** para verificar que não são alterados
      await targetClient.query(`
    INSERT INTO produtos (id, nome, preco, estoque, ativo, categoria) VALUES
    (1, 'Nome Antigo C', 0, 5, false, 'Categoria Antiga C'),
    (2, 'Nome Antigo D', 0, 8, false, 'Categoria Antiga D')
  `)

      const config: SyncConfig = {
        sourceUrl,
        targetUrl,
        intervalMinutes: 1,
        excludeTables: []
      }

      const dbSync = new DatabaseSync(config, logCallback)
      await dbSync.syncNow()

      const result = await targetClient.query('SELECT * FROM produtos ORDER BY id')
      expect(result.rows).toHaveLength(2)

      // Verificar se dados das colunas COMUNS foram atualizados
      expect(result.rows[0].nome).toBe('Produto C')
      expect(parseFloat(result.rows[0].preco)).toBe(39.99)
      expect(result.rows[1].nome).toBe('Produto D')
      expect(parseFloat(result.rows[1].preco)).toBe(49.99)

      expect(result.rows[0].estoque).toBe(5)
      expect(result.rows[0].ativo).toBe(false)
      expect(result.rows[0].categoria).toBe('Categoria Antiga C')

      expect(result.rows[1].estoque).toBe(8)
      expect(result.rows[1].ativo).toBe(false)
      expect(result.rows[1].categoria).toBe('Categoria Antiga D')

      const warningLog = logs.find((log) => log.includes('Colunas apenas no TARGET'))
      expect(warningLog).toBeDefined()
    })

    it('deve lidar com tipos de dados diferentes mantendo compatibilidade', async () => {
      await sourceClient.query(`
        CREATE TABLE dados_mistos (
          id SERIAL PRIMARY KEY,
          texto VARCHAR(200),
          numero INTEGER,
          decimal_val DECIMAL(8,3),
          data_val DATE,
          booleano BOOLEAN
        )
      `)

      await sourceClient.query(`
        INSERT INTO dados_mistos (texto, numero, decimal_val, data_val, booleano) VALUES
        ('Texto longo aqui', 100, 123.456, '2024-01-15', true),
        ('Outro texto', 200, 789.123, '2024-02-20', false)
      `)

      // Destino com tipos compatíveis mas não idênticos
      await targetClient.query(`
        CREATE TABLE dados_mistos (
          id SERIAL PRIMARY KEY,
          texto TEXT,                    -- VARCHAR -> TEXT (compatível)
          numero BIGINT,                 -- INTEGER -> BIGINT (compatível)
          decimal_val DECIMAL(10,2),     -- DECIMAL(8,3) -> DECIMAL(10,2) (compatível)
          data_val TIMESTAMP,            -- DATE -> TIMESTAMP (compatível)
          booleano BOOLEAN
        )
      `)

      const config: SyncConfig = {
        sourceUrl,
        targetUrl,
        intervalMinutes: 1,
        excludeTables: []
      }

      const dbSync = new DatabaseSync(config, logCallback)
      await dbSync.syncNow()

      const result = await targetClient.query('SELECT * FROM dados_mistos ORDER BY id')
      expect(result.rows).toHaveLength(2)

      // Verificar se dados foram convertidos corretamente
      expect(result.rows[0].texto).toBe('Texto longo aqui')
      expect(parseInt(result.rows[0].numero)).toBe(100)
      expect(parseFloat(result.rows[0].decimal_val)).toBeCloseTo(123.46, 1) // Arredondamento
      expect(result.rows[0].booleano).toBe(true)
    })
  })

  describe('Exclusão de Tabelas', () => {
    beforeEach(async () => {
      await sourceClient.query('DROP TABLE IF EXISTS dados_publicos CASCADE')
      await sourceClient.query('DROP TABLE IF EXISTS dados_privados CASCADE')
      await targetClient.query('DROP TABLE IF EXISTS dados_publicos CASCADE')
      await targetClient.query('DROP TABLE IF EXISTS dados_privados CASCADE')
    })

    it('deve excluir tabelas da sincronização', async () => {
      // Criar tabelas na origem
      await sourceClient.query(`
        CREATE TABLE dados_publicos (
          id SERIAL PRIMARY KEY,
          valor VARCHAR(100)
        )
      `)

      await sourceClient.query(`
        CREATE TABLE dados_privados (
          id SERIAL PRIMARY KEY,
          segredo VARCHAR(100)
        )
      `)

      await sourceClient.query("INSERT INTO dados_publicos (valor) VALUES ('publico')")
      await sourceClient.query("INSERT INTO dados_privados (segredo) VALUES ('secreto')")

      // Criar tabelas no destino
      await targetClient.query(`
        CREATE TABLE dados_publicos (
          id SERIAL PRIMARY KEY,
          valor VARCHAR(100)
        )
      `)

      await targetClient.query(`
        CREATE TABLE dados_privados (
          id SERIAL PRIMARY KEY,
          segredo VARCHAR(100)
        )
      `)

      const config: SyncConfig = {
        sourceUrl,
        targetUrl,
        intervalMinutes: 1,
        excludeTables: ['dados_privados']
      }

      const dbSync = new DatabaseSync(config, logCallback)
      await dbSync.syncNow()

      const publicResult = await targetClient.query('SELECT COUNT(*) as count FROM dados_publicos')
      const privateResult = await targetClient.query('SELECT COUNT(*) as count FROM dados_privados')

      expect(parseInt(publicResult.rows[0].count)).toBe(1)
      expect(parseInt(privateResult.rows[0].count)).toBe(0)

      const skipLog = logs.find((log) => log.includes('Pulando inserção de dados para tabelas'))
      expect(skipLog).toContain('dados_privados')
    })
  })

  describe('Manipulação de Grande Volume de Dados', () => {
    beforeEach(async () => {
      await sourceClient.query('DROP TABLE IF EXISTS tabela_grande CASCADE')
      await targetClient.query('DROP TABLE IF EXISTS tabela_grande CASCADE')
    })

    it('deve sincronizar grande volume de dados com processamento em lote', async () => {
      await sourceClient.query(`
        CREATE TABLE tabela_grande (
          id SERIAL PRIMARY KEY,
          dados VARCHAR(100),
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      await targetClient.query(`
        CREATE TABLE tabela_grande (
          id SERIAL PRIMARY KEY,
          dados VARCHAR(100),
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

      // Inserir 1000 registros
      const values = Array.from({ length: 1000 }, (_, i) => `('dados_${i}')`).join(',')
      await sourceClient.query(`INSERT INTO tabela_grande (dados) VALUES ${values}`)

      const config: SyncConfig = {
        sourceUrl,
        targetUrl,
        intervalMinutes: 1,
        excludeTables: []
      }

      const dbSync = new DatabaseSync(config, logCallback)
      await dbSync.syncNow()

      const result = await targetClient.query('SELECT COUNT(*) as count FROM tabela_grande')
      expect(parseInt(result.rows[0].count)).toBe(1000)
    }, 30000)
  })

  describe('Manipulação de Chaves Estrangeiras', () => {
    beforeEach(async () => {
      await sourceClient.query('DROP TABLE IF EXISTS pedidos CASCADE')
      await sourceClient.query('DROP TABLE IF EXISTS clientes CASCADE')
      await targetClient.query('DROP TABLE IF EXISTS pedidos CASCADE')
      await targetClient.query('DROP TABLE IF EXISTS clientes CASCADE')
    })

    it('deve lidar com tabelas com chaves estrangeiras', async () => {
      // Criar tabelas com FK na origem
      await sourceClient.query(`
        CREATE TABLE clientes (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100)
        )
      `)

      await sourceClient.query(`
        CREATE TABLE pedidos (
          id SERIAL PRIMARY KEY,
          cliente_id INTEGER REFERENCES clientes(id),
          valor DECIMAL(10,2)
        )
      `)

      await sourceClient.query(`
        INSERT INTO clientes (id, nome) VALUES (1, 'Cliente A'), (2, 'Cliente B')
      `)

      await sourceClient.query(`
        INSERT INTO pedidos (cliente_id, valor) VALUES (1, 100.00), (2, 200.00)
      `)

      // Criar mesma estrutura no destino
      await targetClient.query(`
        CREATE TABLE clientes (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100)
        )
      `)

      await targetClient.query(`
        CREATE TABLE pedidos (
          id SERIAL PRIMARY KEY,
          cliente_id INTEGER REFERENCES clientes(id),
          valor DECIMAL(10,2)
        )
      `)

      const config: SyncConfig = {
        sourceUrl,
        targetUrl,
        intervalMinutes: 1,
        excludeTables: []
      }

      const dbSync = new DatabaseSync(config, logCallback)
      await dbSync.syncNow()

      const clientesResult = await targetClient.query('SELECT COUNT(*) as count FROM clientes')
      const pedidosResult = await targetClient.query('SELECT COUNT(*) as count FROM pedidos')

      expect(parseInt(clientesResult.rows[0].count)).toBe(2)
      expect(parseInt(pedidosResult.rows[0].count)).toBe(2)

      // Verificar se triggers foram desabilitados
      const disableTriggersLog = logs.find((log) =>
        log.includes('Desabilitando triggers de foreign key')
      )
      expect(disableTriggersLog).toBeDefined()
    })
  })

  describe('Acompanhamento de Progresso', () => {
    it('deve acompanhar o progresso da sincronização', async () => {
      await sourceClient.query('DROP TABLE IF EXISTS teste_progresso CASCADE')
      await targetClient.query('DROP TABLE IF EXISTS teste_progresso CASCADE')

      await sourceClient.query(`
        CREATE TABLE teste_progresso (
          id SERIAL PRIMARY KEY,
          valor VARCHAR(100)
        )
      `)

      await targetClient.query(`
        CREATE TABLE teste_progresso (
          id SERIAL PRIMARY KEY,
          valor VARCHAR(100)
        )
      `)

      await sourceClient.query("INSERT INTO teste_progresso (valor) VALUES ('teste')")

      const config: SyncConfig = {
        sourceUrl,
        targetUrl,
        intervalMinutes: 1,
        excludeTables: []
      }

      const dbSync = new DatabaseSync(config, logCallback)

      // Verificar progresso inicial
      let progresso = dbSync.getCurrentProgress()
      expect(progresso.status).toBe('starting')
      expect(progresso.percentage).toBe(0)

      await dbSync.syncNow()

      // Verificar progresso final
      progresso = dbSync.getCurrentProgress()
      expect(progresso.status).toBe('completed')
      expect(progresso.percentage).toBe(100)
    })
  })

  describe('Tratamento de Erros', () => {
    it('deve lidar com falhas de conexão graciosamente', async () => {
      const config: SyncConfig = {
        sourceUrl: 'postgresql://invalido:invalido@localhost:9999/invalido',
        targetUrl,
        intervalMinutes: 1,
        excludeTables: []
      }

      const dbSync = new DatabaseSync(config, logCallback)

      await expect(dbSync.syncNow()).rejects.toThrow()

      const errorLog = logs.find((log) => log.includes('Falha na conexão'))
      expect(errorLog).toBeDefined()
    })

    it('deve lidar com tabela não existente no destino', async () => {
      await sourceClient.query('DROP TABLE IF EXISTS apenas_na_origem CASCADE')

      await sourceClient.query(`
        CREATE TABLE apenas_na_origem (
          id SERIAL PRIMARY KEY,
          valor VARCHAR(100)
        )
      `)

      const config: SyncConfig = {
        sourceUrl,
        targetUrl,
        intervalMinutes: 1,
        excludeTables: []
      }

      const dbSync = new DatabaseSync(config, logCallback)
      await dbSync.syncNow()

      const warningLog = logs.find((log) => log.includes('não existe no destino'))
      expect(warningLog).toBeDefined()
    })

    it('deve lidar com erro durante UPSERT e continuar sincronização', async () => {
      await sourceClient.query('DROP TABLE IF EXISTS teste_erro CASCADE')
      await targetClient.query('DROP TABLE IF EXISTS teste_erro CASCADE')

      // Origem com dados válidos
      await sourceClient.query(`
        CREATE TABLE teste_erro (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100),
          email VARCHAR(100) UNIQUE
        )
      `)

      await sourceClient.query(`
        INSERT INTO teste_erro (nome, email) VALUES
        ('Usuario 1', 'user1@exemplo.com'),
        ('Usuario 2', 'user2@exemplo.com')
      `)

      // Destino com constraint que pode causar erro
      await targetClient.query(`
        CREATE TABLE teste_erro (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(50),  -- Coluna menor que na origem
          email VARCHAR(100) UNIQUE
        )
      `)

      const config: SyncConfig = {
        sourceUrl,
        targetUrl,
        intervalMinutes: 1,
        excludeTables: []
      }

      const dbSync = new DatabaseSync(config, logCallback)

      // A sincronização deve continuar mesmo com possíveis erros
      await expect(dbSync.syncNow()).resolves.not.toThrow()

      // Verificar se pelo menos alguns dados foram sincronizados
      const result = await targetClient.query('SELECT COUNT(*) as count FROM teste_erro')
      expect(parseInt(result.rows[0].count)).toBeGreaterThanOrEqual(0)
    })
  })

  describe('Cenários Avançados de Sincronização', () => {
    describe('Sincronização com Dependências Complexas', () => {
      beforeEach(async () => {
        await sourceClient.query('DROP TABLE IF EXISTS itens_pedido CASCADE')
        await sourceClient.query('DROP TABLE IF EXISTS pedidos CASCADE')
        await sourceClient.query('DROP TABLE IF EXISTS produtos CASCADE')
        await sourceClient.query('DROP TABLE IF EXISTS categorias CASCADE')
        await sourceClient.query('DROP TABLE IF EXISTS clientes CASCADE')

        await targetClient.query('DROP TABLE IF EXISTS itens_pedido CASCADE')
        await targetClient.query('DROP TABLE IF EXISTS pedidos CASCADE')
        await targetClient.query('DROP TABLE IF EXISTS produtos CASCADE')
        await targetClient.query('DROP TABLE IF EXISTS categorias CASCADE')
        await targetClient.query('DROP TABLE IF EXISTS clientes CASCADE')
      })

      it('deve sincronizar múltiplos níveis de dependências em ordem correta', async () => {
        // Criar estrutura complexa com múltiplas FKs
        await sourceClient.query(`
        CREATE TABLE clientes (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100) NOT NULL
        )
      `)

        await sourceClient.query(`
        CREATE TABLE categorias (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100) NOT NULL
        )
      `)

        await sourceClient.query(`
        CREATE TABLE produtos (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100) NOT NULL,
          categoria_id INTEGER REFERENCES categorias(id),
          preco DECIMAL(10,2)
        )
      `)

        await sourceClient.query(`
        CREATE TABLE pedidos (
          id SERIAL PRIMARY KEY,
          cliente_id INTEGER REFERENCES clientes(id),
          data_pedido DATE DEFAULT CURRENT_DATE
        )
      `)

        await sourceClient.query(`
        CREATE TABLE itens_pedido (
          id SERIAL PRIMARY KEY,
          pedido_id INTEGER REFERENCES pedidos(id),
          produto_id INTEGER REFERENCES produtos(id),
          quantidade INTEGER NOT NULL
        )
      `)

        // Popular dados
        await sourceClient.query(`
        INSERT INTO clientes (id, nome) VALUES
        (1, 'Cliente A'), (2, 'Cliente B')
      `)

        await sourceClient.query(`
        INSERT INTO categorias (id, nome) VALUES
        (1, 'Eletrônicos'), (2, 'Livros')
      `)

        await sourceClient.query(`
        INSERT INTO produtos (id, nome, categoria_id, preco) VALUES
        (1, 'Smartphone', 1, 999.99),
        (2, 'Tablet', 1, 499.99),
        (3, 'Livro A', 2, 29.99)
      `)

        await sourceClient.query(`
        INSERT INTO pedidos (id, cliente_id) VALUES
        (1, 1), (2, 2)
      `)

        await sourceClient.query(`
        INSERT INTO itens_pedido (pedido_id, produto_id, quantidade) VALUES
        (1, 1, 2), (1, 2, 1), (2, 3, 5)
      `)

        // Criar mesma estrutura no destino
        await targetClient.query(`
        CREATE TABLE clientes (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100) NOT NULL
        )
      `)

        await targetClient.query(`
        CREATE TABLE categorias (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100) NOT NULL
        )
      `)

        await targetClient.query(`
        CREATE TABLE produtos (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100) NOT NULL,
          categoria_id INTEGER REFERENCES categorias(id),
          preco DECIMAL(10,2)
        )
      `)

        await targetClient.query(`
        CREATE TABLE pedidos (
          id SERIAL PRIMARY KEY,
          cliente_id INTEGER REFERENCES clientes(id),
          data_pedido DATE DEFAULT CURRENT_DATE
        )
      `)

        await targetClient.query(`
        CREATE TABLE itens_pedido (
          id SERIAL PRIMARY KEY,
          pedido_id INTEGER REFERENCES pedidos(id),
          produto_id INTEGER REFERENCES produtos(id),
          quantidade INTEGER NOT NULL
        )
      `)

        const config: SyncConfig = {
          sourceUrl,
          targetUrl,
          intervalMinutes: 1,
          excludeTables: []
        }

        const dbSync = new DatabaseSync(config, logCallback)
        await dbSync.syncNow()

        // Verificar se todos os dados foram sincronizados
        const clientesCount = await targetClient.query('SELECT COUNT(*) FROM clientes')
        const categoriasCount = await targetClient.query('SELECT COUNT(*) FROM categorias')
        const produtosCount = await targetClient.query('SELECT COUNT(*) FROM produtos')
        const pedidosCount = await targetClient.query('SELECT COUNT(*) FROM pedidos')
        const itensCount = await targetClient.query('SELECT COUNT(*) FROM itens_pedido')

        expect(parseInt(clientesCount.rows[0].count)).toBe(2)
        expect(parseInt(categoriasCount.rows[0].count)).toBe(2)
        expect(parseInt(produtosCount.rows[0].count)).toBe(3)
        expect(parseInt(pedidosCount.rows[0].count)).toBe(2)
        expect(parseInt(itensCount.rows[0].count)).toBe(3)

        // Verificar logs de ordenação por dependência
        const dependencyLog = logs.find((log) => log.includes('ORDEM DE SINCRONIZAÇÃO'))
        expect(dependencyLog).toBeDefined()
      })
    })

    describe('Sincronização com Dados Binários e Especiais', () => {
      beforeEach(async () => {
        await sourceClient.query('DROP TABLE IF EXISTS dados_especiais CASCADE')
        await targetClient.query('DROP TABLE IF EXISTS dados_especiais CASCADE')
      })

      it('deve lidar com caracteres especiais e Unicode', async () => {
        await sourceClient.query(`
        CREATE TABLE dados_especiais (
          id SERIAL PRIMARY KEY,
          texto_unicode TEXT,
          caracteres_especiais TEXT,
          emojis TEXT
        )
      `)

        await sourceClient.query(`
        INSERT INTO dados_especiais (texto_unicode, caracteres_especiais, emojis) VALUES
        ('中文 Français Español', 'çáéíóú ñ ãõ', '😀 🚀 📚'),
        ('Русский язык 日本語', '°ºª§¬½¼', '❤️ ✅ ⚠️')
      `)

        await targetClient.query(`
        CREATE TABLE dados_especiais (
          id SERIAL PRIMARY KEY,
          texto_unicode TEXT,
          caracteres_especiais TEXT,
          emojis TEXT
        )
      `)

        const config: SyncConfig = {
          sourceUrl,
          targetUrl,
          intervalMinutes: 1,
          excludeTables: []
        }

        const dbSync = new DatabaseSync(config, logCallback)
        await dbSync.syncNow()

        const result = await targetClient.query('SELECT * FROM dados_especiais ORDER BY id')
        expect(result.rows).toHaveLength(2)
        expect(result.rows[0].texto_unicode).toBe('中文 Français Español')
        expect(result.rows[0].caracteres_especiais).toBe('çáéíóú ñ ãõ')
        expect(result.rows[0].emojis).toBe('😀 🚀 📚')
      })

      it('deve lidar com dados binários em colunas BYTEA', async () => {
        await sourceClient.query(`
        CREATE TABLE dados_binarios (
          id SERIAL PRIMARY KEY,
          nome_arquivo VARCHAR(100),
          conteudo BYTEA,
          tamanho INTEGER
        )
      `)

        // Inserir dados binários simulados
        const buffer = Buffer.from('conteúdo binário simulado', 'utf8')
        await sourceClient.query(
          'INSERT INTO dados_binarios (nome_arquivo, conteudo, tamanho) VALUES ($1, $2, $3)',
          ['arquivo.txt', buffer, buffer.length]
        )

        await targetClient.query(`
        CREATE TABLE dados_binarios (
          id SERIAL PRIMARY KEY,
          nome_arquivo VARCHAR(100),
          conteudo BYTEA,
          tamanho INTEGER
        )
      `)

        const config: SyncConfig = {
          sourceUrl,
          targetUrl,
          intervalMinutes: 1,
          excludeTables: []
        }

        const dbSync = new DatabaseSync(config, logCallback)
        await dbSync.syncNow()

        const result = await targetClient.query('SELECT * FROM dados_binarios')
        expect(result.rows).toHaveLength(1)
        expect(result.rows[0].nome_arquivo).toBe('arquivo.txt')
        expect(result.rows[0].tamanho).toBe(buffer.length)

        // Verificar se o conteúdo binário foi preservado
        const conteudoBinario = result.rows[0].conteudo
        expect(Buffer.isBuffer(conteudoBinario)).toBe(true)
        expect(conteudoBinario.toString('utf8')).toBe('conteúdo binário simulado')
      })
    })

    describe('Sincronização com Timestamps e Timezones', () => {
      beforeEach(async () => {
        await sourceClient.query('DROP TABLE IF EXISTS eventos CASCADE')
        await targetClient.query('DROP TABLE IF EXISTS eventos CASCADE')
      })

      it('deve preservar timestamps com timezones diferentes', async () => {
        await sourceClient.query(`
        CREATE TABLE eventos (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100),
          data_evento TIMESTAMP,
          data_evento_tz TIMESTAMPTZ,
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

        await sourceClient.query(`
        INSERT INTO eventos (nome, data_evento, data_evento_tz) VALUES
        ('Evento A', '2024-01-15 10:30:00', '2024-01-15 10:30:00-03'),
        ('Evento B', '2024-02-20 15:45:00', '2024-02-20 15:45:00+00')
      `)

        await targetClient.query(`
        CREATE TABLE eventos (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(100),
          data_evento TIMESTAMP,
          data_evento_tz TIMESTAMPTZ,
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

        const config: SyncConfig = {
          sourceUrl,
          targetUrl,
          intervalMinutes: 1,
          excludeTables: []
        }

        const dbSync = new DatabaseSync(config, logCallback)
        await dbSync.syncNow()

        const result = await targetClient.query('SELECT * FROM eventos ORDER BY id')
        expect(result.rows).toHaveLength(2)

        // Verificar se timestamps foram preservados
        expect(result.rows[0].data_evento.toISOString()).toContain('2024-01-15T10:30:00')
        expect(result.rows[1].data_evento.toISOString()).toContain('2024-02-20T15:45:00')
      })
    })

    describe('Sincronização com Valores Nulos e Defaults', () => {
      beforeEach(async () => {
        await sourceClient.query('DROP TABLE IF EXISTS teste_nulos CASCADE')
        await targetClient.query('DROP TABLE IF EXISTS teste_nulos CASCADE')
      })

      it('deve lidar corretamente com valores NULL e defaults', async () => {
        await sourceClient.query(`
        CREATE TABLE teste_nulos (
          id SERIAL PRIMARY KEY,
          valor_nao_nulo VARCHAR(100) NOT NULL,
          valor_nulo VARCHAR(100),
          numero_default INTEGER DEFAULT 42,
          booleano_nulo BOOLEAN,
          data_nula DATE
        )
      `)

        await sourceClient.query(`
        INSERT INTO teste_nulos (valor_nao_nulo, valor_nulo, numero_default, booleano_nulo, data_nula) VALUES
        ('Valor 1', NULL, DEFAULT, NULL, NULL),
        ('Valor 2', 'Preenchido', 100, true, '2024-01-01'),
        ('Valor 3', NULL, NULL, false, NULL)
      `)

        await targetClient.query(`
        CREATE TABLE teste_nulos (
          id SERIAL PRIMARY KEY,
          valor_nao_nulo VARCHAR(100) NOT NULL,
          valor_nulo VARCHAR(100),
          numero_default INTEGER DEFAULT 42,
          booleano_nulo BOOLEAN,
          data_nula DATE
        )
      `)

        const config: SyncConfig = {
          sourceUrl,
          targetUrl,
          intervalMinutes: 1,
          excludeTables: []
        }

        const dbSync = new DatabaseSync(config, logCallback)
        await dbSync.syncNow()

        const result = await targetClient.query('SELECT * FROM teste_nulos ORDER BY id')
        expect(result.rows).toHaveLength(3)

        // Verificar tratamento de NULLs
        expect(result.rows[0].valor_nulo).toBeNull()
        expect(result.rows[0].booleano_nulo).toBeNull()
        expect(result.rows[0].data_nula).toBeNull()

        expect(result.rows[1].valor_nulo).toBe('Preenchido')
        expect(result.rows[1].booleano_nulo).toBe(true)
        expect(result.rows[1].data_nula).toBeDefined()

        expect(result.rows[2].valor_nulo).toBeNull()
        expect(result.rows[2].booleano_nulo).toBe(false)
        expect(result.rows[2].data_nula).toBeNull()
      })
    })

    describe('Sincronização com Constraints Complexas', () => {
      beforeEach(async () => {
        await sourceClient.query('DROP TABLE IF EXISTS produtos_complexos CASCADE')
        await targetClient.query('DROP TABLE IF EXISTS produtos_complexos CASCADE')
      })

      it('deve lidar com unique constraints e check constraints', async () => {
        await sourceClient.query(`
        CREATE TABLE produtos_complexos (
          id SERIAL PRIMARY KEY,
          sku VARCHAR(50) UNIQUE NOT NULL,
          nome VARCHAR(100) NOT NULL,
          preco DECIMAL(10,2) CHECK (preco >= 0),
          estoque INTEGER CHECK (estoque >= 0),
          status VARCHAR(20) CHECK (status IN ('ativo', 'inativo', 'pendente'))
        )
      `)

        await sourceClient.query(`
        INSERT INTO produtos_complexos (sku, nome, preco, estoque, status) VALUES
        ('SKU001', 'Produto A', 19.99, 100, 'ativo'),
        ('SKU002', 'Produto B', 29.99, 50, 'ativo'),
        ('SKU003', 'Produto C', 0.00, 0, 'inativo')
      `)

        await targetClient.query(`
        CREATE TABLE produtos_complexos (
          id SERIAL PRIMARY KEY,
          sku VARCHAR(50) UNIQUE NOT NULL,
          nome VARCHAR(100) NOT NULL,
          preco DECIMAL(10,2) CHECK (preco >= 0),
          estoque INTEGER CHECK (estoque >= 0),
          status VARCHAR(20) CHECK (status IN ('ativo', 'inativo', 'pendente'))
        )
      `)

        const config: SyncConfig = {
          sourceUrl,
          targetUrl,
          intervalMinutes: 1,
          excludeTables: []
        }

        const dbSync = new DatabaseSync(config, logCallback)
        await dbSync.syncNow()

        const result = await targetClient.query('SELECT * FROM produtos_complexos ORDER BY id')
        expect(result.rows).toHaveLength(3)

        // Verificar se constraints foram respeitadas
        expect(result.rows[0].sku).toBe('SKU001')
        expect(parseFloat(result.rows[0].preco)).toBeGreaterThanOrEqual(0)
        expect(result.rows[0].estoque).toBeGreaterThanOrEqual(0)
        expect(['ativo', 'inativo', 'pendente']).toContain(result.rows[0].status)
      })
    })

    describe('Sincronização com Partições', () => {
      beforeEach(async () => {
        await sourceClient.query('DROP TABLE IF EXISTS vendas CASCADE')
        await targetClient.query('DROP TABLE IF EXISTS vendas CASCADE')
      })

      it('deve sincronizar tabelas particionadas', async () => {
        // Criar tabela particionada por mês
        await sourceClient.query(`
        CREATE TABLE vendas (
          id SERIAL,
          data_venda DATE NOT NULL,
          produto VARCHAR(100),
          valor DECIMAL(10,2),
          PRIMARY KEY (id, data_venda)
        ) PARTITION BY RANGE (data_venda)
      `)

        await sourceClient.query(`
        CREATE TABLE vendas_2024_01 PARTITION OF vendas
        FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')
      `)

        await sourceClient.query(`
        CREATE TABLE vendas_2024_02 PARTITION OF vendas
        FOR VALUES FROM ('2024-02-01') TO ('2024-03-01')
      `)

        await sourceClient.query(`
        INSERT INTO vendas (data_venda, produto, valor) VALUES
        ('2024-01-15', 'Produto A', 100.00),
        ('2024-01-20', 'Produto B', 200.00),
        ('2024-02-10', 'Produto C', 300.00)
      `)

        // Criar mesma estrutura no destino
        await targetClient.query(`
        CREATE TABLE vendas (
          id SERIAL,
          data_venda DATE NOT NULL,
          produto VARCHAR(100),
          valor DECIMAL(10,2),
          PRIMARY KEY (id, data_venda)
        ) PARTITION BY RANGE (data_venda)
      `)

        await targetClient.query(`
        CREATE TABLE vendas_2024_01 PARTITION OF vendas
        FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')
      `)

        await targetClient.query(`
        CREATE TABLE vendas_2024_02 PARTITION OF vendas
        FOR VALUES FROM ('2024-02-01') TO ('2024-03-01')
      `)

        const config: SyncConfig = {
          sourceUrl,
          targetUrl,
          intervalMinutes: 1,
          excludeTables: []
        }

        const dbSync = new DatabaseSync(config, logCallback)
        await dbSync.syncNow()

        const result = await targetClient.query('SELECT * FROM vendas ORDER BY data_venda')
        expect(result.rows).toHaveLength(3)

        // Verificar se dados foram distribuídos corretamente nas partições
        const countJan = await targetClient.query(
          "SELECT COUNT(*) FROM vendas_2024_01 WHERE data_venda < '2024-02-01'"
        )
        const countFeb = await targetClient.query(
          "SELECT COUNT(*) FROM vendas_2024_02 WHERE data_venda >= '2024-02-01'"
        )

        expect(parseInt(countJan.rows[0].count)).toBe(2)
        expect(parseInt(countFeb.rows[0].count)).toBe(1)
      })
    })

    describe('Sincronização com Performance', () => {
      beforeEach(async () => {
        await sourceClient.query('DROP TABLE IF EXISTS performance_test CASCADE')
        await targetClient.query('DROP TABLE IF EXISTS performance_test CASCADE')
      })

      it('deve processar lotes em paralelo conforme configuração', async () => {
        await sourceClient.query(`
        CREATE TABLE performance_test (
          id SERIAL PRIMARY KEY,
          data VARCHAR(100),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

        await targetClient.query(`
        CREATE TABLE performance_test (
          id SERIAL PRIMARY KEY,
          data VARCHAR(100),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

        // Inserir dados para testar paralelismo
        const batchSize = 50
        const values = Array.from({ length: batchSize }, (_, i) => `('dados_${i}')`).join(',')
        await sourceClient.query(`INSERT INTO performance_test (data) VALUES ${values}`)

        const config: SyncConfig = {
          sourceUrl,
          targetUrl,
          intervalMinutes: 1,
          excludeTables: [],
          maxParallelTables: 2 // Limitar paralelismo
        }

        const dbSync = new DatabaseSync(config, logCallback)

        await dbSync.syncNow()

        const result = await targetClient.query('SELECT COUNT(*) as count FROM performance_test')
        expect(parseInt(result.rows[0].count)).toBe(batchSize)

        // Verificar se o paralelismo foi aplicado (logs devem mostrar processamento em lote)
        const parallelLogs = logs.filter(
          (log) => log.includes('Processando nível') || log.includes('Batch:')
        )
        expect(parallelLogs.length).toBeGreaterThan(0)
      }, 30000)
    })

    describe('Sincronização com Rollback em Caso de Erro', () => {
      beforeEach(async () => {
        await sourceClient.query('DROP TABLE IF EXISTS teste_rollback CASCADE')
        await targetClient.query('DROP TABLE IF EXISTS teste_rollback CASCADE')
      })

      it('deve manter consistência quando ocorre erro durante sincronização', async () => {
        await sourceClient.query(`
        CREATE TABLE teste_rollback (
          id SERIAL PRIMARY KEY,
          valor VARCHAR(100)
        )
      `)

        await sourceClient.query(`
        INSERT INTO teste_rollback (valor) VALUES
        ('dado 1'), ('dado 2'), ('dado 3')
      `)

        // Destino com estrutura diferente que pode causar erro
        await targetClient.query(`
        CREATE TABLE teste_rollback (
          id SERIAL PRIMARY KEY,
          valor VARCHAR(10) -- Coluna menor que pode causar truncamento
        )
      `)

        const config: SyncConfig = {
          sourceUrl,
          targetUrl,
          intervalMinutes: 1,
          excludeTables: []
        }

        const dbSync = new DatabaseSync(config, logCallback)

        // A sincronização deve lidar com erros graciosamente
        await expect(dbSync.syncNow()).resolves.not.toThrow()

        // Verificar se pelo menos algumas operações foram completadas
        const result = await targetClient.query('SELECT COUNT(*) as count FROM teste_rollback')
        expect(parseInt(result.rows[0].count)).toBeGreaterThanOrEqual(0)

        // Verificar se há logs de erro
        const errorLogs = logs.filter(
          (log) => log.includes('falhou') || log.includes('erro') || log.includes('Erro')
        )
        expect(errorLogs.length).toBeGreaterThan(0)
      })
    })

    describe('Limpeza de Arquivos Temporários', () => {
      it('deve limpar arquivos temporários antigos', async () => {
        const config: SyncConfig = {
          sourceUrl,
          targetUrl,
          intervalMinutes: 1,
          excludeTables: []
        }

        const dbSync = new DatabaseSync(config, logCallback)

        // Executar limpeza
        await dbSync.cleanupOldFiles()

        const cleanupLog = logs.find((log) => log.includes('Limpeza concluída'))
        expect(cleanupLog).toBeDefined()
      })
    })

    describe('Validação de Conexão', () => {
      it('deve validar conexões com ambos os bancos', async () => {
        const config: SyncConfig = {
          sourceUrl,
          targetUrl,
          intervalMinutes: 1,
          excludeTables: []
        }

        const dbSync = new DatabaseSync(config, logCallback)

        // A validação ocorre durante getTables(), que é chamado por syncNow()
        await expect(dbSync.syncNow()).resolves.not.toThrow()

        const validationLogs = logs.filter(
          (log) => log.includes('Conexão válida') || log.includes('Encontradas')
        )
        expect(validationLogs.length).toBeGreaterThan(0)
      })
    })
  })

  describe('Testes de Stress e Edge Cases', () => {
    describe('Tabelas com Nomes Complexos', () => {
      it('deve lidar com nomes de tabelas com caracteres especiais', async () => {
        const tableName = 'tabela_com_underscores'

        await sourceClient.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`)
        await targetClient.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`)

        await sourceClient.query(`
        CREATE TABLE "${tableName}" (
          "id_col" SERIAL PRIMARY KEY,
          "nome_col" VARCHAR(100)
        )
      `)

        await sourceClient.query(`
        INSERT INTO "${tableName}" ("nome_col") VALUES ('teste')
      `)

        await targetClient.query(`
        CREATE TABLE "${tableName}" (
          "id_col" SERIAL PRIMARY KEY,
          "nome_col" VARCHAR(100)
        )
      `)

        const config: SyncConfig = {
          sourceUrl,
          targetUrl,
          intervalMinutes: 1,
          excludeTables: []
        }

        const dbSync = new DatabaseSync(config, logCallback)
        await dbSync.syncNow()

        const result = await targetClient.query(`SELECT COUNT(*) FROM "${tableName}"`)
        expect(parseInt(result.rows[0].count)).toBe(1)
      })
    })

    describe('Sincronização com Timeout', () => {
      it('deve lidar com timeouts de conexão', async () => {
        // Usar uma URL inválida para forçar timeout
        const invalidConfig: SyncConfig = {
          sourceUrl: 'postgresql://invalid:invalid@invalid-host:5432/invalid',
          targetUrl,
          intervalMinutes: 1,
          excludeTables: []
        }

        const dbSync = new DatabaseSync(invalidConfig, logCallback)

        await expect(dbSync.syncNow()).rejects.toThrow()

        const timeoutLog = logs.find((log) => log.includes('Timeout') || log.includes('timeout'))
        expect(timeoutLog).toBeDefined()
      })
    })

    describe('Múltiplas Execuções Sequenciais', () => {
      beforeEach(async () => {
        await sourceClient.query('DROP TABLE IF EXISTS teste_sequencial CASCADE')
        await targetClient.query('DROP TABLE IF EXISTS teste_sequencial CASCADE')
      })

      it('deve executar múltiplas sincronizações sequenciais corretamente', async () => {
        await sourceClient.query(`
        CREATE TABLE teste_sequencial (
          id SERIAL PRIMARY KEY,
          contador INTEGER,
          data_sincronizacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

        await targetClient.query(`
        CREATE TABLE teste_sequencial (
          id SERIAL PRIMARY KEY,
          contador INTEGER,
          data_sincronizacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)

        const config: SyncConfig = {
          sourceUrl,
          targetUrl,
          intervalMinutes: 1,
          excludeTables: []
        }

        const dbSync = new DatabaseSync(config, logCallback)

        // Primeira sincronização
        await sourceClient.query('INSERT INTO teste_sequencial (contador) VALUES (1)')
        await dbSync.syncNow()

        // Segunda sincronização com novos dados
        await sourceClient.query('INSERT INTO teste_sequencial (contador) VALUES (2)')
        await dbSync.syncNow()

        // Terceira sincronização
        await sourceClient.query('INSERT INTO teste_sequencial (contador) VALUES (3)')
        await dbSync.syncNow()

        const result = await targetClient.query('SELECT COUNT(*) as count FROM teste_sequencial')
        expect(parseInt(result.rows[0].count)).toBe(3)

        const syncLogs = logs.filter((log) => log.includes('SINCRONIZAÇÃO CONCLUÍDA'))
        expect(syncLogs).toHaveLength(3)
      })
    })
  })
})
