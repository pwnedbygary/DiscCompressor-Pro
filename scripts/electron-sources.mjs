/**
 * The Chromium and FFmpeg revisions of the Electron release the app ships
 * with: Electron's DEPS file pins chromium_version, and Chromium's DEPS file
 * at that tag pins ffmpeg_revision. Update all three when Electron is
 * upgraded; the notices and the sources archive refuse to use stale values.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const ELECTRON = {
  version: '44.4.5',
  chromium: '152.0.7977.130',
  ffmpeg: '2b68d2babae73714846961fb0ee47e3b3d2e39a9'
}

export const CHROMIUM_FFMPEG_GIT = 'https://chromium.googlesource.com/chromium/third_party/ffmpeg'

/** Throw unless the installed Electron is the release described above. */
export async function checkElectronVersion(root) {
  const { version } = JSON.parse(await readFile(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'))
  if (version !== ELECTRON.version) {
    throw new Error(`Electron ${version} is installed, but scripts/electron-sources.mjs describes ${ELECTRON.version}; update its Chromium and FFmpeg revisions`)
  }
}
