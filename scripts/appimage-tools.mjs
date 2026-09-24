#!/usr/bin/env node
/**
 * Run a command (electron-builder) with APPIMAGE_TOOLS_PATH pointing at
 * electron-builder's AppImage toolset minus the libraries it would otherwise
 * copy into every AppImage (libappindicator3, libindicator3, libgconf-2,
 * libnotify, libXss, libXtst). Electron 44 does not link or load any of them
 * except libnotify, which it loads from the system when present, and shipping
 * them would add (L)GPL binaries to the release.
 *
 * The toolset is downloaded from electron-builder-binaries and verified
 * against the checksum electron-builder 26.16.1 pins for `toolsets.appimage: 1.0.3`.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, fetchWithRetry, sha256, verifyDigest } from './download.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = process.env.DCP_TOOLS_CACHE ?? join(ROOT, 'node_modules', '.cache', 'dcp-tools')
const ARCHIVE = 'appimage-tools-runtime-20251108.tar.gz'
const URL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/appimage@1.0.3/${ARCHIVE}`
const SHA256 = '84021a78ee214ae6fd33a2d62a92ba25542dd10bc86bf117a9b2d0bba44e7665'
const TOOLS = join(CACHE, 'appimage-tools-20251108')

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function download() {
  const path = join(CACHE, ARCHIVE)
  if ((await exists(path)) && sha256(await readFile(path)) === SHA256) return path
  console.log(`Downloading ${URL}`)
  const data = await fetchWithRetry(URL)
  verifyDigest(data, SHA256, ARCHIVE)
  await writeFile(path, data)
  return path
}

async function prepare() {
  await mkdir(CACHE, { recursive: true })
  const archive = await download()
  await rm(TOOLS, { recursive: true, force: true })
  await mkdir(TOOLS, { recursive: true })
  const untar = spawnSync('tar', ['-xzf', archive, '-C', TOOLS], { stdio: 'inherit' })
  if (untar.status !== 0) throw new Error('Could not unpack the AppImage toolset')
  // electron-builder requires the directory to exist, so it is emptied rather than removed.
  for (const arch of await readdir(join(TOOLS, 'lib'))) {
    const dir = join(TOOLS, 'lib', arch)
    for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true })
  }
}

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('Usage: node scripts/appimage-tools.mjs <command> [args…]')
  process.exit(2)
}
try {
  await prepare()
} catch (error) {
  console.error(describe(error))
  process.exit(1)
}
const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, APPIMAGE_TOOLS_PATH: TOOLS } })
if (result.error) console.error(`Could not run ${command}: ${result.error.message}`)
else if (result.signal) console.error(`${command} was terminated by ${result.signal}`)
process.exit(result.status ?? 1)
