import { posix, win32 } from 'node:path'
import type { AppUpdater, Logger } from 'electron-updater'
import type { UpdateStatus } from '@shared/types'

const FIRST_CHECK_DELAY_MS = 10_000
/** Timers stop while the computer sleeps, so the time since the last check is looked at every hour. */
const TICK_MS = 60 * 60 * 1000
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_ERROR_LENGTH = 300
/**
 * electron-updater sends a random ID, kept in the settings folder, with every
 * request, for releases rolled out to a share of users. These releases never
 * are, so every copy sends the same ID instead.
 */
const SHARED_STAGING_ID = '00000000-0000-0000-0000-000000000000'

export interface Installation {
  isPackaged: boolean
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  execPath: string
  exists: (path: string) => boolean
  canWrite: (dir: string) => boolean
}

/**
 * How this copy of the app can be updated. electron-updater installs updates
 * of the installed Windows app (which has electron-builder's uninstaller next
 * to it) and of an AppImage (which sets APPIMAGE) in a folder it can replace
 * the file in. Other Windows copies, such as the portable EXE (which sets
 * PORTABLE_EXECUTABLE_FILE), can only point to the new version; builds run
 * from source and Linux copies that are not AppImages are not updated.
 */
export function updateSupport({ isPackaged, platform, env, execPath, exists, canWrite }: Installation): UpdateStatus['support'] {
  if (!isPackaged) return 'none'
  if (platform === 'win32') {
    if (env.PORTABLE_EXECUTABLE_FILE) return 'download'
    return exists(win32.join(win32.dirname(execPath), `Uninstall ${win32.basename(execPath)}`)) ? 'install' : 'download'
  }
  if (platform === 'linux' && env.APPIMAGE) return canWrite(posix.dirname(env.APPIMAGE)) ? 'install' : 'download'
  return 'none'
}

export class UpdateError extends Error {}

export interface UpdaterDependencies {
  support: UpdateStatus['support']
  /** Whether a download can reuse the parts of the current version: the AppImage has a block map, the Windows installer does not. */
  differential: boolean
  /** electron-updater's updater for this platform; loaded when first needed. */
  load: () => Promise<AppUpdater>
  /** Whether to check by itself (the checkForUpdates setting). */
  automatic: () => boolean
  /** Whether restarting now would cancel work: jobs running, or the queue about to start the next one. */
  busy: () => boolean
  onChange: (status: UpdateStatus) => void
  now?: () => number
}

