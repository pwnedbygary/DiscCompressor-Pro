import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  type BrowserWindow,
  Menu,
  type Tray,
  app,
  dialog,
  powerSaveBlocker,
  session,
  shell
} from 'electron'
import { IPC } from '@shared/api'
import type { AppCommand } from '@shared/types'
import { type JobEventBatcher, registerIpc } from './ipc'
import { JobRunner } from './jobs/runner'
import { WorkDirJournal } from './jobs/workDirs'
import { registerAppScheme, serveRenderer } from './protocol'
import { inputKindOf } from './scan'
import { SettingsStore } from './settings'
import { ToolRegistry } from './tools'
import { createTray } from './tray'
import { createMainWindow } from './window'

app.setName('DiscCompressor Pro')
// Keep using v1's settings directory, which was named after the package.
app.setPath('userData', join(app.getPath('appData'), 'disccompressor-pro'))
if (process.platform === 'win32') app.setAppUserModelId('com.disccompressor.pro')

registerAppScheme()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void main()
}

/** Image files or folders passed on the command line ("Open with", drag onto the executable). */
function pathsFromArgv(argv: string[], cwd: string): string[] {
  // Chromium may put its switches before the app path, so skip by value rather than position.
  const appPath = app.isPackaged ? null : app.getAppPath()
  const paths: string[] = []
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    const path = resolve(cwd, arg)
    if (path === appPath) continue
    try {
      if (statSync(path).isDirectory() || inputKindOf(path)) paths.push(path)
    } catch {
      // Not a path.
    }
  }
  return paths
}

async function main(): Promise<void> {
  const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
  const workDirs = new WorkDirJournal(join(app.getPath('userData'), 'work-dirs.json'))
  await Promise.all([settings.load(), workDirs.open()])
  const tools = new ToolRegistry()

  let window: BrowserWindow | null = null
  let tray: Tray | null = null
  let batcher: JobEventBatcher | null = null
  let rendererReady = false
  let pendingPaths: string[] = pathsFromArgv(process.argv, process.cwd())
  let quitting = false
  let quitConfirmed = false
  let rendererBusy = false
  let sleepBlocker: number | null = null
  let lastRendererCrash = 0

  /** Keep the system awake while the queue runs or any job is still working. */
  const updateSleepBlocker = (): void => {
    const busy = rendererBusy || runner.activeCount > 0
    if (busy && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension')
    if (!busy && sleepBlocker !== null) {
      powerSaveBlocker.stop(sleepBlocker)
      sleepBlocker = null
    }
  }

  const runner = new JobRunner({
    settings: () => settings.get(),
    tools: (refresh) => tools.get(settings.get(), refresh),
    emit: (event) => batcher?.push(event),
    trash: (path) => shell.trashItem(path),
    workDirs,
    onActiveChange: () => updateSleepBlocker()
  })

  const showWindow = (): void => {
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  const sendCommand = (command: AppCommand): void => {
    window?.webContents.send(IPC.command, command)
  }

  const deliverPaths = (): void => {
    if (!window || !rendererReady || pendingPaths.length === 0) return
    window.webContents.send(IPC.openPaths, pendingPaths)
    pendingPaths = []
  }

  const updateTray = (): void => {
    const wanted = settings.get().minimizeToTray
    if (wanted && !tray) {
      tray = createTray({ show: showWindow, command: sendCommand, quit: () => app.quit() })
    } else if (!wanted && tray) {
      tray.destroy()
      tray = null
    }
  }

  /** Ask before cancelling running jobs. Returns true if it is fine to quit. */
  const confirmQuit = (): boolean => {
    if (quitConfirmed || runner.activeCount === 0) return true
    // The window may be hidden in the tray, and the question must not appear behind other windows.
    showWindow()
    const options = {
      type: 'warning' as const,
      buttons: ['Cancel jobs and quit', 'Keep running'],
      defaultId: 1,
      cancelId: 1,
      title: 'Jobs are running',
      message: `${runner.activeCount === 1 ? 'A job is' : `${runner.activeCount} jobs are`} still running.`,
      detail: 'Quitting now cancels them and removes their unfinished output.'
    }
    const choice = window ? dialog.showMessageBoxSync(window, options) : dialog.showMessageBoxSync(options)
    return choice === 0
  }

  const quitAfterCancelling = (): void => {
    quitConfirmed = true
    quitting = true
    void runner.shutdown().finally(() => app.quit())
  }

  app.on('second-instance', (_event, argv, workingDirectory) => {
    pendingPaths.push(...pathsFromArgv(argv, workingDirectory))
    showWindow()
    deliverPaths()
  })

  app.on('before-quit', (event) => {
    if (quitConfirmed) return
    if (runner.activeCount > 0) {
      event.preventDefault()
      if (confirmQuit()) quitAfterCancelling()
      return
    }
    quitting = true
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Jobs are cancelled before quitting; this only catches a tool that outlived its job.
  app.on('will-quit', () => runner.killAll())

  await app.whenReady()

  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  // Only desktop notifications are ever requested; refuse everything else.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'notifications'))
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'notifications')

  const rendererDir = join(import.meta.dirname, '../renderer')
  if (existsSync(rendererDir)) serveRenderer(rendererDir)

  batcher = registerIpc({
    window: () => window,
    settings,
    tools,
    runner,
    onRendererReady: () => {
      rendererReady = true
      deliverPaths()
    },
    onBusyChange: (busy) => {
      rendererBusy = busy
      updateSleepBlocker()
    }
  })

  window = createMainWindow(settings.get(), (state) => void settings.update({ window: state }))
  window.on('close', (event) => {
    if (quitConfirmed) return
    if (!quitting && tray && settings.get().minimizeToTray) {
      event.preventDefault()
      window?.hide()
      return
    }
    if (runner.activeCount > 0) {
      event.preventDefault()
      if (confirmQuit()) quitAfterCancelling()
      else quitting = false
    }
  })
  window.on('minimize', () => {
    if (tray && settings.get().minimizeToTray) window?.hide()
  })
  window.on('closed', () => {
    window = null
    rendererReady = false
  })
  window.webContents.on('did-start-loading', () => {
    rendererReady = false
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`The window's renderer process exited (${details.reason}).`)
    rendererBusy = false
    updateSleepBlocker()
    if (details.reason === 'clean-exit') return
    // The queue lived in the page, so a reloaded page could neither show nor cancel the jobs it started.
    const cancelled = runner.activeCount
    const now = Date.now()
    // Reload once; a renderer that keeps crashing is left alone rather than restarted in a loop.
    const reload = now - lastRendererCrash > 30_000
    lastRendererCrash = now
    void runner.cancelAll().then(() => {
      if (!window || window.isDestroyed() || !reload) return
      const current = window
      current.webContents.once('did-finish-load', () => {
        void dialog.showMessageBox(current, {
          type: 'warning',
          title: 'DiscCompressor Pro',
          message: 'The window stopped working and was reloaded.',
          detail:
            cancelled > 0
              ? `${cancelled === 1 ? 'The running job was' : `${cancelled} running jobs were`} cancelled and ${cancelled === 1 ? 'its' : 'their'} unfinished output removed. Add the images again to convert them.`
              : 'No jobs were running.'
        })
      })
      current.webContents.reload()
    })
  })

  updateTray()
  settings.onChange((next, previous) => {
    if (next.minimizeToTray !== previous.minimizeToTray) updateTray()
  })
}
