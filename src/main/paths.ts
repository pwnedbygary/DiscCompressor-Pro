import { join } from 'node:path'
import { app } from 'electron'

/** Directory with runtime resources such as icons. */
export function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
}

// electron-builder's names for platforms (its ${os} file macro), used for resources/bin/<os>-<arch>.
const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { win32: 'win', linux: 'linux', darwin: 'mac' }

/** Directory with the chdman/maxcso binaries shipped with the app, if any. */
export function bundledBinDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'bin')
  return join(app.getAppPath(), 'resources', 'bin', `${OS_NAMES[process.platform] ?? process.platform}-${process.arch}`)
}

export function iconPath(file: string): string {
  return join(resourcesDir(), 'icons', file)
}
