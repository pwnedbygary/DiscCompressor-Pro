import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import type { AppUpdater } from 'electron-updater'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REPOSITORY_URL, releaseUrl } from '@shared/project'
import type { UpdateStatus } from '@shared/types'
import { type Installation, UpdateError, Updater, type UpdaterDependencies, updateSupport } from './updater'

/** Stands in for electron-updater's AppUpdater: the test decides what each call does and which events follow. */
class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = false
  disableDifferentialDownload = false
  disableWebInstaller = false
  requestHeaders: Record<string, string> | null = null
  logger: unknown = console
  checkForUpdates = vi.fn((): Promise<unknown> => {
    this.emit('update-not-available', { version: '2.3.0' })
    return Promise.resolve({ isUpdateAvailable: false, updateInfo: { version: '2.3.0' } })
  })
  downloadUpdate = vi.fn((): Promise<string[]> => Promise.resolve([]))
  quitAndInstall = vi.fn()

  /** Make the next checks find `version`. */
  offer(version: string): void {
    this.checkForUpdates.mockImplementation(() => {
      this.emit('update-available', { version })
      return Promise.resolve({ isUpdateAvailable: true, updateInfo: { version } })
    })
  }

  /** Make downloads finish, reporting progress on the way. */
  deliver(version: string): void {
    this.downloadUpdate.mockImplementation(() => {
      this.emit('download-progress', { percent: 42.5 })
      this.emit('update-downloaded', { version })
      return Promise.resolve([])
    })
  }
}

function setup(options: Partial<UpdaterDependencies> = {}) {
  const fake = new FakeUpdater()
  const changes: UpdateStatus[] = []
  const deps: UpdaterDependencies = {
    support: 'install',
    differential: true,
    load: vi.fn(() => Promise.resolve(fake as unknown as AppUpdater)),
    automatic: () => true,
    busy: () => false,
    onChange: (status) => changes.push(status),
    now: () => 1_000,
    ...options
  }
  return { fake, changes, deps, updater: new Updater(deps) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the repository', () => {
  it('is the same where the app, the AppImage update information and the updater look for releases', () => {
    const { homepage } = JSON.parse(readFileSync('package.json', 'utf8')) as { homepage: string }
    expect(homepage).toBe(REPOSITORY_URL)
    const publish = /^publish:\n {2}provider: github\n {2}owner: (\S+)\n {2}repo: (\S+)$/m.exec(readFileSync('electron-builder.yml', 'utf8'))
    expect(publish && `https://github.com/${publish[1]}/${publish[2]}`).toBe(REPOSITORY_URL)
    expect(releaseUrl('2.3.0')).toBe(`${REPOSITORY_URL}/releases/tag/v2.3.0`)
  })
})

describe('updateSupport', () => {
  const copy = (overrides: Partial<Installation>): Installation => ({
    isPackaged: true,
    platform: 'win32',
    env: {},
    execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\DiscCompressor Pro\\DiscCompressor Pro.exe',
    exists: () => true,
    canWrite: () => true,
    ...overrides
  })

  it('installs updates of the installed Windows app and of an AppImage in a folder it can write to', () => {
    const exists = vi.fn(() => true)
    expect(updateSupport(copy({ exists }))).toBe('install')
    expect(exists).toHaveBeenCalledWith('C:\\Users\\me\\AppData\\Local\\Programs\\DiscCompressor Pro\\Uninstall DiscCompressor Pro.exe')
    const canWrite = vi.fn(() => true)
    expect(updateSupport(copy({ platform: 'linux', env: { APPIMAGE: '/home/me/Apps/DiscCompressorPro-2.3.0-x86_64.AppImage' }, canWrite }))).toBe('install')
    expect(canWrite).toHaveBeenCalledWith('/home/me/Apps')
  })

  it('only points other copies to the new version, and never updates a build run from source', () => {
    expect(updateSupport(copy({ env: { PORTABLE_EXECUTABLE_FILE: 'D:\\DiscCompressorPro-2.3.0-Portable-x64.exe' } }))).toBe('download')
    // An unpacked copy has no uninstaller; running the installer would not update it.
    expect(updateSupport(copy({ exists: () => false }))).toBe('download')
    expect(updateSupport(copy({ platform: 'linux', env: { APPIMAGE: '/opt/DiscCompressorPro.AppImage' }, canWrite: () => false }))).toBe('download')
    expect(updateSupport(copy({ platform: 'linux' }))).toBe('none')
    expect(updateSupport(copy({ isPackaged: false }))).toBe('none')
    expect(updateSupport(copy({ platform: 'darwin' }))).toBe('none')
  })
})

