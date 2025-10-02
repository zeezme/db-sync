import { BrowserWindow, dialog, ipcMain } from 'electron'

export class GenericHandlers {
  static registerAll(): void {
    this.registerFileSelectors()
  }

  private static registerFileSelectors(): void {
    ipcMain.handle('select-directory', async () => {
      return await dialog.showOpenDialog({
        properties: ['openDirectory']
      })
    })

    ipcMain.handle('select-file', async () => {
      return await dialog.showOpenDialog({
        properties: ['openFile']
      })
    })

    ipcMain.handle('select-files', async () => {
      return await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections']
      })
    })

    ipcMain.handle('select-file-filtered', async (_event, filters?: Electron.FileFilter[]) => {
      return await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: filters || []
      })
    })

    ipcMain.handle('save-file', async (_event, defaultPath?: string) => {
      return await dialog.showSaveDialog({
        defaultPath
      })
    })

    ipcMain.handle('close-window', async () => {
      const window = BrowserWindow.getFocusedWindow()

      if (window) {
        window.close()
        return { success: true }
      }

      return { success: false, message: 'No focused window found' }
    })

    ipcMain.handle(
      'save-file-filtered',
      async (
        _event,
        options?: {
          defaultPath?: string
          filters?: Electron.FileFilter[]
        }
      ) => {
        return await dialog.showSaveDialog({
          defaultPath: options?.defaultPath,
          filters: options?.filters || []
        })
      }
    )
  }

  static removeAll(): void {
    const handlers = [
      'select-directory',
      'select-file',
      'select-files',
      'select-file-filtered',
      'save-file',
      'save-file-filtered',
      'close-window'
    ]

    handlers.forEach((handler) => {
      ipcMain.removeHandler(handler)
    })
  }
}
