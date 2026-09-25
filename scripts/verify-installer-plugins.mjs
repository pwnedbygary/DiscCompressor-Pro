#!/usr/bin/env node
/**
 * Check that the LGPL NSIS plug-ins in the Windows installer, its embedded
 * uninstaller and the portable EXE are the official releases whose sources
 * scripts/collect-sources.mjs puts in the sources archive: nsis7z 19.00 and
 * StdUtils 1.14. If an electron-builder upgrade changes them, this fails so
 * that the archive can be updated too.
 */
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SevenZip from '7z-wasm'

const RELEASE = join(dirname(fileURLToPath(import.meta.url)), '..', 'release')

// SHA-256 of Plugins/x86-unicode/nsis7z.dll in Nsis7z_19.00.7z and of
// Plugins/Unicode/StdUtils.dll in StdUtils.2018-10-27.zip.
const EXPECTED = {
  'nsis7z.dll': 'b393f05e8ff919ef071181050e1873c9a776e1a0ae8329aefff7007d0cadf592',
  'StdUtils.dll': 'b72e9013a6204e9f01076dc38dabbf30870d44dfc66962adbf73619d4331601e'
}

const executables = (await readdir(RELEASE)).filter((name) => /-(Setup|Portable)-[^.]+\.exe$/.test(name))
if (executables.length === 0) {
  console.error(`No installer or portable EXE found in ${RELEASE}`)
  process.exit(1)
}

const messages = []
const sevenZip = await SevenZip({ print: (line) => messages.push(line), printErr: (line) => messages.push(line) })
sevenZip.FS.mkdir('/release')
sevenZip.FS.mount(sevenZip.NODEFS, { root: RELEASE }, '/release')

let failed = false
let unpacked = 0

/** Unpack `files` from the archive at `path` into a new folder; returns the folder, or null on failure. */
function unpack(path, files, label) {
  const out = `/out-${(unpacked += 1)}`
  sevenZip.FS.mkdir(out)
  messages.length = 0
  const code = sevenZip.callMain(['e', '-y', `-o${out}`, path, ...files])
  if (code === 0) return out
  console.error(`Could not unpack ${label} (7-Zip exit code ${code}):\n${messages.join('\n')}`)
  failed = true
  return null
}

function hashOf(path) {
  try {
    return createHash('sha256').update(sevenZip.FS.readFile(path)).digest('hex')
  } catch {
    return null
  }
}

/** Check the plug-ins in `dir`; `required` lists those that must be there. */
function check(dir, label, required) {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const actual = hashOf(`${dir}/${name}`)
    if (actual === expected) {
      console.log(`${label}: ${name} is the official release`)
    } else if (actual !== null || required.includes(name)) {
      console.error(`${label}: ${name} is ${actual === null ? 'missing' : `unexpected (${actual})`}; update scripts/collect-sources.mjs and this check`)
      failed = true
    }
  }
}

for (const executable of executables) {
  const path = `/release/${executable}`
  const plugins = unpack(path, Object.keys(EXPECTED).map((name) => `$PLUGINSDIR/${name}`), executable)
  if (plugins) check(plugins, executable, Object.keys(EXPECTED))
  if (!executable.includes('-Setup-')) continue
  // The installer writes an uninstaller, which carries its own copies of the plug-ins it uses.
  const uninstallerDir = unpack(path, ['$R0/*.exe'], `the uninstaller in ${executable}`)
  const [uninstaller] = uninstallerDir ? sevenZip.FS.readdir(uninstallerDir).filter((name) => name.endsWith('.exe')) : []
  if (!uninstaller) {
    if (uninstallerDir) console.error(`${executable}: no uninstaller found`)
    failed = true
    continue
  }
  const uninstallerPlugins = unpack(`${uninstallerDir}/${uninstaller}`, Object.keys(EXPECTED).map((name) => `$PLUGINSDIR/${name}`), uninstaller)
  if (uninstallerPlugins) check(uninstallerPlugins, `${executable} → ${uninstaller}`, ['StdUtils.dll'])
}
process.exit(failed ? 1 : 0)
