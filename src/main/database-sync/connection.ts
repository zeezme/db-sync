import { Client, ClientConfig } from 'pg'

export function getConnectionParams(url: string, sslEnabled: boolean): ClientConfig {
  let urlObj: URL

  try {
    urlObj = new URL(url)
  } catch {
    throw new Error(
      `URL inválida: ${url}. Certifique-se de usar o formato correto: postgresql://user:password@host:port/database`
    )
  }

  // Validações adicionais
  if (!urlObj.hostname) {
    throw new Error(`URL sem hostname: ${url}`)
  }

  if (!urlObj.pathname || urlObj.pathname === '/') {
    throw new Error(`URL sem nome de database: ${url}`)
  }

  if (!urlObj.username) {
    throw new Error(`URL sem username: ${url}`)
  }

  const isLocalhost = urlObj.hostname.includes('localhost') || urlObj.hostname.includes('127.0.0.1')

  return {
    user: decodeURIComponent(urlObj.username),
    password: urlObj.password ? decodeURIComponent(urlObj.password) : '',
    host: urlObj.hostname,
    port: parseInt(urlObj.port) || 5432,
    database: urlObj.pathname.replace('/', ''),
    ssl: isLocalhost || !sslEnabled ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000
  }
}

export async function createClient(url: string, sslEnabled: boolean): Promise<Client> {
  let params: ClientConfig

  try {
    params = getConnectionParams(url, sslEnabled)
  } catch (error: any) {
    throw new Error(`Erro ao parsear URL de conexão: ${error.message}`)
  }

  if (!params.host || !params.database || !params.user) {
    throw new Error(
      `Parâmetros de conexão incompletos. Host: ${params.host}, DB: ${params.database}, User: ${params.user}`
    )
  }

  const client = new Client(params)

  const connectionTimeout = setTimeout(() => {
    client.end().catch(() => {})
  }, 30000)

  try {
    await client.connect()
    clearTimeout(connectionTimeout)
    await client.query('SELECT 1 as connectivity_test')
    return client
  } catch (error: any) {
    clearTimeout(connectionTimeout)
    await client.end().catch(() => {})

    // Mensagens de erro mais claras
    if (error.code === 'ENOTFOUND') {
      throw new Error(`Host não encontrado: ${params.host}`)
    } else if (error.code === 'ECONNREFUSED') {
      throw new Error(`Conexão recusada em ${params.host}:${params.port}`)
    } else if (error.code === '28P01') {
      throw new Error(`Falha na autenticação para usuário ${params.user}`)
    } else if (error.code === '3D000') {
      throw new Error(`Database "${params.database}" não existe`)
    } else {
      throw new Error(
        `Falha na conexão com ${params.host}:${params.port}/${params.database}: ${error.message} (código: ${error.code})`
      )
    }
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
