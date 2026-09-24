import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { DEFAULT_JOB_SETTINGS, TARGETS, normalizeJobSettings } from '@shared/formats'
import { SYSTEM_THEME_ID, findTheme } from '@shared/themes'
import type { AppSettings, Target, WindowState } from '@shared/types'

export function defaultSettings(): AppSettings {
  return {
    outputMode: 'directory',
    outputDirectory: join(homedir(), 'DiscCompressorPro_Outputs'),
    // Existing files are never replaced unless the user asks for it (and confirms, see ipc.ts).
    overwrite: 'skip',
    defaultTarget: 'CHD',
    jobDefaults: { ...DEFAULT_JOB_SETTINGS },
    themeId: SYSTEM_THEME_ID,
    deleteOriginals: false,
    autoGenerateM3U: false,
    minimizeToTray: false,
    notifyOnFinish: true,
    maxConcurrentJobs: 1,
    chdmanPath: '',
    maxcsoPath: '',
    window: null
  }
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function absolutePathOrEmpty(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' || isAbsolute(trimmed) ? trimmed : fallback
}

function windowState(value: unknown): WindowState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined)
  const width = num(raw.width)
  const height = num(raw.height)
  if (width === undefined || height === undefined || width < 400 || height < 300) return null
  const x = num(raw.x)
  const y = num(raw.y)
  return {
    width,
    height,
    ...(x !== undefined && y !== undefined ? { x, y } : {}),
    maximized: raw.maximized === true
  }
}

/**
 * Validate settings read from disk or received over IPC, filling anything
 * missing or invalid from `base`. Also understands the v1 settings file.
 */
export function sanitizeSettings(value: unknown, base: AppSettings): AppSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const target = (raw.defaultTarget ?? raw.defaultFormat) as Target
  const outputDirectory = absolutePathOrEmpty(raw.outputDirectory, base.outputDirectory)
  const concurrency = raw.maxConcurrentJobs
  return {
    outputMode: raw.outputMode === 'source' || raw.outputMode === 'directory' ? raw.outputMode : base.outputMode,
    outputDirectory: outputDirectory === '' ? base.outputDirectory : outputDirectory,
    overwrite:
      raw.overwrite === 'overwrite' || raw.overwrite === 'skip' || raw.overwrite === 'rename'
        ? raw.overwrite
        : base.overwrite,
    defaultTarget: TARGETS.includes(target) ? target : base.defaultTarget,
    jobDefaults: raw.jobDefaults === undefined ? base.jobDefaults : normalizeJobSettings(raw.jobDefaults),
    themeId:
      typeof raw.themeId === 'string' && (raw.themeId === SYSTEM_THEME_ID || findTheme(raw.themeId))
        ? raw.themeId
        : base.themeId,
    deleteOriginals: bool(raw.deleteOriginals, base.deleteOriginals),
    autoGenerateM3U: bool(raw.autoGenerateM3U, base.autoGenerateM3U),
    minimizeToTray: bool(raw.minimizeToTray, base.minimizeToTray),
    notifyOnFinish: bool(raw.notifyOnFinish, base.notifyOnFinish),
    maxConcurrentJobs:
      typeof concurrency === 'number' && Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8
        ? concurrency
        : base.maxConcurrentJobs,
    chdmanPath: absolutePathOrEmpty(raw.chdmanPath, base.chdmanPath),
    maxcsoPath: absolutePathOrEmpty(raw.maxcsoPath, base.maxcsoPath),
    window: raw.window === undefined ? base.window : windowState(raw.window)
  }
}

export class SettingsStore {
  private settings = defaultSettings()
  private pendingWrite: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(settings: AppSettings, previous: AppSettings) => void>()

  constructor(private readonly file: string) {}

  async load(): Promise<AppSettings> {
    try {
      const text = await readFile(this.file, 'utf8')
      this.settings = sanitizeSettings(JSON.parse(text), defaultSettings())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Could not read ${this.file}; using defaults.`, error)
      }
    }
    return this.settings
  }

  get(): AppSettings {
    return this.settings
  }

  onChange(listener: (settings: AppSettings, previous: AppSettings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async update(patch: unknown): Promise<AppSettings> {
    const previous = this.settings
    const incoming = patch && typeof patch === 'object' ? patch : {}
    this.settings = sanitizeSettings({ ...previous, ...incoming }, previous)
    const snapshot = this.settings
    this.pendingWrite = this.pendingWrite.then(() => this.write(snapshot)).catch((error: unknown) => {
      console.error('Could not save settings.', error)
    })
    await this.pendingWrite
    for (const listener of this.listeners) listener(snapshot, previous)
    return snapshot
  }

  /** Write via a temporary file so a crash never leaves a truncated settings file. */
  private async write(settings: AppSettings): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      await rename(temp, this.file)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }
}
