import React, { useEffect, useState, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/primitive/card'
import { Button } from '@renderer/components/primitive/button'
import { X } from 'lucide-react'

const LogsWindow: React.FC = () => {
  const [logs, setLogs] = useState<string[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const logsEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll para o final dos logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // Escuta eventos de logs do backend
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

  const clearLogs = () => {
    setLogs([])
  }

  return (
    <div className="w-[800px] h-[600px] p-4">
      <Card className="flex flex-col h-full">
        <CardHeader
          className="flex flex-row items-center justify-between space-y-0 pb-2"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <CardTitle className="text-base font-medium">
            📋 Logs de Sincronização
            {isRunning && (
              <span className="ml-2 text-sm text-blue-500 animate-pulse">• Executando...</span>
            )}
          </CardTitle>
          <div className="flex gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <Button size="sm" variant="outline" onClick={clearLogs}>
              🗑️ Limpar
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="hover:bg-transparent text-red-500 hover:text-red-700"
              onClick={async () => await window.electron.ipcRenderer.invoke('close-window')}
            >
              <X />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="flex-1 p-0 overflow-hidden">
          <div
            className="h-full overflow-y-auto bg-slate-950 text-green-400 font-mono text-xs p-4 rounded-b-lg select-text"
            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
          >
            {logs.length === 0 ? (
              <div className="text-slate-500 italic">Aguardando operações...</div>
            ) : (
              logs.map((log, index) => <div key={index}>{log}</div>)
            )}
            <div ref={logsEndRef} />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default LogsWindow
