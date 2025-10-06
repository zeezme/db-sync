import React, { useEffect, useState } from 'react'
import { useForm, FormProvider } from 'react-hook-form'

import { dbSync, SyncConfig } from '../api/dbSync'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle
} from '@renderer/components/primitive/card'
import { Button } from '@renderer/components/primitive/button'
import { InputForm } from '@renderer/components/form/inputForm'
import { zodResolver } from '@hookform/resolvers/zod'

import z from 'zod'
import { FileSelectorForm } from '@renderer/components/form/fileSelectorForm'
import { useToast } from '@renderer/components/provider/toastProvider'
import { Database, GitMerge, X } from 'lucide-react'
import { Spinner } from '@renderer/components/primitive/spinner'
import { InputListForm } from '@renderer/components/form/inputListForm'

const STORAGE_KEY = 'dbsync-config'

const configSchema = z.object({
  sourceUrl: z.string().min(1, 'URL de origem é obrigatória'),
  targetUrl: z.string().min(1, 'URL de destino é obrigatória'),
  intervalMinutes: z.number().min(1, 'Mínimo 1 minuto').max(1440, 'Máximo 1440 minutos (24h)'),
  excludeTables: z.string(),
  backendDir: z.string()
})

type ConfigFormData = z.infer<typeof configSchema>

