import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import {
  AppSettings,
  ArgoModel,
  Attachment,
  ChatRequest,
  ChatSession,
  DirEntry,
  PtySpawnOptions,
  ProjectContext,
  ProjectFile,
  SessionSummary,
  ShimOccupant,
  ShimStatus,
  StreamEvent
} from '../shared/types'
import { fileUrl } from '../shared/fileUrl'

/**
 * The only surface the renderer gets. Everything is an explicit named method —
 * no generic `invoke(channel, ...)` escape hatch, so a compromised renderer
 * can't reach IPC channels this file doesn't list.
 */
const api = {
  app: {
    newWindow: (): void => ipcRenderer.send('window:new')
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    save: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke('settings:save', patch)
  },

  shim: {
    status: (): Promise<ShimStatus> => ipcRenderer.invoke('shim:status'),
    connect: (): Promise<ShimStatus> => ipcRenderer.invoke('shim:connect'),
    /** Stop only our managed child, then health-check and use a Terminal shim. */
    useExternal: (): Promise<ShimStatus> => ipcRenderer.invoke('shim:useExternal'),
    /** Detach from our own shim; leaves a shim we did not start running. */
    disconnect: (): Promise<ShimStatus> => ipcRenderer.invoke('shim:disconnect'),
    /** Processes currently listening on the shim port, ours or not. */
    occupants: (): Promise<ShimOccupant[]> => ipcRenderer.invoke('shim:occupants'),
    verify: (): Promise<ShimStatus> => ipcRenderer.invoke('shim:verify'),
    /** Send a line into the shim's PTY — used to answer the Duo prompt. */
    input: (data: string): void => ipcRenderer.send('shim:input', data),
    onOutput: (cb: (chunk: string) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, chunk: string): void => cb(chunk)
      ipcRenderer.on('shim:output', h)
      return () => ipcRenderer.removeListener('shim:output', h)
    },
    onState: (cb: (status: ShimStatus) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, status: ShimStatus): void => cb(status)
      ipcRenderer.on('shim:state', h)
      return () => ipcRenderer.removeListener('shim:state', h)
    }
  },

  chat: {
    models: (): Promise<ArgoModel[]> => ipcRenderer.invoke('chat:models'),
    /**
     * Start a streaming completion. Returns an unsubscribe function; call it
     * when the message is finished or the component unmounts.
     */
    send: (req: ChatRequest, onEvent: (e: StreamEvent) => void): (() => void) => {
      const channel = `chat:stream:${req.requestId}`
      const h = (_e: IpcRendererEvent, event: StreamEvent): void => onEvent(event)
      ipcRenderer.on(channel, h)
      ipcRenderer.send('chat:send', req)
      return () => ipcRenderer.removeListener(channel, h)
    },
    cancel: (requestId: string): void => ipcRenderer.send('chat:cancel', requestId)
  },

  fs: {
    list: (dir: string): Promise<DirEntry[]> => ipcRenderer.invoke('fs:list', dir),
    readText: (path: string): Promise<string> => ipcRenderer.invoke('fs:readText', path),
    dataUrl: (path: string, mime: string): Promise<string> =>
      ipcRenderer.invoke('fs:dataUrl', path, mime),
    /**
     * A streamable URL for a local PDF or image. Pure string building — no IPC
     * round trip — but it lives here so the scheme stays a main-process detail.
     */
    url: (path: string): string => fileUrl(path),
    classify: (path: string): Promise<'text' | 'image' | 'pdf' | 'binary'> =>
      ipcRenderer.invoke('fs:classify', path),
    attach: (path: string, id: string): Promise<Attachment> =>
      ipcRenderer.invoke('fs:attach', path, id),
    /** Recursive source tree for the directory currently open in Explorer. */
    projectContext: (root: string): Promise<ProjectContext> =>
      ipcRenderer.invoke('fs:projectContext', root),
    /** Model-requested text read, constrained by main process to the Explorer root. */
    readProjectFile: (root: string, path: string): Promise<ProjectFile> =>
      ipcRenderer.invoke('fs:readProjectFile', root, path),
    home: (): Promise<string> => ipcRenderer.invoke('fs:home'),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
    pickFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog:openFiles')
  },

  terminal: {
    spawn: (opts: PtySpawnOptions): void => ipcRenderer.send('terminal:spawn', opts),
    write: (id: string, data: string): void => ipcRenderer.send('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('terminal:resize', id, cols, rows),
    kill: (id: string): void => ipcRenderer.send('terminal:kill', id),
    onData: (id: string, cb: (data: string) => void): (() => void) => {
      const channel = `terminal:data:${id}`
      const h = (_e: IpcRendererEvent, data: string): void => cb(data)
      ipcRenderer.on(channel, h)
      return () => ipcRenderer.removeListener(channel, h)
    },
    onExit: (id: string, cb: (code: number) => void): (() => void) => {
      const channel = `terminal:exit:${id}`
      const h = (_e: IpcRendererEvent, code: number): void => cb(code)
      ipcRenderer.on(channel, h)
      return () => ipcRenderer.removeListener(channel, h)
    }
  },

  sessions: {
    list: (): Promise<SessionSummary[]> => ipcRenderer.invoke('sessions:list'),
    read: (id: string): Promise<ChatSession | null> => ipcRenderer.invoke('sessions:read', id),
    write: (s: ChatSession): Promise<void> => ipcRenderer.invoke('sessions:write', s),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('sessions:delete', id)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
