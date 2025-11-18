import { app, shell, BrowserWindow, ipcMain, autoUpdater, dialog } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { Client } from 'pg'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { DatabaseSync, runPrismaMigrations } from './database-sync'
import { GenericHandlers } from './generic'

let dbSync: DatabaseSync | null = null
let mainWindow: BrowserWindow | null = null
let logsWindow: BrowserWindow | null = null

let logsBuffer: string[] = []
let isSyncRunning = false
let handlersRegistered = false

// ====================== AUTO-UPDATE (SÓ EM PRODUÇÃO) ======================
if (!is.dev) {
  const feedUrl = `https://update.electronjs.org/zeezme/db-sync/${process.platform}-${process.arch}/${app.getVersion()}`

  autoUpdater.setFeedURL({ url: feedUrl })

  autoUpdater.on('update-downloaded', () => {
    dialog
      .showMessageBox(mainWindow!, {
        type: 'info',
        title: 'Atualização disponível',
        message: 'Uma nova versão foi baixada. O aplicativo será reiniciado para instalar.',
        buttons: ['Reiniciar agora', 'Mais tarde']
      })
      .then((result) => {
        if (result.response === 0) {
          setImmediate(() => autoUpdater.quitAndInstall())
        }
      })
  })

  autoUpdater.on('error', (err) => {
    console.error('Erro no auto-update:', err)
  })

  // Checa ao abrir o app
  app.whenReady().then(() => {
    autoUpdater.checkForUpdates()

    // E depois a cada 6 horas
    setInterval(() => autoUpdater.checkForUpdates(), 6 * 60 * 60 * 1000)
  })
}

