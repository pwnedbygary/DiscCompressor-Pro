import type {
  AppCommand,
  AppSettings,
  JobEvent,
  RunJobRequest,
  ScanResult,
  SystemInfo,
  TaskbarProgress,
  ToolName,
  ToolsStatus
} from './types'

export const IPC = {
  systemInfo: 'app:system-info',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  getTools: 'tools:get',
  pickInputs: 'dialog:pick-inputs',
  pickDirectory: 'dialog:pick-directory',
  chooseTool: 'tools:choose',
  saveText: 'dialog:save-text',
  openText: 'dialog:open-text',
  scan: 'inputs:scan',
  runJob: 'jobs:run',
  cancelJob: 'jobs:cancel',
  jobEvents: 'jobs:events',
  openPaths: 'app:open-paths',
  command: 'app:command',
  showInFolder: 'shell:show-in-folder',
  openOutputFolder: 'shell:open-output-folder',
  openExternal: 'shell:open-external',
  taskbarProgress: 'window:taskbar-progress',
  busy: 'app:busy',
  rendererReady: 'app:renderer-ready'
} as const

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface SaveTextOptions {
  title: string
  defaultName: string
  filters: FileFilter[]
  content: string
}

export interface OpenTextOptions {
  title: string
  filters: FileFilter[]
}

/** The API the preload script exposes to the renderer as `window.api`. */
export interface DiscApi {
  platform: string
  getSystemInfo(): Promise<SystemInfo>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getTools(refresh?: boolean): Promise<ToolsStatus>
  pickInputs(mode: 'files' | 'folder'): Promise<string[]>
  pickDirectory(defaultPath?: string): Promise<string | null>
  /** Let the user pick a chdman or maxcso executable and save it; resolves with the new settings, or null if cancelled. */
  chooseTool(tool: ToolName): Promise<AppSettings | null>
  saveText(options: SaveTextOptions): Promise<boolean>
  openText(options: OpenTextOptions): Promise<string | null>
  /** Absolute path of a File from a drag-and-drop or file input, or '' if unknown. */
  pathForFile(file: File): string
  scan(paths: string[]): Promise<ScanResult>
  runJob(request: RunJobRequest): Promise<void>
  cancelJob(id: string): Promise<void>
  onJobEvents(listener: (events: JobEvent[]) => void): () => void
  onOpenPaths(listener: (paths: string[]) => void): () => void
  onCommand(listener: (command: AppCommand) => void): () => void
  /** Tells the main process the renderer is listening, so queued paths can be delivered. */
  rendererReady(): void
  showInFolder(path: string): Promise<void>
  /** Open the configured output folder; resolves false if it does not exist yet. */
  openOutputFolder(): Promise<boolean>
  openExternal(url: string): Promise<void>
  setTaskbarProgress(progress: TaskbarProgress): void
  setBusy(busy: boolean): void
}
