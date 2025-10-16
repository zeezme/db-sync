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
import { Check, CloudCheck, Database, GitMerge, Notebook, Play, X } from 'lucide-react'
import { Spinner } from '@renderer/components/primitive/spinner'
import { InputListForm } from '@renderer/components/form/inputListForm'
import { ThemeToggler } from '@renderer/components/generic/themeToggler'
import { SwitchForm } from '@renderer/components/form/switchForm'

const STORAGE_KEY = 'dbsync-config'

const configSchema = z.object({
  sourceUrl: z.string().min(1, 'URL de origem é obrigatória'),
  targetUrl: z.string().min(1, 'URL de destino é obrigatória'),
  intervalMinutes: z.number().min(1, 'Mínimo 1 minuto').max(1440, 'Máximo 1440 minutos (24h)'),
  excludeTables: z.string(),
  backendDir: z.string(),
  sourceSSLEnabled: z.boolean(),
  targetSSLEnabled: z.boolean()
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
      backendDir: '',
      sourceSSLEnabled: true,
      targetSSLEnabled: true
    }
  })

  const { watch, setValue, handleSubmit, setError, control } = methods

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)

    if (saved) {
      try {
        const config: SyncConfig & {
          backendDir?: string
          sourceSSLEnabled?: boolean
          targetSSLEnabled?: boolean
        } = JSON.parse(saved)
        setValue('sourceUrl', config.sourceUrl || '')
        setValue('targetUrl', config.targetUrl || '')
        setValue('intervalMinutes', config.intervalMinutes || 120)
        setValue('excludeTables', (config.excludeTables || []).join(', '))
        setValue('backendDir', config.backendDir || '')
        setValue('sourceSSLEnabled', config.sourceSSLEnabled ?? true)
        setValue('targetSSLEnabled', config.targetSSLEnabled ?? true)
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
        backendDir: value.backendDir || '',
        sourceSSLEnabled: value.sourceSSLEnabled ?? true,
        targetSSLEnabled: value.targetSSLEnabled ?? true
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

    try {
      const config: SyncConfig = {
        sourceUrl: data.sourceUrl,
        targetUrl: data.targetUrl,
        intervalMinutes: data.intervalMinutes,
        excludeTables: data.excludeTables
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        sourceSSLEnabled: data.sourceSSLEnabled,
        targetSSLEnabled: data.targetSSLEnabled
      }

      const response = await dbSync.startSync(config)

      if (!response.success) {
        toast.error(`${response.error}`)

        setError('sourceUrl', {
          message: ''
        })

        setError('targetUrl', {
          message: ''
        })
      } else {
        await openLogsWindow()
      }
    } finally {
      setLoadingSync(false)
    }
  })

  const testConnection = async (type: 'source' | 'target') => {
    const url = type === 'source' ? watch('sourceUrl') : watch('targetUrl')
    const sslEnabled = type === 'source' ? watch('sourceSSLEnabled') : watch('targetSSLEnabled')
    const label = type === 'source' ? 'origem' : 'destino'
    const setLoading = type === 'source' ? setLoadingSourceTest : setLoadingTargetTest

    setLoading(true)

    try {
      const res = await dbSync.testConnection(url, sslEnabled)

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
                  <Database className="text-black dark:text-white" />
                  <GitMerge className="text-black dark:text-white" />
                  <p className="text-xl text-black dark:text-white">Windel Sync</p>
                </div>
              </CardTitle>

              <Button
                variant="ghost"
                className="hover:bg-transparent text-black hover:text-black hover:scale-105 dark:text-white dark:hover:bg-gray-500"
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
                control={control}
              />

              <div className="flex gap-2 justify-between items-center">
                <Button
                  variant="outline"
                  onClick={() => testConnection('source')}
                  disabled={loadingSourceTest || loadingSync}
                >
                  {loadingSourceTest ? (
                    <>
                      <Check /> <Spinner />
                    </>
                  ) : (
                    <Check size={20} />
                  )}
                </Button>

                <SwitchForm
                  label="SSL"
                  id="sourceSSLEnabled"
                  name="sourceSSLEnabled"
                  disabled={loadingSync}
                  control={control}
                />
              </div>
            </div>

            <div className="flex gap-2 items-end">
              <InputForm
                name="targetUrl"
                label="Banco de Destino (LOCAL)"
                placeholder="postgresql://user:pass@localhost:5432/database"
                disabled={loadingSync}
                control={control}
              />

              <div className="flex gap-2 justify-between items-center">
                <Button
                  variant="outline"
                  onClick={() => testConnection('target')}
                  disabled={loadingTargetTest || loadingSync}
                >
                  {loadingTargetTest ? (
                    <>
                      <Check /> <Spinner />
                    </>
                  ) : (
                    <Check size={20} />
                  )}
                </Button>

                <SwitchForm
                  label="SSL"
                  id="targetSSLEnabled"
                  name="targetSSLEnabled"
                  disabled={loadingSync}
                  control={control}
                />
              </div>
            </div>

            <InputForm
              name="intervalMinutes"
              label="Intervalo de Sincronização (min)"
              type="number"
              disabled={loadingSync}
              min={1}
              max={1440}
              control={control}
            />

            <InputListForm
              name="excludeTables"
              label="Tabelas que não serão sincronizadas"
              placeholder="Ex: migrations, schema_migrations"
              disabled={loadingSync}
              control={control}
            />

            <FileSelectorForm
              name="backendDir"
              label="Diretório do Backend"
              placeholder="/caminho/para/backend"
              mode="directory"
              buttonText="Procurar..."
              disabled={loadingSync}
              control={control}
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
                  <Play /> Iniciar Pull <Spinner />
                </>
              ) : (
                <>
                  <Play /> Iniciar Pull
                </>
              )}
            </Button>

            <Button
              variant="outline"
              onClick={runMigrations}
              disabled={loadingMigrations || loadingSync}
            >
              {loadingMigrations ? (
                <>
                  <Database /> Rodar Migrations <Spinner />
                </>
              ) : (
                <>
                  <Database /> Rodar Migrations
                </>
              )}
            </Button>

            <Button variant="outline" onClick={openLogsWindow} disabled={loadingLogs}>
              {loadingLogs ? (
                <Spinner />
              ) : (
                <>
                  <Notebook /> Logs
                </>
              )}
            </Button>

            <ThemeToggler />
          </CardFooter>
        </Card>
      </div>
    </FormProvider>
  )
}

export default ConfigSection
