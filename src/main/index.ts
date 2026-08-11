import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeImage,
  Menu,
  session,
  type MediaAccessPermissionRequest,
  type MenuItemConstructorOptions
} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  AppSettings,
  ChatRequest,
  ChatSession,
  ExecRequest,
  PtySpawnOptions
} from '../shared/types'
import { loadSettings, saveSettings } from './settings'
import * as shim from './shim'
import * as chat from './chat'
import * as files from './files'
import * as terminal from './terminal'
import * as exec from './exec'
import * as sessions from './sessions'
import { registerScheme, registerHandler } from './protocol'

// Privileged schemes must be declared before the app is ready.
registerScheme()

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
      webviewTag: true,
      // Chromium's bundled PDF viewer is a plugin; without this the PDF pane
      // downloads the file instead of rendering it.
      plugins: true
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

/** Native File -> New Window support, including the standard macOS shortcut. */
function registerAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Allow microphone-only access for ArgoIDE renderers, never embedded webviews. */
function registerVoicePermissions(): void {
  const appSession = session.defaultSession
  appSession.setPermissionCheckHandler((contents, permission, _origin, details) => {
    const trusted = contents !== null && BrowserWindow.fromWebContents(contents) !== null
    return trusted && permission === 'media' && details.mediaType !== 'video'
  })
  appSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const media = details as MediaAccessPermissionRequest
    const trusted = BrowserWindow.fromWebContents(contents) !== null
    callback(
      trusted &&
        permission === 'media' &&
        !(media.mediaTypes ?? []).includes('video')
    )
  })
}

function registerIpc(): void {
  // --------------------------------------------------------------- window
  ipcMain.on('window:new', () => createWindow())

  // -------------------------------------------------------------- settings
  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>) => saveSettings(patch))

  // ------------------------------------------------------------------ shim
  ipcMain.handle('shim:status', () => shim.getStatus())
  ipcMain.handle('shim:connect', () => shim.connect())
  ipcMain.handle('shim:useExternal', () => shim.useExternal())
  ipcMain.handle('shim:disconnect', () => shim.disconnect())
  ipcMain.handle('shim:occupants', () => shim.listOccupants())
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
  ipcMain.handle('fs:writeText', (_e, root: string, path: string, content: string) =>
    files.writeTextFile(root, path, content)
  )
  ipcMain.handle('fs:dataUrl', (_e, path: string, mime: string) =>
    files.readAsDataUrl(path, mime)
  )
  ipcMain.handle('fs:classify', (_e, path: string) => files.classify(path))
  ipcMain.handle('fs:attach', (_e, path: string, id: string) => files.makeAttachment(path, id))
  ipcMain.handle('fs:projectContext', (_e, root: string) => files.projectContext(root))
  ipcMain.handle('fs:readProjectFile', (_e, root: string, path: string) =>
    files.readProjectFile(root, path)
  )
  ipcMain.handle('fs:home', () => app.getPath('home'))

  // ----------------------------------------------------------- agent tools
  ipcMain.handle('agent:writeProjectFile', async (_e, root: string, path: string, content: string) => {
    const { result, previous, absolutePath } = await files.writeProjectFile(root, path, content)
    // An open editor tab showing this file is now stale. Tell every window;
    // a clean tab reloads, a dirty one warns instead of losing the draft.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('fs:fileChanged', absolutePath)
    }
    return { ...result, previous }
  })
  ipcMain.handle('agent:exec', (e, req: ExecRequest) => exec.run(e.sender, req))
  ipcMain.on('agent:execCancel', (_e, id: string) => exec.kill(id))

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

/**
 * In a packaged build the icon comes from the bundled .icns. `electron-vite
 * dev` runs under the stock Electron binary, though, so the dock shows its
 * default icon unless we set one explicitly.
 */
function setDevDockIcon(): void {
  if (!is.dev || process.platform !== 'darwin' || !app.dock) return
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'))
  if (!icon.isEmpty()) app.dock.setIcon(icon)
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.argo.ide')
  setDevDockIcon()
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  registerHandler()
  registerIpc()
  registerAppMenu()
  registerVoicePermissions()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Don't leak PTY children (the shim, every open terminal, and any command the
// agent is still running) past quit.
app.on('before-quit', () => {
  shim.shutdown()
  terminal.killAll()
  exec.killAll()
})
