import React, { useEffect, useTransition } from 'react'
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
import { TextareaForm } from '@renderer/components/form/textAreaForm'
import { FileSelectorForm } from '@renderer/components/form/fileSelectorForm'
import { useToast } from '@renderer/components/provider/toastProvider'
import { Database, GitMerge, X } from 'lucide-react'
import { Spinner } from '@renderer/components/primitive/spinner'

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
  const [isPending, startTransition] = useTransition()

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

  const startSync = handleSubmit((data) => {
    startTransition(async () => {
      const config: SyncConfig = {
        sourceUrl: data.sourceUrl,
        targetUrl: data.targetUrl,
        intervalMinutes: data.intervalMinutes,
        excludeTables: data.excludeTables
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      }

      openLogsWindow()

      await dbSync.startSync(config)
    })
  })

  const testConnection = (type: 'source' | 'target') => {
    startTransition(async () => {
      const url = type === 'source' ? watch('sourceUrl') : watch('targetUrl')
      const label = type === 'source' ? 'origem' : 'destino'

      try {
        const res = await dbSync.testConnection(url)
        if (res.success) {
          toast.success(`Conexão ${label} OK!`)
        } else {
          toast.error(`Erro na conexão ${label}: ${res.error}`)
        }
      } catch (error) {
        toast.error(`Erro ao testar conexão ${label}: ${error}`)
      }
    })
  }

  const runMigrations = () => {
    startTransition(async () => {
      const { backendDir, targetUrl } = watch()

      openLogsWindow()

      if (!backendDir) {
        toast.warning('Informe o diretório do backend')
        return
      }

      toast.info('Aplicando migrations...')

      try {
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
      }
    })
  }

  const openLogsWindow = () => {
    startTransition(async () => {
      try {
        await window.electron.ipcRenderer.invoke('open-logs-window')
      } catch (error) {
        toast.error(`Erro ao abrir janela de logs: ${error}`)
      }
    })
  }

  const handleCloseWindow = () => {
    startTransition(async () => {
      try {
        await window.electron.ipcRenderer.invoke('close-window')
      } catch (error) {
        toast.error(`Erro ao fechar janela: ${error}`)
      }
    })
  }

  return (
    <FormProvider {...methods}>
      <div className="flex gap-4 overflow-auto h-[650px] w-[1000px]">
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
                disabled={isPending}
              >
                <X />
              </Button>
            </div>
          </CardHeader>

          <CardContent className="flex flex-col gap-2">
            <div className="flex gap-2 items-end">
              <InputForm
                name="sourceUrl"
                label="Banco de Origem (DEV)"
                placeholder="postgresql://user:pass@host:5432/database"
              />

              <Button
                variant="outline"
                onClick={() => testConnection('source')}
                disabled={isPending}
              >
                {isPending ? <Spinner /> : 'Testar Conexão'}
              </Button>
            </div>

            <div className="flex gap-2 items-end">
              <InputForm
                name="targetUrl"
                label="Banco de Destino (LOCAL)"
                placeholder="postgresql://user:pass@localhost:5432/database"
              />

              <Button
                variant="outline"
                onClick={() => testConnection('target')}
                disabled={isPending}
              >
                {isPending ? <Spinner /> : 'Testar Conexão'}
              </Button>
            </div>

            <InputForm
              name="intervalMinutes"
              label="Intervalo de Sincronização (min)"
              type="number"
              min={1}
              max={1440}
            />

            <TextareaForm
              name="excludeTables"
              label="Tabelas para Excluir"
              placeholder="Ex: migrations, schema_migrations"
              helperText="Separe por vírgulas"
              className="min-h-[80px] resize-none"
            />

            <FileSelectorForm
              name="backendDir"
              label="Diretório do Backend"
              placeholder="/caminho/para/backend"
              helperText="Diretório contendo o arquivo prisma/schema.prisma"
              mode="directory"
              buttonText="Procurar..."
            />
          </CardContent>

          <CardFooter className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={startSync} disabled={isPending}>
              {isPending ? <Spinner /> : '▶️ Iniciar Pull'}
            </Button>

            <Button variant="outline" onClick={runMigrations} disabled={isPending}>
              {isPending ? <Spinner /> : '🛠️ Rodar Migrations'}
            </Button>

            <Button variant="outline" onClick={openLogsWindow} disabled={isPending}>
              {isPending ? <Spinner /> : '📋 Abrir Logs'}
            </Button>
          </CardFooter>
        </Card>
      </div>
    </FormProvider>
  )
}

export default ConfigSection
