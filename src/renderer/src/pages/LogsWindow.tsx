import React, { useEffect, useState, useRef } from 'react'
import { Copy, X } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/primitive/card'
import { Button } from '@renderer/components/primitive/button'
import { useToast } from '@renderer/components/provider/toastProvider'

const LogsWindow: React.FC = () => {
  const toast = useToast()

  const [logs, setLogs] = useState<string[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const logsContainerRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)

  useEffect(() => {
    const loadSavedLogs = async () => {
      try {
        const result = await window.logsManager.getLogs()
        if (result) {
          console.log('[FRONTEND] Logs recuperados:', result.logs.length)
          setLogs(result.logs || [])
          setIsRunning(result.isRunning || false)
        }
      } catch (error) {
        console.error('[FRONTEND] Erro ao carregar logs:', error)
      }
    }

    loadSavedLogs()
  }, [])

  useEffect(() => {
    if (shouldAutoScrollRef.current && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight
    }
  }, [logs])

  const handleScroll = () => {
    if (logsContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = logsContainerRef.current
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 50
      shouldAutoScrollRef.current = isNearBottom
    }
  }

  useEffect(() => {
    console.log('[FRONTEND] Configurando listeners de log')

    const handleLog = async (_event: any, log: string) => {
      console.log('[FRONTEND] Log recebido:', log.substring(0, 100))
      setLogs((prev) => [...prev, log])
      try {
        await window.electron.ipcRenderer.invoke('save-log', log)
      } catch (error) {
        console.error('[FRONTEND] Erro ao salvar log:', error)
      }
    }

    const handleSyncStart = async () => {
      console.log('[FRONTEND] Sync iniciado')
      setIsRunning(true)
      try {
        await window.electron.ipcRenderer.invoke('set-sync-status', true)
      } catch (error) {
        console.error('[FRONTEND] Erro ao atualizar status:', error)
      }
    }

    const handleSyncEnd = async () => {
      console.log('[FRONTEND] Sync finalizado')
      setIsRunning(false)
      try {
        await window.electron.ipcRenderer.invoke('set-sync-status', false)
      } catch (error) {
        console.error('[FRONTEND] Erro ao atualizar status:', error)
      }
    }

    window.electron.ipcRenderer.removeAllListeners('sync-log')
    window.electron.ipcRenderer.removeAllListeners('sync-start')
    window.electron.ipcRenderer.removeAllListeners('sync-end')

    window.electron.ipcRenderer.on('sync-log', handleLog)
    window.electron.ipcRenderer.on('sync-start', handleSyncStart)
    window.electron.ipcRenderer.on('sync-end', handleSyncEnd)

    return () => {
      console.log('[FRONTEND] Removendo listeners de log')
      window.electron.ipcRenderer.removeAllListeners('sync-log')
      window.electron.ipcRenderer.removeAllListeners('sync-start')
      window.electron.ipcRenderer.removeAllListeners('sync-end')
    }
  }, [])

  // const clearLogs = async () => {
  //   setLogs([])
  //   shouldAutoScrollRef.current = true
  //   try {
  //     await window.electron.ipcRenderer.invoke('clear-logs')
  //     console.log('[FRONTEND] Logs limpos')
  //   } catch (error) {
  //     console.error('[FRONTEND] Erro ao limpar logs:', error)
  //   }
  // }

  const copyLogs = async () => {
    try {
      if (logs.length === 0) {
        toast.info('Nenhum log para copiar')
        return
      }

      await navigator.clipboard.writeText(logs.join('\n'))

      toast.success('Logs copiados para a área de transferência')
    } catch (error) {
      console.error('[FRONTEND] Erro ao copiar logs:', error)

      toast.error('Erro ao copiar logs')
    }
  }

  return (
    <div className="fixed inset-0 flex flex-col">
      <Card className="flex flex-col h-full">
        <CardHeader
          className="flex-shrink-0 flex flex-row items-center justify-between"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <CardTitle className="text-base font-medium">
            <div className="flex justify-center items-center gap-2">
              📋 Logs de Sincronização
              {isRunning && <div className="text-xs text-blue-500 animate-pulse">Executando</div>}
            </div>
          </CardTitle>
          <div className="flex gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            {/* <Button size="sm" variant="outline" onClick={clearLogs}>
              🗑️ Limpar
            </Button> */}

            <Button size="sm" variant="outline" onClick={copyLogs}>
              <Copy /> Copiar
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className="hover:bg-transparent"
              onClick={async () => await window.electron.ipcRenderer.invoke('close-window')}
            >
              <X />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="flex-1 overflow-hidden">
          <div
            ref={logsContainerRef}
            onScroll={handleScroll}
            className="h-full overflow-y-auto bg-slate-950 text-green-400 font-mono text-xs p-4 rounded-lg select-text"
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              scrollbarWidth: 'thin',
              scrollbarColor: '#334155 #0f172a'
            }}
          >
            <style>{`
              div[class*="overflow-y-auto"]::-webkit-scrollbar {
                width: 12px;
              }
              div[class*="overflow-y-auto"]::-webkit-scrollbar-track {
                background: #0f172a;
                border-radius: 8px;
              }
              div[class*="overflow-y-auto"]::-webkit-scrollbar-thumb {
                background: #334155;
                border-radius: 8px;
              }
              div[class*="overflow-y-auto"]::-webkit-scrollbar-thumb:hover {
                background: #475569;
              }
            `}</style>
            {logs.length === 0 ? (
              <div className="text-slate-500 italic">Aguardando operações...</div>
            ) : (
              logs.map((log, index) => <div key={index}>{log}</div>)
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default LogsWindow