describe('Updater', () => {
  it('reports a new release without downloading it, and what each check found', async () => {
    const { fake, changes, updater } = setup({ differential: false })
    fake.offer('2.4.0')
    expect(await updater.check()).toEqual({ support: 'install', state: 'available', version: '2.4.0', progress: null, error: null, failed: null, checkedAt: 1_000 })
    expect(changes.map((status) => status.state)).toEqual(['checking', 'available'])
    expect(fake).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: true, disableDifferentialDownload: true, disableWebInstaller: true })
    // No random ID of this copy goes to GitHub.
    expect(fake.requestHeaders).toEqual({ 'x-user-staging-id': '00000000-0000-0000-0000-000000000000' })

    fake.checkForUpdates.mockReset().mockImplementation(() => {
      fake.emit('update-not-available', { version: '2.3.0' })
      return Promise.resolve({ isUpdateAvailable: false })
    })
    expect(await updater.check()).toMatchObject({ state: 'up-to-date', version: null })
    // An updater that is not active checks nothing and returns null.
    fake.checkForUpdates.mockResolvedValue(null)
    expect(await updater.check()).toMatchObject({ state: 'idle' })
    // Without an event, the result tells what the check found.
    fake.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: '2.4.1' } })
    expect(await updater.check()).toMatchObject({ state: 'available', version: '2.4.1' })
  })

  it('keeps the first line of an error, which electron-updater follows with headers and a body', async () => {
    const { fake, updater } = setup()
    fake.checkForUpdates.mockImplementation(() => {
      const error = new Error('Cannot find latest-linux.yml in the latest release artifacts\nHeaders: {"server":"github.com"}')
      fake.emit('error', error)
      return Promise.reject(error)
    })
    expect(await updater.check()).toMatchObject({ state: 'error', failed: 'check', error: 'Cannot find latest-linux.yml in the latest release artifacts' })
    fake.checkForUpdates.mockRejectedValue(new Error('x'.repeat(400)))
    expect((await updater.check()).error).toHaveLength(300)
  })

  it('says which step failed, so the page offers the right way to try again', async () => {
    const { fake, updater } = setup()
    fake.offer('2.4.0')
    await updater.check()
    // A failed daily check while an update is available is not a failed download.
    fake.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(await updater.check()).toMatchObject({ state: 'error', failed: 'check', version: '2.4.0' })
    await expect(updater.download()).rejects.toThrow('There is no update to download')

    await updater.check()
    fake.downloadUpdate.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
    await updater.download()
    expect(updater.current).toMatchObject({ state: 'error', failed: 'download', error: 'net::ERR_CONNECTION_RESET' })

    fake.deliver('2.4.0')
    await updater.download()
    expect(updater.current).toMatchObject({ state: 'downloaded', version: '2.4.0', progress: 1, failed: null })
    fake.quitAndInstall.mockImplementation(() => fake.emit('error', new Error("EACCES: permission denied, unlink '/opt/DiscCompressorPro.AppImage'")))
    await updater.install()
    expect(updater.current).toMatchObject({ state: 'error', failed: 'install' })
  })

  it('downloads once, reporting progress, and does not check again once the update is downloaded', async () => {
    const { fake, changes, updater } = setup()
    await expect(updater.download()).rejects.toThrow(UpdateError)
    fake.offer('2.4.0')
    await updater.check()
    let finish = (): void => undefined
    fake.downloadUpdate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            fake.emit('update-downloaded', { version: '2.4.0' })
            resolve([])
          }
        })
    )
    const first = updater.download()
    await updater.download()
    fake.emit('download-progress', { percent: 42.5 })
    expect(updater.current).toMatchObject({ state: 'downloading', progress: 0.425 })
    finish()
    await first
    expect(fake.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(changes.at(-1)).toMatchObject({ state: 'downloaded' })
    expect(await updater.check()).toMatchObject({ state: 'downloaded' })
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('restarts into the downloaded update once, and only when the queue is not working', async () => {
    let busy = true
    const { fake, updater } = setup({ busy: () => busy })
    await expect(updater.install()).rejects.toThrow('No update has been downloaded')
    fake.offer('2.4.0')
    fake.deliver('2.4.0')
    await updater.check()
    await updater.download()

    await expect(updater.install()).rejects.toThrow(/queue/)
    expect(fake.quitAndInstall).not.toHaveBeenCalled()
    busy = false
    await Promise.all([updater.install(), updater.install()])
    expect(updater.current.state).toBe('installing')
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('only points copies it cannot update to new versions, and never checks from source', async () => {
    const portable = setup({ support: 'download' })
    portable.fake.offer('2.4.0')
    await portable.updater.check()
    await expect(portable.updater.download()).rejects.toThrow(/cannot install updates/)

    const source = setup({ support: 'none' })
    expect(await source.updater.check()).toMatchObject({ support: 'none', state: 'idle' })
    expect(source.deps.load).not.toHaveBeenCalled()
  })

  it('loads electron-updater again after it failed to load', async () => {
    const fake = new FakeUpdater()
    const load = vi.fn().mockRejectedValueOnce(new Error('Cannot find module')).mockResolvedValue(fake)
    const { updater } = setup({ load })
    expect(await updater.check()).toMatchObject({ state: 'error', error: 'Cannot find module' })
    expect(await updater.check()).toMatchObject({ state: 'up-to-date' })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('checks by itself shortly after starting and then once a day, counting time the computer slept', async () => {
    vi.useFakeTimers()
    let automatic = true
    const { fake, updater } = setup({ automatic: () => automatic, now: () => Date.now() })
    const hour = 60 * 60 * 1000
    updater.start()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fake.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(23 * hour)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(hour)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2)
    // A day asleep: timers stood still, the clock did not.
    vi.setSystemTime(Date.now() + 25 * hour)
    await vi.advanceTimersByTimeAsync(hour)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(3)
    automatic = false
    await vi.advanceTimersByTimeAsync(48 * hour)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(3)
    automatic = true
    await vi.advanceTimersByTimeAsync(hour)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(4)
    updater.stop()
    await vi.advanceTimersByTimeAsync(48 * hour)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(4)
  })

  it('counts the check made when automatic checks are turned on towards the daily one', async () => {
    vi.useFakeTimers()
    const { fake, updater } = setup({ now: () => Date.now() })
    updater.start()
    updater.checkAutomatically()
    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 10_000)
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2)
    updater.stop()
  })
})
