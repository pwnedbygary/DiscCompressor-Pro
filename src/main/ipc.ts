import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { availableParallelism, homedir } from 'node:os'
import { basename, extname, isAbsolute } from 'node:path'
import {
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  dialog,
  ipcMain,
  shell
} from 'electron'
import { IPC, type FileFilter, type OpenTextOptions, type SaveTextOptions } from '@shared/api'
import { INPUT_EXTENSIONS, TARGETS, normalizeJobSettings } from '@shared/formats'
import type { FilesInUseQuery, FilesInUseReply, JobEvent, RunJobRequest, SystemInfo, TaskbarProgress, Target } from '@shared/types'
import type { JobRunner } from './jobs/runner'
import { scanPaths } from './scan'
import type { SettingsStore } from './settings'
import type { ToolRegistry } from './tools'
import { isAppUrl, isExternalLink } from './window'

const EVENT_FLUSH_MS = 100
const MAX_TEXT_FILE_BYTES = 16 * 1024 * 1024
const MAX_SCAN_PATHS = 10_000
const FILES_IN_USE_TIMEOUT_MS = 10_000

export interface IpcDependencies {
  window: () => BrowserWindow | null
  settings: SettingsStore
  tools: ToolRegistry
  runner: JobRunner
  /** Whether the page has registered its listeners (see `rendererReady`). */
  isRendererReady: () => boolean
  onRendererReady: () => void
  onBusyChange: (busy: boolean) => void
}

export interface IpcBridge {
  events: JobEventBatcher
  /** Ask the page which of `files` jobs other than `jobId` still need; null when it cannot answer. */
  filesInUse: (query: Omit<FilesInUseQuery, 'requestId'>) => Promise<string[] | null>
  /** Forget what was meant for a page that crashed or is reloading: queued events and unanswered questions. */
  resetRenderer: () => void
}

/** Sends job events to the renderer at most every EVENT_FLUSH_MS, keeping only the latest progress per job. */
export class JobEventBatcher {
  private queue: JobEvent[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly send: (events: JobEvent[]) => void) {}

  push(event: JobEvent): void {
    if (event.type === 'progress') {
      // Drop the older update rather than replacing it in place, so events stay in the order they happened.
      const index = this.queue.findIndex((queued) => queued.type === 'progress' && queued.jobId === event.jobId)
      if (index >= 0) this.queue.splice(index, 1)
    }
    this.queue.push(event)
    this.timer ??= setTimeout(() => this.flush(), EVENT_FLUSH_MS)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.queue.length === 0) return
    const events = this.queue
    this.queue = []
    this.send(events)
  }

  /** Drop events that have not been sent yet. */
  clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.queue = []
  }
}

class InvalidArgument extends Error {}

function string(value: unknown, name: string, maxLength = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new InvalidArgument(`Invalid ${name}`)
  }
  return value
}

function absolutePath(value: unknown, name: string): string {
  const path = string(value, name, 32_767)
  if (!isAbsolute(path)) throw new InvalidArgument(`${name} must be an absolute path`)
  return path
}

function isFileFilter(value: unknown): value is FileFilter {
  const filter = value as Partial<FileFilter> | null
  return !!filter && typeof filter.name === 'string' && Array.isArray(filter.extensions)
}

function filters(value: unknown): FileFilter[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isFileFilter)
    .map((f) => ({ name: f.name.slice(0, 100), extensions: f.extensions.filter((e) => typeof e === 'string').slice(0, 20) }))
}

function runRequest(value: unknown): RunJobRequest {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const id = string(raw.id, 'job id', 64)
  if (!/^[\w-]+$/.test(id)) throw new InvalidArgument('Invalid job id')
  if (!TARGETS.includes(raw.target as Target)) throw new InvalidArgument('Invalid target')
  return {
    id,
    inputPath: absolutePath(raw.inputPath, 'input path'),
    target: raw.target as Target,
    settings: normalizeJobSettings(raw.settings),
    rerun: raw.rerun === true
  }
}

/** Settings the renderer may change. Tool paths can only be cleared: a new one must come from `chooseTool`. */
export function rendererSettingsPatch(value: unknown): Record<string, unknown> {
  const patch = { ...((value && typeof value === 'object' ? value : {}) as Record<string, unknown>) }
  for (const key of ['chdmanPath', 'maxcsoPath']) {
    if (key in patch && patch[key] !== '') delete patch[key]
  }
  return patch
}