const ConfigSection: React.FC = () => {
  const toast = useToast()

  const [loadingSourceTest, setLoadingSourceTest] = useState(false)
  const [loadingTargetTest, setLoadingTargetTest] = useState(false)
  const [loadingSync, setLoadingSync] = useState(false)
  const [loadingMigrations, setLoadingMigrations] = useState(false)
  const [loadingLogs, setLoadingLogs] = useState(false)
  const [loadingClose, setLoadingClose] = useState(false)

  const methods = useForm<ConfigFormData>({
    resolver: zodResolver(configSchema),
    defaultValues: {
      sourceUrl: '',
      targetUrl: '',
      intervalMinutes: 120,
      excludeTables: '',
      backendDir: ''
    }
  })

  const { watch, setValue, handleSubmit } = methods

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)

    if (saved) {
      try {
        const config: SyncConfig & { backendDir?: string } = JSON.parse(saved)
        setValue('sourceUrl', config.sourceUrl || '')
        setValue('targetUrl', config.targetUrl || '')
        setValue('intervalMinutes', config.intervalMinutes || 120)
        setValue('excludeTables', (config.excludeTables || []).join(', '))
        setValue('backendDir', config.backendDir || '')
      } catch {
        console.warn('Config inválida no localStorage')
      }
    }
  }, [setValue])

  useEffect(() => {
    const subscription = watch((value) => {
      const config = {
        sourceUrl: value.sourceUrl || '',
        targetUrl: value.targetUrl || '',
        intervalMinutes: value.intervalMinutes || 120,
        excludeTables: (value.excludeTables || '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        backendDir: value.backendDir || ''
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
    })
    return () => subscription.unsubscribe()
  }, [watch])

  const openLogsWindow = async () => {
    setLoadingLogs(true)
    try {
      await window.electron.ipcRenderer.invoke('open-logs-window')
    } catch (error) {
      toast.error(`Erro ao abrir janela de logs: ${error}`)
    } finally {
      setLoadingLogs(false)
    }
  }

  const startSync = handleSubmit(async (data) => {
    setLoadingSync(true)

    await openLogsWindow()

    try {
      const config: SyncConfig = {
        sourceUrl: data.sourceUrl,
        targetUrl: data.targetUrl,
        intervalMinutes: data.intervalMinutes,
        excludeTables: data.excludeTables
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      }

      await dbSync.startSync(config)
    } finally {
      setLoadingSync(false)
    }
  })

  const testConnection = async (type: 'source' | 'target') => {
    const url = type === 'source' ? watch('sourceUrl') : watch('targetUrl')
    const label = type === 'source' ? 'origem' : 'destino'
    const setLoading = type === 'source' ? setLoadingSourceTest : setLoadingTargetTest

    setLoading(true)

    try {
      const res = await dbSync.testConnection(url)
      if (res.success) {
        toast.success(`Conexão ${label} OK!`)
      } else {
        toast.error(`Erro na conexão ${label}: ${res.error}`)
      }
    } catch (error) {
      toast.error(`Erro ao testar conexão ${label}: ${error}`)
    } finally {
      setLoading(false)
    }
  }

  const runMigrations = async () => {
    const { backendDir, targetUrl } = watch()

    openLogsWindow()

    setLoadingMigrations(true)

    try {
      if (!backendDir) {
        toast.warning('Informe o diretório do backend')
        return
      }

      toast.info('Aplicando migrations...')
      const res = await window.electron.ipcRenderer.invoke('run-prisma-migrations', {
        backendDir,
        targetUrl
      })

      if (res.success) {
        toast.success('Migrations aplicadas com sucesso!')
      } else {
        toast.error(`Erro ao aplicar migrations: ${res.error}`)
      }
    } catch (error) {
      toast.error(`Erro ao executar migrations: ${error}`)
    } finally {
      setLoadingMigrations(false)
    }
  }

  const handleCloseWindow = async () => {
    setLoadingClose(true)
    try {
      await window.electron.ipcRenderer.invoke('close-window')
    } catch (error) {
      toast.error(`Erro ao fechar janela: ${error}`)
    } finally {
      setLoadingClose(false)
    }
  }

  return (
    <FormProvider {...methods}>
      <div className="flex gap-4 overflow-auto h-screen w-screen">
        <Card className="w-full">
          <CardHeader style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
            <div className="flex justify-between items-center">
              <CardTitle>
                <div className="flex items-center gap-2">
                  <Database className="text-green-600" />
                  <GitMerge className="text-green-600" />
                  <p className="text-xl text-green-600">Windel Sync</p>
                </div>
              </CardTitle>

              <Button
                variant="ghost"
                className="hover:bg-transparent text-red-500 hover:text-red-700 hover:scale-105"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                onClick={handleCloseWindow}
                disabled={loadingClose}
              >
                {loadingClose ? <Spinner /> : <X />}
              </Button>
            </div>
          </CardHeader>

          <CardContent className="flex flex-col gap-2">
            <div className="flex gap-2 items-end">
              <InputForm
                name="sourceUrl"
                label="Banco de Origem (DEV)"
                placeholder="postgresql://user:pass@host:5432/database"
                disabled={loadingSync}
              />

              <Button
                variant="outline"
                onClick={() => testConnection('source')}
                disabled={loadingSourceTest || loadingSync}
              >
                {loadingSourceTest ? (
                  <>
                    Testar Conexão <Spinner />
                  </>
                ) : (
                  'Testar Conexão'
                )}
              </Button>
            </div>

            <div className="flex gap-2 items-end">
              <InputForm
                name="targetUrl"
                label="Banco de Destino (LOCAL)"
                placeholder="postgresql://user:pass@localhost:5432/database"
                disabled={loadingSync}
              />

              <Button
                variant="outline"
                onClick={() => testConnection('target')}
                disabled={loadingTargetTest || loadingSync}
              >
                {loadingTargetTest ? (
                  <>
                    Testar Conexão <Spinner />
                  </>
                ) : (
                  'Testar Conexão'
                )}
              </Button>
            </div>

            <InputForm
              name="intervalMinutes"
              label="Intervalo de Sincronização (min)"
              type="number"
              disabled={loadingSync}
              min={1}
              max={1440}
            />

            <InputListForm
              name="excludeTables"
              label="Tabelas que não serão sincronizadas"
              placeholder="Ex: migrations, schema_migrations"
              disabled={loadingSync}
            />

            <FileSelectorForm
              name="backendDir"
              label="Diretório do Backend"
              placeholder="/caminho/para/backend"
              mode="directory"
              buttonText="Procurar..."
              disabled={loadingSync}
            />
          </CardContent>

          <CardFooter className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={startSync}
              disabled={loadingSync || loadingMigrations}
            >
              {loadingSync ? (
                <>
                  ▶️ Iniciar Pull <Spinner />
                </>
              ) : (
                '▶️ Iniciar Pull'
              )}
            </Button>

            <Button
              variant="outline"
              onClick={runMigrations}
              disabled={loadingMigrations || loadingSync}
            >
              {loadingMigrations ? (
                <>
                  🛠️ Rodar Migrations <Spinner />
                </>
              ) : (
                '🛠️ Rodar Migrations'
              )}
            </Button>

            <Button variant="outline" onClick={openLogsWindow} disabled={loadingLogs}>
              {loadingLogs ? <Spinner /> : '📋 Abrir Logs'}
            </Button>
          </CardFooter>
        </Card>
      </div>
    </FormProvider>
  )
}

export default ConfigSection
