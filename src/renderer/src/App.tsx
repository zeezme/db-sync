import { useEffect, useState } from 'react'
import ConfigSection from './pages/ConfigSection'
import './index.css'
import LogsWindow from './pages/LogsWindow'

function App(): React.JSX.Element {
  const [isLogsWindow, setIsLogsWindow] = useState(false)

  useEffect(() => {
    window.electron.ipcRenderer.on('window-type', (_event, type: string) => {
      setIsLogsWindow(type === 'logs')
    })
    return () => {
      window.electron.ipcRenderer.removeAllListeners('window-type')
    }
  }, [])

  return <>{isLogsWindow ? <LogsWindow /> : <ConfigSection />}</>
}

export default App
