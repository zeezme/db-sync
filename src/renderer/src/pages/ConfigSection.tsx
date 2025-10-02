import React, { useEffect, useState, useRef } from 'react'
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
import { X } from 'lucide-react'

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
  const [logs, setLogs] = useState<string[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const logsEndRef = useRef<HTMLDivElement>(null)

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

  // Auto-scroll para o final dos logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // Escuta eventos de logs do backend (sincronização e migrations)
  useEffect(() => {
    const handleLog = (_event: any, log: string) => {
      setLogs((prev) => [...prev, log])
    }

    const handleSyncStart = () => {
      setIsRunning(true)
    }

    const handleSyncEnd = () => {
      setIsRunning(false)
    }

    window.electron.ipcRenderer.on('sync-log', handleLog)
    window.electron.ipcRenderer.on('sync-start', handleSyncStart)
    window.electron.ipcRenderer.on('sync-end', handleSyncEnd)

    return () => {
      window.electron.ipcRenderer.removeListener('sync-log', handleLog)
      window.electron.ipcRenderer.removeListener('sync-start', handleSyncStart)
      window.electron.ipcRenderer.removeListener('sync-end', handleSyncEnd)
    }
  }, [])

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

  const saveConfig = handleSubmit((data) => {
    const config: SyncConfig = {
      sourceUrl: data.sourceUrl,
      targetUrl: data.targetUrl,
      intervalMinutes: data.intervalMinutes,
      excludeTables: data.excludeTables
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    }
    dbSync.saveConfig(config)
    toast.success('Configuração salva!')
  })

  const startSync = handleSubmit((data) => {
    const config: SyncConfig = {
      sourceUrl: data.sourceUrl,
      targetUrl: data.targetUrl,
      intervalMinutes: data.intervalMinutes,
      excludeTables: data.excludeTables
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    }
    dbSync.startSync(config)
  })

  const stopSync = () => dbSync.stopSync()
  const triggerSync = () => dbSync.triggerSync()

  const testConnection = (type: 'source' | 'target') => {
    const url = type === 'source' ? watch('sourceUrl') : watch('targetUrl')
    const label = type === 'source' ? 'origem' : 'destino'

    dbSync.testConnection(url).then((res) => {
      if (res.success) {
        toast.success(`Conexão ${label} OK!`)
      } else {
        toast.error(`Erro na conexão ${label}: ${res.error}`)
      }
    })
  }

  const runMigrations = async () => {
    const { backendDir, targetUrl } = watch()

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
  }

  const clearLogs = () => {
    setLogs([])
  }

  return (
    <FormProvider {...methods}>
      <div className="flex gap-4 overflow-auto h-[650px] w-full">
        <Card className="w-full">
          <CardHeader>
            <div className="flex justify-between items-center">
              <CardTitle>⚙️ Configurações</CardTitle>

              <Button
                variant="ghost"
                className="hover:bg-transparent text-red-500 hover:text-red-700 hover:scale-105"
                onClick={async () => await window.electron.ipcRenderer.invoke('close-window')}
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

              <Button variant="outline" onClick={() => testConnection('source')}>
                Testar Conexão
              </Button>
            </div>

            <div className="flex gap-2 items-end">
              <InputForm
                name="targetUrl"
                label="Banco de Destino (LOCAL)"
                placeholder="postgresql://user:pass@localhost:5432/database"
              />

              <Button variant="outline" onClick={() => testConnection('target')}>
                Testar Conexão
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
            <Button onClick={saveConfig}>💾 Salvar Configuração</Button>

            <Button variant="secondary" onClick={startSync}>
              ▶️ Iniciar Sincronização
            </Button>

            <Button variant="destructive" onClick={stopSync}>
              ⏹️ Parar
            </Button>

            <Button variant="outline" onClick={triggerSync}>
              ⚡ Sincronizar Agora
            </Button>

            <Button variant="secondary" onClick={runMigrations} disabled={isRunning}>
              🛠️ Rodar Migrations
            </Button>
          </CardFooter>
        </Card>

        <Card className="flex flex-col w-full">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-base font-medium">
              📋 Logs
              {isRunning && (
                <span className="ml-2 text-sm text-blue-500 animate-pulse">• Executando...</span>
              )}
            </CardTitle>
            <Button size="sm" variant="outline" onClick={clearLogs}>
              🗑️ Limpar
            </Button>
          </CardHeader>

          <CardContent className="p-0">
            <div className="h-[400px] overflow-y-auto bg-slate-950 text-green-400 font-mono text-xs p-4 rounded-b-lg">
              {logs.length === 0 ? (
                <div className="text-slate-500 italic">Aguardando operações...</div>
              ) : (
                logs.map((log, index) => (
                  <div key={index} className="whitespace-pre-wrap break-words mb-1">
                    {log}
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </CardContent>
        </Card>
      </div>
    </FormProvider>
  )
}

export default ConfigSection
