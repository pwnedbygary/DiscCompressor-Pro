import { type IpcRendererEvent, contextBridge, ipcRenderer, webUtils } from 'electron'
import { type DiscApi, IPC } from '@shared/api'
import type { AppCommand, FilesInUseQuery, FilesInUseReply, JobEvent } from '@shared/types'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: DiscApi = {
  platform: process.platform,
  getSystemInfo: () => ipcRenderer.invoke(IPC.systemInfo),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  getTools: (refresh = false) => ipcRenderer.invoke(IPC.getTools, refresh),
  pickInputs: (mode) => ipcRenderer.invoke(IPC.pickInputs, mode),
  pickDirectory: (defaultPath) => ipcRenderer.invoke(IPC.pickDirectory, defaultPath),
  chooseTool: (tool) => ipcRenderer.invoke(IPC.chooseTool, tool),
  saveText: (options) => ipcRenderer.invoke(IPC.saveText, options),
  openText: (options) => ipcRenderer.invoke(IPC.openText, options),
  pathForFile: (file) => webUtils.getPathForFile(file),
  scan: (paths) => ipcRenderer.invoke(IPC.scan, paths),
  runJob: (request) => ipcRenderer.invoke(IPC.runJob, request),
  cancelJob: (id) => ipcRenderer.invoke(IPC.cancelJob, id),
  onJobEvents: (listener) => subscribe<JobEvent[]>(IPC.jobEvents, listener),
  answerFilesInUse: (answer) =>
    subscribe<FilesInUseQuery>(IPC.filesInUse, (query) => {
      let files: string[]
      try {
        files = answer(query)
      } catch {
        // Without an answer every file counts as needed, so nothing goes to the trash.
        files = query.files
      }
      const reply: FilesInUseReply = { requestId: query.requestId, files }
      ipcRenderer.send(IPC.filesInUseReply, reply)
    }),
  onOpenPaths: (listener) => subscribe<string[]>(IPC.openPaths, listener),
  onCommand: (listener) => subscribe<AppCommand>(IPC.command, listener),
  rendererReady: () => ipcRenderer.send(IPC.rendererReady),
  showInFolder: (path) => ipcRenderer.invoke(IPC.showInFolder, path),
  openOutputFolder: () => ipcRenderer.invoke(IPC.openOutputFolder),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  setTaskbarProgress: (progress) => ipcRenderer.send(IPC.taskbarProgress, progress),
  setBusy: (busy) => ipcRenderer.send(IPC.busy, busy)
}

contextBridge.exposeInMainWorld('api', api)