/** The first line of an error, which for electron-updater's HTTP errors is followed by headers and a body. */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const line = message.split('\n')[0]?.trim() || 'Unknown error'
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH - 1)}…` : line
}

/**
 * Finds, downloads and installs new releases with electron-updater, which
 * reads the latest GitHub release's latest.yml (Windows) or latest-linux.yml.
 * Nothing is downloaded without asking; a downloaded update is installed when
 * the user restarts from the app or quits it.
 */
export class Updater {
  private status: UpdateStatus
  private loaded: Promise<AppUpdater> | null = null
  private timer: NodeJS.Timeout | null = null
  private lastAutomaticCheck: number | null = null
  /** What electron-updater is doing, since it reports every failure with the same error event. */
  private operation: NonNullable<UpdateStatus['failed']> = 'check'

  constructor(private readonly deps: UpdaterDependencies) {
    this.status = { support: deps.support, state: 'idle', version: null, progress: null, error: null, failed: null, checkedAt: null }
  }

  get current(): UpdateStatus {
    return this.status
  }

  /** Check a little after the app starts and then once a day, when automatic checks are on. */
  start(): void {
    if (this.deps.support !== 'none') this.schedule(FIRST_CHECK_DELAY_MS)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async check(): Promise<UpdateStatus> {
    const { state } = this.status
    if (this.deps.support === 'none' || state === 'checking' || state === 'downloading' || state === 'downloaded' || state === 'installing') return this.status
    this.operation = 'check'
    this.set({ state: 'checking', error: null, failed: null })
    try {
      const result = await (await this.updater()).checkForUpdates()
      // The events report the outcome; without a result the updater did not check at all.
      if (this.status.state === 'checking') {
        if (!result) this.set({ state: 'idle' })
        else if (result.isUpdateAvailable) this.set({ state: 'available', version: result.updateInfo.version, progress: null, checkedAt: this.now() })
        else this.set({ state: 'up-to-date', version: null, progress: null, checkedAt: this.now() })
      }
    } catch (error) {
      this.fail(error)
    }
    return this.status
  }

  async download(): Promise<void> {
    if (this.deps.support !== 'install') throw new UpdateError('This copy of DiscCompressor Pro cannot install updates; download the new version instead')
    const { state, failed } = this.status
    if (state === 'downloading' || state === 'downloaded' || state === 'installing') return
    if (state !== 'available' && !(state === 'error' && failed === 'download')) throw new UpdateError('There is no update to download')
    this.operation = 'download'
    this.set({ state: 'downloading', progress: 0, error: null, failed: null })
    try {
      await (await this.updater()).downloadUpdate()
    } catch (error) {
      this.fail(error)
    }
  }

  /** Quit, install the downloaded update and start the new version. Runs once. */
  async install(): Promise<void> {
    if (this.status.state === 'installing') return
    if (this.status.state !== 'downloaded') throw new UpdateError('No update has been downloaded')
    if (this.deps.busy()) throw new UpdateError('Wait for the queue to finish, or stop it, before restarting')
    this.operation = 'install'
    // Before quitAndInstall, which reports a failure synchronously.
    this.set({ state: 'installing', error: null, failed: null })
    try {
      ;(await this.updater()).quitAndInstall(true, true)
    } catch (error) {
      this.fail(error)
    }
  }

  /** A check the app makes by itself, such as when automatic checks are turned on; the next one is due a day later. */
  checkAutomatically(): void {
    this.lastAutomaticCheck = this.now()
    void this.check()
  }

  private schedule(delay: number): void {
    this.stop()
    this.timer = setTimeout(() => {
      this.schedule(TICK_MS)
      const due = this.lastAutomaticCheck === null || this.now() - this.lastAutomaticCheck >= CHECK_INTERVAL_MS
      if (this.deps.automatic() && due) this.checkAutomatically()
    }, delay)
  }

  private updater(): Promise<AppUpdater> {
    this.loaded ??= this.deps
      .load()
      .then((updater) => {
        updater.autoDownload = false
        // An update that was downloaded but not installed right away is installed when the app quits.
        updater.autoInstallOnAppQuit = true
        updater.disableDifferentialDownload = !this.deps.differential
        updater.disableWebInstaller = true
        updater.requestHeaders = { 'x-user-staging-id': SHARED_STAGING_ID }
        const logger: Logger = { info: () => undefined, warn: (message) => console.warn(message), error: (message) => console.error(message) }
        updater.logger = logger
        updater.on('update-available', (info) => this.set({ state: 'available', version: info.version, progress: null, checkedAt: this.now() }))
        updater.on('update-not-available', () => this.set({ state: 'up-to-date', version: null, progress: null, checkedAt: this.now() }))
        updater.on('download-progress', (progress) => this.set({ state: 'downloading', progress: Math.min(Math.max(progress.percent / 100, 0), 1) }))
        updater.on('update-downloaded', (info) => this.set({ state: 'downloaded', version: info.version, progress: 1 }))
        updater.on('error', (error) => this.fail(error))
        return updater
      })
      .catch((error: unknown) => {
        this.loaded = null
        throw error
      })
    return this.loaded
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private fail(error: unknown): void {
    this.set({ state: 'error', progress: null, error: describe(error), failed: this.operation })
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch }
    this.deps.onChange(this.status)
  }
}
