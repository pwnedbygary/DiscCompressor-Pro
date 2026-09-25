#!/usr/bin/env node
/**
 * Write resources/licenses/THIRD_PARTY_NOTICES.txt: what a release contains
 * besides the app's own code and where the licence texts are, followed by the
 * licence of every npm package in the app. The packages are those the build
 * recorded in its bundles (see bundledPackages in electron.vite.config.ts)
 * plus the production dependencies packaged in node_modules, so run
 * `npm run build` first.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ELECTRON, checkElectronVersion } from './electron-sources.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = join(ROOT, 'resources', 'licenses', 'THIRD_PARTY_NOTICES.txt')
const BUNDLES = ['main', 'preload', 'renderer'].map((bundle) => join(ROOT, 'node_modules', '.cache', 'dcp', `bundled-packages-${bundle}.json`))

const HEADER = `THIRD-PARTY NOTICES

DiscCompressor Pro runs two command-line tools, which are shipped in the app's
resources/bin folder. The licence texts named below are in this folder.

chdman 0.289, part of MAME (https://www.mamedev.org/)
  Windows: chdman.exe from the official MAME 0.289 Windows x64 release,
           https://github.com/mamedev/mame/releases/tag/mame0289
  Linux:   built from the unmodified MAME 0.289 source release by
           scripts/build-linux-tools.sh (see resources/bin/BUILD-INFO.txt)
  Licence: chdman's own code is under the BSD 3-Clause licence; MAME as a whole
           is made available under the GNU General Public License. See
           chdman/COPYING.txt and the texts in chdman/legal. chdman includes
           expat (MIT), FLAC (BSD 3-Clause), the LZMA SDK (public domain), utf8proc
           (MIT), zlib (zlib licence) and zstd (BSD 3-Clause): chdman/third-party.
           The Windows build also contains the MinGW-w64 runtime
           (chdman/mingw-w64-runtime.txt) and LLVM's C++ runtime libraries, whose
           licence (Apache 2.0 with LLVM Exceptions) needs no notice in binaries.
           MAME is a registered trademark of Gregory Ember.

maxcso 1.13.0 by Unknown W. Brackets (https://github.com/unknownbrackets/maxcso)
  Windows: maxcso.exe from the official release,
           https://github.com/unknownbrackets/maxcso/releases/tag/v1.13.0
  Linux:   built from the unmodified v1.13.0 source release by
           scripts/build-linux-tools.sh (see resources/bin/BUILD-INFO.txt)
  Licence: ISC (maxcso/LICENSE.txt). maxcso contains code from 7-Zip (GNU LGPL
           2.1 or later), Zopfli (Apache 2.0), libdeflate (MIT), LZ4 (BSD
           2-Clause), libuv (MIT) and zlib (zlib licence): maxcso/.

The Linux copies of both tools are statically linked so that they run on any
x86-64 distribution. They contain the GNU C Library (GNU LGPL 2.1 or later,
linux/glibc-LGPL-2.1.txt), the GCC runtime libraries (GNU GPL 3 with the GCC
Runtime Library Exception, linux/), and maxcso also libuv, LZ4 and zlib. The
packages they came from are listed in resources/bin/BUILD-INFO.txt, and their
copyright files are in resources/bin/licenses.

The AppImage starts with type2-runtime 20251108 (MIT), which contains musl libc
(MIT), libfuse 3.15.0 (GNU LGPL 2.1), squashfuse 0.5.2 (BSD 2-Clause), zstd
(BSD 3-Clause) and zlib (zlib licence): appimage/.

The Windows installer and portable EXE are built with NSIS (zlib licence,
windows-installer/NSIS-COPYING.txt) and use its UAC (zlib licence), WinShell
(freeware), StdUtils 1.14 (GNU LGPL 2.1) and nsis7z 19.00 (7-Zip code, GNU LGPL
2.1 or later) plug-ins: windows-installer/.

The app runs on Electron ${ELECTRON.version} (Chromium ${ELECTRON.chromium}). Electron's and
Chromium's licences are in LICENSE.electron.txt and LICENSES.chromium.html
next to the app's executable. Chromium contains components under the GNU LGPL,
among them FFmpeg, which is the separate library ffmpeg.dll (Windows) or
libffmpeg.so (Linux) next to the executable, and parts of Blink.

Source code: every release publishes DiscCompressorPro-<version>-sources.tar
next to its installers. It contains the source of the (L)GPL components of the
bundled tools, the AppImage runtime and the installer plug-ins named above, and
everything needed to rebuild the bundled tools and relink them with a modified
library: the MAME and maxcso sources, the Debian/Ubuntu source packages of the
libraries in the Linux tools, the AppImage runtime with libfuse and squashfuse,
and the nsis7z (with 7-Zip) and StdUtils plug-ins. It also contains Chromium's
FFmpeg at the revision Electron ${ELECTRON.version} is built from
(${ELECTRON.ffmpeg}).
The complete sources of Electron and Chromium are at
https://github.com/electron/electron/tree/v${ELECTRON.version} and
https://chromium.googlesource.com/chromium/src/+/refs/tags/${ELECTRON.chromium}.
The app itself is at https://github.com/pwnedbygary/DiscCompressor-Pro.

The app is built from the open-source packages below.
`

// koffi's native module, which the Windows app loads, is compiled with these
// header-only libraries from koffi's vendor/ folder (which has no package.json).
const KOFFI_VENDORED = { 'node-addon-api': 'MIT', 'node-api-headers': 'MIT' }

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function licenseText(dir) {
  const names = (await readdir(dir)).sort(byCodePoint)
  const file = names.find((name) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(name))
  return file ? (await readFile(join(dir, file), 'utf8')).trim() : null
}

/** The folder of package `name` as Node resolves it from `fromDir`. */
async function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', ...name.split('/'))
    try {
      await readFile(join(candidate, 'package.json'))
      return candidate
    } catch {
      if (dir === ROOT || dirname(dir) === dir) throw new Error(`Package ${name} (needed by ${relative(ROOT, fromDir) || 'the app'}) is not installed`)
    }
  }
}