export function registerIpc(deps: IpcDependencies): IpcBridge {
  const { settings, tools, runner } = deps

  /** Only the main frame of the app's window, showing the app's own page, may use the API. */
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const window = deps.window()
    const frame = event.senderFrame
    if (!window || window.isDestroyed() || !frame || event.sender.id !== window.webContents.id) return false
    return frame.frameTreeNodeId === window.webContents.mainFrame.frameTreeNodeId && isAppUrl(frame.url)
  }

  const handle = (channel: string, handler: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error('Untrusted sender')
      return handler(...args)
    })
  }

  const on = (channel: string, listener: (...args: unknown[]) => void): void => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      if (trusted(event)) listener(...args)
    })
  }

  const openDialog = async (options: OpenDialogOptions): Promise<string[]> => {
    const window = deps.window()
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  }

  handle(IPC.systemInfo, (): SystemInfo => ({
    platform: process.platform,
    arch: process.arch,
    cpuCount: availableParallelism(),
    homeDir: homedir()
  }))

  /** Ask the user to confirm a destructive setting; true if they did. */
  const confirm = async (action: string, title: string, message: string, detail: string): Promise<boolean> => {
    const window = deps.window()
    const options = { type: 'warning' as const, buttons: [action, 'Cancel'], defaultId: 1, cancelId: 1, title, message, detail }
    const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
    return response === 0
  }

  handle(IPC.getSettings, () => settings.get())
  // Settings that can destroy files only change after the user confirms them here, whatever the page asks for.
  handle(IPC.updateSettings, async (value) => {
    const patch = rendererSettingsPatch(value)
    const current = settings.get()
    if (
      patch.deleteOriginals === true &&
      !current.deleteOriginals &&
      !(await confirm(
        'Move originals to the trash',
        'Move originals to the trash?',
        'Move the original images to the trash after each successful conversion?',
        'This applies to every conversion and extraction from now on, including every track file of a cue or GDI sheet. Info and Verify never remove anything.'
      ))
    ) {
      delete patch.deleteOriginals
    }
    if (
      patch.overwrite === 'overwrite' &&
      current.overwrite !== 'overwrite' &&
      !(await confirm(
        'Replace existing files',
        'Replace existing files?',
        'Replace files that already exist in the output folder?',
        'From now on, a finished job replaces any file with the same name as its output. A job never replaces its own input or a file another job is writing.'
      ))
    ) {
      delete patch.overwrite
    }
    return settings.update(patch)
  })
  handle(IPC.getTools, (refresh) => tools.get(settings.get(), refresh === true))

  handle(IPC.pickInputs, (mode) =>
    openDialog(
      mode === 'folder'
        ? { title: 'Add folders', properties: ['openDirectory', 'multiSelections'] }
        : {
            title: 'Add disc images',
            properties: ['openFile', 'multiSelections'],
            filters: [
              { name: 'Disc images', extensions: Object.keys(INPUT_EXTENSIONS).map((ext) => ext.slice(1)) },
              { name: 'All files', extensions: ['*'] }
            ]
          }
    )
  )

  handle(IPC.pickDirectory, async (defaultPath) => {
    const [path] = await openDialog({
      title: 'Choose output folder',
      properties: ['openDirectory', 'createDirectory'],
      ...(typeof defaultPath === 'string' && isAbsolute(defaultPath) ? { defaultPath } : {})
    })
    return path ?? null
  })

  handle(IPC.chooseTool, async (tool) => {
    if (tool !== 'chdman' && tool !== 'maxcso') throw new InvalidArgument('Invalid tool')
    const [path] = await openDialog({
      title: `Choose ${tool}`,
      properties: ['openFile'],
      ...(process.platform === 'win32' ? { filters: [{ name: 'Programs', extensions: ['exe'] }] } : {})
    })
    if (!path) return null
    return settings.update(tool === 'chdman' ? { chdmanPath: path } : { maxcsoPath: path })
  })

  handle(IPC.saveText, async (options) => {
    const { title, defaultName, content, filters: filterList } = (options ?? {}) as SaveTextOptions
    if (typeof content !== 'string' || content.length > MAX_TEXT_FILE_BYTES) throw new InvalidArgument('Invalid content')
    const window = deps.window()
    const dialogOptions = { title: string(title, 'title', 200), defaultPath: basename(string(defaultName, 'file name', 255)), filters: filters(filterList) }
    const result = window ? await dialog.showSaveDialog(window, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, content, 'utf8')
    return true
  })

  handle(IPC.openText, async (options) => {
    const { title, filters: filterList } = (options ?? {}) as OpenTextOptions
    const [path] = await openDialog({ title: string(title, 'title', 200), properties: ['openFile'], filters: filters(filterList) })
    if (!path) return null
    if ((await stat(path)).size > MAX_TEXT_FILE_BYTES) throw new Error('The file is too large')
    return readFile(path, 'utf8')
  })

  handle(IPC.scan, (paths) => {
    if (!Array.isArray(paths) || paths.length > MAX_SCAN_PATHS) throw new InvalidArgument('Invalid paths')
    return scanPaths(paths.map((path) => absolutePath(path, 'path')))
  })

  handle(IPC.runJob, (request) => {
    runner.start(runRequest(request))
  })
  handle(IPC.cancelJob, (id) => {
    runner.cancel(string(id, 'job id', 64))
  })

  handle(IPC.showInFolder, (path) => {
    shell.showItemInFolder(absolutePath(path, 'path'))
  })
  handle(IPC.openOutputFolder, async () => {
    const dir = settings.get().outputDirectory
    let info
    try {
      info = await stat(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (!info.isDirectory()) throw new Error(`${dir} is not a folder`)
    // macOS opens a bundle (a folder such as Tool.app) by launching it, so such folders, also when reached
    // through a symbolic link, are only shown in Finder.
    if (process.platform === 'darwin') {
      const real = await realpath(dir)
      if (extname(real) !== '') {
        shell.showItemInFolder(real)
        return true
      }
    }
    const error = await shell.openPath(dir)
    if (error) throw new Error(error)
    return true
  })
  handle(IPC.openExternal, async (url) => {
    const target = string(url, 'url')
    if (!isExternalLink(target)) throw new InvalidArgument('This link cannot be opened')
    await shell.openExternal(target)
  })

  on(IPC.taskbarProgress, (value) => {
    const window = deps.window()
    const progress = value as TaskbarProgress
    if (!window || !progress || typeof progress.progress !== 'number') return
    if (progress.mode === 'none') window.setProgressBar(-1)
    else window.setProgressBar(Math.min(Math.max(progress.progress, 0), 1), { mode: progress.mode })
  })
  on(IPC.busy, (busy) => deps.onBusyChange(busy === true))
  on(IPC.rendererReady, () => deps.onRendererReady())

  const events = new JobEventBatcher((batch) => {
    const window = deps.window()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.jobEvents, batch)
  })

  const questions = new Map<number, (files: string[] | null) => void>()
  let nextQuestion = 1
  on(IPC.filesInUseReply, (value) => {
    const reply = (value && typeof value === 'object' ? value : {}) as Partial<FilesInUseReply>
    const settle = typeof reply.requestId === 'number' ? questions.get(reply.requestId) : undefined
    settle?.(Array.isArray(reply.files) ? reply.files.filter((file): file is string => typeof file === 'string') : null)
  })

  const filesInUse: IpcBridge['filesInUse'] = (query) =>
    new Promise((resolve) => {
      const window = deps.window()
      if (!window || window.isDestroyed() || !deps.isRendererReady()) {
        resolve(null)
        return
      }
      // The page has to see every earlier job event, such as another job finishing, before it answers.
      events.flush()
      const requestId = nextQuestion++
      const timer = setTimeout(() => questions.get(requestId)?.(null), FILES_IN_USE_TIMEOUT_MS)
      questions.set(requestId, (files) => {
        clearTimeout(timer)
        questions.delete(requestId)
        resolve(files)
      })
      window.webContents.send(IPC.filesInUse, { requestId, ...query } satisfies FilesInUseQuery)
    })

  return {
    events,
    filesInUse,
    resetRenderer: () => {
      events.clear()
      for (const settle of [...questions.values()]) settle(null)
    }
  }
}
