import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { Client } from 'pg'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { DatabaseSync } from './database-sync'
import { GenericHandlers } from './generic'

let dbSync: DatabaseSync | null = null
let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => console.log('pong'))

  GenericHandlers.registerAll()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

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

    dbSync = new DatabaseSync(config, (log: string) => {
      mainWindow?.webContents.send('sync-log', log)
    })

    await dbSync.startScheduled()
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
})

ipcMain.handle('stop-sync', async () => {
  try {
    if (dbSync) {
      dbSync.stop()
      dbSync = null
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

ipcMain.handle('test-connection', async (_event, connectionString: string) => {
  try {
    const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1')

    const client = new Client({
      connectionString,
      ssl: isLocal ? false : { rejectUnauthorized: false }
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
    await DatabaseSync.runPrismaMigrations(backendDir, targetUrl, (log) => {
      if (mainWindow) {
        mainWindow.webContents.send('sync-log', log)
      }
    })
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
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
})