// ====================== SEU CÓDIGO ORIGINAL (100% INTACTO) ======================
function registerHandlers(): void {
  if (handlersRegistered) {
    console.log('Handlers already registered, skipping...')
    return
  }

  console.log('Registering IPC handlers')

  ipcMain.handle('save-log', (_event, log: string) => {
    logsBuffer.push(log)
    return { success: true }
  })

  ipcMain.handle('get-logs', () => {
    console.log('Getting logs, buffer size:', logsBuffer.length)
    return { logs: logsBuffer, isRunning: isSyncRunning }
  })

  ipcMain.handle('clear-logs', () => {
    logsBuffer = []
    console.log('Logs cleared')
    return { success: true }
  })

  ipcMain.handle('set-sync-status', (_event, status: boolean) => {
    isSyncRunning = status
    console.log('Sync status set to:', status)
    return { success: true }
  })

  ipcMain.on('ping', () => console.log('pong'))

  GenericHandlers.registerAll()

  ipcMain.handle('save-config', async (_event, config: unknown) => {
    try {
      const configPath = join(app.getPath('userData'), 'config.json')
      await fs.writeFile(configPath, JSON.stringify(config, null, 2))
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('load-config', async () => {
    try {
      const configPath = join(app.getPath('userData'), 'config.json')
      const data = await fs.readFile(configPath, 'utf-8')
      return { success: true, config: JSON.parse(data) }
    } catch {
      return { success: false, config: null }
    }
  })

  ipcMain.handle('start-sync', async (_event, config: any) => {
    try {
      if (dbSync) {
        dbSync.stop()
      }

      isSyncRunning = true

      if (logsWindow && !logsWindow.isDestroyed()) {
        logsWindow.webContents.send('sync-start')
      }

      dbSync = new DatabaseSync(config, (log: string) => {
        logsBuffer.push(log)

        if (logsWindow && !logsWindow.isDestroyed()) {
          logsWindow.webContents.send('sync-log', log)
        }
      })

      if (config.sourceSSLEnabled !== undefined) {
        dbSync.setSourceSSL(config.sourceSSLEnabled)
      }

      if (config.targetSSLEnabled !== undefined) {
        dbSync.setTargetSSL(config.targetSSLEnabled)
      }

      await dbSync.startScheduled()

      return { success: true }
    } catch (error) {
      isSyncRunning = false

      if (logsWindow && !logsWindow.isDestroyed()) {
        logsWindow.webContents.send('sync-end')
      }

      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('stop-sync', async () => {
    try {
      if (dbSync) {
        dbSync.stop()
        dbSync = null
      }

      isSyncRunning = false

      if (logsWindow && !logsWindow.isDestroyed()) {
        logsWindow.webContents.send('sync-end')
      }

      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('trigger-sync', async () => {
    try {
      if (!dbSync) {
        return { success: false, error: 'Sincronização não está ativa' }
      }

      await dbSync.syncNow()

      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('test-connection', async (_event, data: { url: string; sslEnabled: boolean }) => {
    try {
      const { url, sslEnabled } = data

      if (!url) {
        return { success: false, error: 'Connection string é obrigatória' }
      }

      const isLocal = url.includes('localhost') || url.includes('127.0.0.1')

      const client = new Client({
        connectionString: url,
        ssl: isLocal || !sslEnabled ? false : { rejectUnauthorized: false }
      })

      await client.connect()
      await client.end()

      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('run-prisma-migrations', async (_event, { backendDir, targetUrl }) => {
    try {
      if (logsWindow && !logsWindow.isDestroyed()) {
        logsWindow.webContents.send('sync-start')
      }
      isSyncRunning = true

      await runPrismaMigrations(backendDir, targetUrl, (log) => {
        logsBuffer.push(log)

        if (logsWindow && !logsWindow.isDestroyed()) {
          logsWindow.webContents.send('sync-log', log)
        }
        console.log('Migration Log:', log)
      })

      if (logsWindow && !logsWindow.isDestroyed()) {
        logsWindow.webContents.send('sync-end')
      }
      isSyncRunning = false

      return { success: true }
    } catch (error) {
      if (logsWindow && !logsWindow.isDestroyed()) {
        logsWindow.webContents.send('sync-end')
      }
      isSyncRunning = false
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('open-logs-window', () => {
    try {
      console.log('Opening logs window')
      createLogsWindow()
      return { success: true }
    } catch (error) {
      console.error('Error opening logs window:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('set-source-ssl', async (_event, enabled: boolean) => {
    try {
      if (dbSync) {
        dbSync.setSourceSSL(enabled)
        return { success: true }
      }
      return { success: false, error: 'Sincronização não está ativa' }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('set-target-ssl', async (_event, enabled: boolean) => {
    try {
      if (dbSync) {
        dbSync.setTargetSSL(enabled)
        return { success: true }
      }
      return { success: false, error: 'Sincronização não está ativa' }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('get-ssl-status', async () => {
    try {
      if (dbSync) {
        const status = dbSync.getSSLStatus()
        return { success: true, status }
      }
      return { success: false, error: 'Sincronização não está ativa' }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  handlersRegistered = true
  console.log('All handlers registered successfully')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 520,
    minWidth: 1000,
    minHeight: 520,
    maxHeight: 520,
    maximizable: false,
    show: false,
    frame: false,
    transparent: true,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.webContents.send('window-type', 'main')
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']).catch((err) => {
      console.error('Failed to load main window URL:', err)
    })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html')).catch((err) => {
      console.error('Failed to load main window file:', err)
    })
  }
}

function createLogsWindow(): void {
  if (logsWindow && !logsWindow.isDestroyed()) {
    console.log('Focusing existing logs window')
    logsWindow.focus()
    return
  }

  logsWindow = new BrowserWindow({
    width: 800,
    height: 700,
    maximizable: false,
    show: false,
    frame: false,
    transparent: true,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  console.log('Logs window created')

  logsWindow.on('ready-to-show', () => {
    console.log('Logs window ready to show')
    logsWindow?.show()
    logsWindow?.webContents.send('window-type', 'logs')
  })

  logsWindow.on('closed', () => {
    console.log('Logs window closed')
    logsWindow = null
  })

  const isDev = !app.isPackaged

  const loadDevUrl = process.env.ELECTRON_RENDERER_URL
  const loadProdPath = join(__dirname, '../renderer/index.html')

  console.log('isDev:', isDev)
  console.log('Loading logs window:', isDev ? loadDevUrl : loadProdPath)

  if (isDev && loadDevUrl) {
    logsWindow.loadURL(loadDevUrl).catch((err) => console.error('Failed to load logs URL:', err))
  } else {
    logsWindow
      .loadFile(loadProdPath)
      .catch((err) => console.error('Failed to load logs file:', err))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerHandlers()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  GenericHandlers.removeAll()
  if (dbSync) {
    dbSync.stop()
    dbSync = null
  }

  logsBuffer = []
  isSyncRunning = false

  handlersRegistered = false
})
