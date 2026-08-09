import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  AppSettings,
  ChatRequest,
  ChatSession,
  PtySpawnOptions
} from '../shared/types'
import { loadSettings, saveSettings } from './settings'
import * as shim from './shim'
import * as chat from './chat'
import * as files from './files'
import * as terminal from './terminal'
import * as sessions from './sessions'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1b1d23',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      // The third pane embeds arbitrary web pages in a <webview>, which is
      // disabled by default in modern Electron.
      webviewTag: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // Anything that would open a new window (target=_blank in the webview,
  // links in chat) goes to the system browser instead of an unmanaged window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  // -------------------------------------------------------------- settings
  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>) => saveSettings(patch))

  // ------------------------------------------------------------------ shim
  ipcMain.handle('shim:status', () => shim.getStatus())
  ipcMain.handle('shim:connect', () => shim.connect())
  ipcMain.handle('shim:disconnect', () => shim.disconnect())
  ipcMain.handle('shim:verify', () => shim.verify())
  ipcMain.on('shim:input', (_e, data: string) => shim.writeToShim(data))

  // ------------------------------------------------------------------ chat
  ipcMain.handle('chat:models', async () => {
    const raw = await shim.fetchModels()
    return raw.map((m) => ({ id: m.id, internalId: m.internal_id }))
  })
  ipcMain.on('chat:send', (e, req: ChatRequest) => chat.stream(e.sender, req))
  ipcMain.on('chat:cancel', (_e, requestId: string) => chat.cancel(requestId))

  // ------------------------------------------------------------- filesystem
  ipcMain.handle('fs:list', (_e, dir: string) => files.listDirectory(dir))
  ipcMain.handle('fs:readText', (_e, path: string) => files.readTextFile(path))
  ipcMain.handle('fs:dataUrl', (_e, path: string, mime: string) =>
    files.readAsDataUrl(path, mime)
  )
  ipcMain.handle('fs:classify', (_e, path: string) => files.classify(path))
  ipcMain.handle('fs:attach', (_e, path: string, id: string) => files.makeAttachment(path, id))
  ipcMain.handle('fs:home', () => app.getPath('home'))

  ipcMain.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:openFiles', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })

  // -------------------------------------------------------------- terminal
  ipcMain.on('terminal:spawn', (e, opts: PtySpawnOptions) => terminal.spawn(e.sender, opts))
  ipcMain.on('terminal:write', (_e, id: string, data: string) => terminal.write(id, data))
  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) =>
    terminal.resize(id, cols, rows)
  )
  ipcMain.on('terminal:kill', (_e, id: string) => terminal.kill(id))

  // -------------------------------------------------------------- sessions
  ipcMain.handle('sessions:list', () => sessions.list())
  ipcMain.handle('sessions:read', (_e, id: string) => sessions.read(id))
  ipcMain.handle('sessions:write', (_e, s: ChatSession) => sessions.write(s))
  ipcMain.handle('sessions:delete', (_e, id: string) => sessions.remove(id))
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.argo.ide')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Don't leak PTY children (the shim, and every open terminal) past quit.
app.on('before-quit', () => {
  shim.shutdown()
  terminal.killAll()
})
