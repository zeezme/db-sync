import { beforeAll, afterAll, vi } from 'vitest'

beforeAll(() => {
  console.log('🐳 Iniciando ambiente de testes com containers...')
  vi.setConfig({
    testTimeout: 120000,
    hookTimeout: 120000
  })
})

afterAll(() => {
  console.log('🏁 Todos os testes finalizados')
})