/** Collect the package in `dir` and its production dependencies. */
async function collect(dir, seen) {
  if (seen.has(dir)) return
  const pkg = await readJson(join(dir, 'package.json')).catch(() => {
    throw new Error(`No package at ${relative(ROOT, dir)}`)
  })
  seen.set(dir, pkg)
  for (const dependency of Object.keys(pkg.dependencies ?? {})) await collect(await resolvePackage(dependency, dir), seen)
}

function section(title, text) {
  return `${'-'.repeat(78)}\n${title}\n${'-'.repeat(78)}\n\n${text}\n`
}

async function main() {
  await checkElectronVersion(ROOT)
  const seen = new Map()
  for (const file of BUNDLES) {
    const dirs = await readJson(file).catch(() => {
      throw new Error(`${file} is missing; run npm run build first`)
    })
    for (const dir of dirs) await collect(join(ROOT, ...dir.split('/')), seen)
  }
  const app = await readJson(join(ROOT, 'package.json'))
  for (const name of Object.keys(app.dependencies ?? {})) await collect(await resolvePackage(name, ROOT), seen)

  const packages = [...seen].map(([dir, pkg]) => ({ dir, pkg })).sort((a, b) => byCodePoint(a.pkg.name, b.pkg.name) || byCodePoint(a.pkg.version, b.pkg.version))
  const sections = []
  for (const { dir, pkg } of packages) {
    const text = await licenseText(dir)
    if (!text) throw new Error(`No licence file found for ${pkg.name} in ${relative(ROOT, dir).split(sep).join('/')}`)
    sections.push(section(`${pkg.name} ${pkg.version} (${pkg.license ?? 'see below'})`, text))
    if (pkg.name !== 'koffi') continue
    for (const [name, license] of Object.entries(KOFFI_VENDORED)) {
      const vendoredText = await licenseText(join(dir, 'vendor', name))
      if (!vendoredText) throw new Error(`No licence file found for koffi's vendored ${name}`)
      sections.push(section(`${name} (${license}), vendored in koffi and compiled into its native module`, vendoredText))
    }
  }
  const koffi = packages.some(({ pkg }) => pkg.name === 'koffi')
    ? "The native module koffi loads is published separately for each platform\n(e.g. @koromix/koffi-win32-x64) under koffi's licence.\n\n"
    : ''
  await writeFile(OUTPUT, `${HEADER}\n${koffi}${sections.join('\n')}`, 'utf8')
  console.log(`Wrote ${OUTPUT} (${packages.length} packages)`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
