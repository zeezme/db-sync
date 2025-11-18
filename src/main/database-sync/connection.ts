import { Client, ClientConfig } from 'pg'

export function getConnectionParams(url: string, sslEnabled: boolean): ClientConfig {
  try {
    const urlObj = new URL(url)

    const isLocalhost =
      urlObj.hostname.includes('localhost') || urlObj.hostname.includes('127.0.0.1')

    return {
      user: decodeURIComponent(urlObj.username),
      password: decodeURIComponent(urlObj.password),
      host: urlObj.hostname,
      port: parseInt(urlObj.port) || 5432,
      database: urlObj.pathname.replace('/', ''),
      ssl: isLocalhost || !sslEnabled ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 30000
    }
  } catch (error) {
    throw new Error(`Erro ao analisar URL do banco de dados (${url}): ${error}`)
  }
}

export async function createClient(url: string, sslEnabled: boolean): Promise<Client> {
  const params = getConnectionParams(url, sslEnabled)

  if (!params.host || !params.database || !params.user) {
    throw new Error('Parâmetros de conexão incompletos')
  }

  const client = new Client(params)

  const connectionTimeout = setTimeout(() => {
    client.end().catch(() => {})

    throw new Error('Timeout na conexão com o banco de dados (30s)')
  }, 30000)

  try {
    await client.connect()

    clearTimeout(connectionTimeout)

    await client.query('SELECT 1 as connectivity_test')
    return client
  } catch (error) {
    clearTimeout(connectionTimeout)

    await client.end().catch(() => {})

    throw new Error(`Falha na conexão com ${url}: ${error}`)
  }
}

export async function validateDatabaseConnection(
  url: string,
  sslEnabled: boolean,
  log: (message: string) => void
): Promise<boolean> {
  try {
    const client = await createClient(url, sslEnabled)
    const result = await client.query('SELECT current_database() as db_name')

    const parsed = new URL(url)
    if (parsed.password) parsed.password = '****'

    log(`✓ Conexão válida com ${parsed.host}/${result.rows[0].db_name}`)

    await client.end()

    return true
  } catch (error: any) {
    const host = (() => {
      try {
        return new URL(url).host
      } catch {
        return url
      }
    })()

    log(`✗ Falha na conexão com ${host}: ${error.message || error}`)

    return false
  }
}
