#!/usr/bin/env node
/**
 * Write release/DiscCompressorPro-<version>-sources.tar: the source of the
 * (L)GPL components of the bundled tools, the AppImage runtime, the installer
 * plug-ins and Electron's FFmpeg, and everything needed to rebuild the bundled
 * tools and relink them with a modified library. It is published next to the
 * installers of each release.
 *
 * - tools/: the MAME and maxcso source releases the Linux tools are built from
 *   (maxcso also contains 7-Zip code, which is LGPL, in its Windows build) and
 *   scripts/build-linux-tools.sh with the BUILD-INFO.txt of the build.
 * - linux/: the Debian/Ubuntu source packages of the libraries statically linked
 *   into the Linux tools (glibc is LGPL), fetched from Launchpad in the exact
 *   versions BUILD-INFO.txt records. GCC's runtime libraries are covered by the
 *   GCC Runtime Library Exception and are not included.
 * - appimage-runtime/: type2-runtime 20251108, which starts every AppImage, and
 *   the libfuse (LGPL) and squashfuse sources it is built from.
 * - windows-installer/: the NSIS plug-ins in the installer and portable EXE that
 *   are LGPL: nsis7z 19.00 (built on 7-Zip 19.00) and StdUtils 1.14.
 * - electron/: Chromium's FFmpeg at the revision Electron is built from, which
 *   Electron ships as a separate LGPL library (see scripts/electron-sources.mjs).
 *
 * Run it after scripts/build-linux-tools.sh; it needs git and GNU tar. Downloads
 * are verified and cached in $DCP_TOOLS_CACHE (default node_modules/.cache/dcp-tools).
 */
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { describe, fetchWithRetry, sha256, verifyDigest } from './download.mjs'
import { CHROMIUM_FFMPEG_GIT, ELECTRON, checkElectronVersion } from './electron-sources.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = process.env.DCP_TOOLS_CACHE ?? join(ROOT, 'node_modules', '.cache', 'dcp-tools')
const BUILD_INFO = join(ROOT, 'resources', 'bin', 'linux-x64', 'BUILD-INFO.txt')

// These must match what electron-builder 26.16.1 bundles: toolsets.appimage 1.0.3 uses
// type2-runtime 20251108 (see its scripts/common/install-dependencies.sh for the libfuse
// and squashfuse pins), and its default NSIS resources 3.4.1 contain the official
// nsis7z 19.00 and StdUtils 1.14 plug-in DLLs.
const PINNED = {
  'appimage-runtime': [
    ['https://github.com/AppImage/type2-runtime/archive/dd6cebedcbddde9c82f89b011e8e1d40b6e43868.tar.gz', 'type2-runtime-20251108.tar.gz', 'f5fec23be76e50e2445ed2d018bac49b367490fc483c62c4637e99ec705d27ba'],
    ['https://github.com/libfuse/libfuse/releases/download/fuse-3.15.0/fuse-3.15.0.tar.xz', 'fuse-3.15.0.tar.xz', '70589cfd5e1cff7ccd6ac91c86c01be340b227285c5e200baa284e401eea2ca0'],
    ['https://github.com/vasi/squashfuse/archive/0.5.2.tar.gz', 'squashfuse-0.5.2.tar.gz', 'db0238c5981dabbd80ee09ae15387f390091668ca060a7bc38047912491443d3']
  ],
  'windows-installer': [
    ['https://nsis.sourceforge.io/mediawiki/images/6/69/Nsis7z_19.00.7z', 'Nsis7z_19.00.7z', '6f2f3730049926f40442ee0c8b7d3e3dee7ace544d82467ff8059ea3f4201c58'],
    ['https://www.7-zip.org/a/7z1900-src.7z', '7z1900-src.7z', '9ba70a5e8485cf9061b30a2a84fe741de5aeb8dd271aab8889da0e9b3bf1868e'],
    ['https://github.com/lordmulder/stdutils/releases/download/1.14/StdUtils.2018-10-27.zip', 'StdUtils.2018-10-27.zip', '3ffe893dc7477fdb1cac551a86ae017509e1f2d0ebdc7185fd0fbaf20870688c']
  ]
}

const FFMPEG_ARCHIVE = `chromium-ffmpeg-${ELECTRON.ffmpeg}.tar.gz`

/** What this run uses in the cache's sources/ folder; everything else there is left over from other versions. */
const usedSources = new Set()

const README = (version) => `Sources for DiscCompressor Pro ${version}
${'='.repeat(32 + version.length)}

This archive holds the source code of the (L)GPL components of the bundled
tools, the AppImage runtime, the installer plug-ins and Electron's FFmpeg in
the DiscCompressor Pro ${version} release, and what is needed to rebuild the
bundled tools and relink them with a modified library. The application itself
is at https://github.com/pwnedbygary/DiscCompressor-Pro (tag v${version}).

tools/
  mame0289.tar.gz, maxcso-1.13.0.tar.gz
    The unmodified source releases of chdman (MAME 0.289) and maxcso 1.13.0.
    maxcso contains 7-Zip code (GNU LGPL 2.1 or later) in its 7zip/ folder.
  build-linux-tools.sh, BUILD-INFO.txt
    The script that builds the static Linux tools, and the record of the
    toolchain and packages the released binaries were built with.

linux/
  Debian/Ubuntu source packages (.dsc and the files it lists) of the
  libraries statically linked into the Linux tools, in the versions listed
  in BUILD-INFO.txt: glibc (GNU LGPL 2.1 or later), libuv1, lz4 and zlib.
  To relink the tools with a modified C library, install it and run
  build-linux-tools.sh.

appimage-runtime/
  type2-runtime 20251108 (the program at the start of every AppImage) and
  the libfuse 3.15.0 (GNU LGPL 2.1) and squashfuse 0.5.2 sources it is built
  from; type2-runtime's scripts/ show how, including a patch to libfuse.

windows-installer/
  Nsis7z_19.00.7z and 7z1900-src.7z: the nsis7z NSIS plug-in and the 7-Zip
  19.00 source it is built on (GNU LGPL 2.1 or later), used by the installer
  and the portable EXE to unpack the app.
  StdUtils.2018-10-27.zip: the StdUtils 1.14 NSIS plug-in with its source
  (GNU LGPL 2.1).

electron/
  ${FFMPEG_ARCHIVE}
    FFmpeg as Chromium ${ELECTRON.chromium} builds it (chromium/third_party/ffmpeg
    at ${ELECTRON.ffmpeg}; GNU LGPL 2.1 or later), which
    Electron ${ELECTRON.version} ships as the separate library ffmpeg.dll (Windows)
    or libffmpeg.so (Linux). The complete sources of Electron and Chromium,
    which contain further LGPL components such as parts of Blink, are at
    https://github.com/electron/electron/tree/v${ELECTRON.version} and
    https://chromium.googlesource.com/chromium/src/+/refs/tags/${ELECTRON.chromium}.
`

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { maxBuffer: 1 << 30, ...options })
  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed${result.stderr?.length ? `: ${result.stderr.toString().trim()}` : ''}`)
  return result.stdout
}

/** Put a verified copy of `url` at `dest`, using the download cache. */
async function fetchVerified(url, dest, expected) {
  const cached = join(CACHE, 'sources', basename(dest))
  usedSources.add(basename(dest))
  let data = (await exists(cached)) ? await readFile(cached) : null
  if (!data || sha256(data) !== expected) {
    console.log(`Downloading ${url}`)
    data = await fetchWithRetry(url)
    verifyDigest(data, expected, basename(dest))
    await mkdir(dirname(cached), { recursive: true })
    await writeFile(cached, data)
  }
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, data)
}

/** Source packages recorded in BUILD-INFO.txt as "(source: <name> <version>)", without GCC's. */
function sourcePackages(buildInfo) {
  const packages = new Map()
  for (const [, name, version] of buildInfo.matchAll(/\(source: (\S+) (\S+)\)/g)) {
    if (!/^gcc-\d+$/.test(name)) packages.set(`${name} ${version}`, { name, version })
  }
  return [...packages.values()]
}

/** Download a source package from Launchpad, verifying every file against the .dsc. */
async function fetchSourcePackage({ name, version }, dir) {
  const bare = version.replace(/^\d+:/, '')
  const base = `https://launchpad.net/ubuntu/+archive/primary/+sourcefiles/${name}/${encodeURIComponent(version)}`
  const dscName = `${name}_${bare}.dsc`
  console.log(`Fetching source package ${name} ${version}`)
  const dsc = await fetchWithRetry(`${base}/${dscName}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, dscName), dsc)
  const section = /^Checksums-Sha256:\n((?: .+\n)+)/m.exec(dsc.toString('utf8'))
  if (!section) throw new Error(`${dscName} lists no SHA-256 checksums`)
  for (const line of section[1].trim().split('\n')) {
    const [hash, , file] = line.trim().split(/\s+/)
    await fetchVerified(`${base}/${file}`, join(dir, file), hash)
  }
}

/** The environment without the variables that tie git to another repository, as in a git hook. */
function gitEnvironment() {
  const local = new Set(run('git', ['rev-parse', '--local-env-vars']).toString().split('\n'))
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !local.has(name)))
}

/**
 * Archive Chromium's FFmpeg at the pinned commit. git verifies the fetched
 * commit by its hash, a SHA-1 like the repository's object names. So that the
 * archive is the same everywhere, the repository is created without templates,
 * the git settings that change what `git archive` writes are pinned to their
 * defaults, and attributes files outside the repository are ignored. gzipSync
 * uses the zlib bundled with Node (Chromium's), whose output differs from
 * standard zlib's but not between CPUs; a Node release with a different zlib
 * may compress differently.
 */
async function fetchChromiumFfmpeg(dest) {
  const repo = join(CACHE, 'sources', 'chromium-ffmpeg.git')
  usedSources.add(basename(repo))
  const env = gitEnvironment()
  // Named explicitly, because git may refuse to find a bare repository by itself (safe.bareRepository).
  const gitDir = `--git-dir=${repo}`
  const commit = `${ELECTRON.ffmpeg}^{commit}`
  if (!(await exists(repo)) || spawnSync('git', [gitDir, 'cat-file', '-e', commit], { env }).status !== 0) {
    // A new repository for a new revision, so that the objects of earlier ones do not pile up.
    await rm(repo, { recursive: true, force: true })
    run('git', ['init', '--quiet', '--bare', '--template=', '--object-format=sha1', repo], { env })
    console.log(`Fetching Chromium's FFmpeg at ${ELECTRON.ffmpeg}`)
    run('git', [gitDir, 'fetch', '--quiet', '--depth', '1', CHROMIUM_FFMPEG_GIT, ELECTRON.ffmpeg], { env })
  }
  // The repository's own attributes file would change the archive too. Only a repository created
  // from a template, as older versions of this script did, can have one.
  await rm(join(repo, 'info', 'attributes'), { force: true })
  const pinned = ['core.autocrlf=false', 'core.eol=lf', 'tar.umask=0002', 'core.attributesFile=/dev/null'].flatMap((setting) => ['-c', setting])
  const tar = run('git', [...pinned, gitDir, 'archive', '--format=tar', `--prefix=chromium-ffmpeg-${ELECTRON.ffmpeg}/`, commit], {
    env: { ...env, GIT_ATTR_NOSYSTEM: '1' }
  })
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, gzipSync(tar, { level: 9 }))
}

async function main() {
  await checkElectronVersion(ROOT)
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const name = `DiscCompressorPro-${pkg.version}-sources`
  const staging = join(CACHE, 'staging', name)
  await rm(join(CACHE, 'staging'), { recursive: true, force: true })
  await mkdir(staging, { recursive: true })

  // The tool sources, verified against the checksums the build script pins.
  const script = await readFile(join(ROOT, 'scripts', 'build-linux-tools.sh'), 'utf8')
  const pin = (key) => {
    const value = new RegExp(`^${key}=([\\w.-]+)$`, 'm').exec(script)?.[1]
    if (!value) throw new Error(`scripts/build-linux-tools.sh has no ${key}= line, which this script reads`)
    return value
  }
  await mkdir(join(staging, 'tools'), { recursive: true })
  for (const [file, hash] of [
    [`mame${pin('MAME_VERSION')}.tar.gz`, pin('MAME_SHA256')],
    [`maxcso-${pin('MAXCSO_VERSION')}.tar.gz`, pin('MAXCSO_SHA256')]
  ]) {
    const data = await readFile(join(CACHE, file)).catch(() => null)
    if (!data || sha256(data) !== hash) throw new Error(`${file} is missing from ${CACHE}; run scripts/build-linux-tools.sh first`)
    await writeFile(join(staging, 'tools', file), data)
  }
  await copyFile(join(ROOT, 'scripts', 'build-linux-tools.sh'), join(staging, 'tools', 'build-linux-tools.sh'))
  const buildInfo = await readFile(BUILD_INFO, 'utf8').catch(() => {
    throw new Error(`${BUILD_INFO} is missing; run scripts/build-linux-tools.sh first`)
  })
  await writeFile(join(staging, 'tools', 'BUILD-INFO.txt'), buildInfo)

  for (const source of sourcePackages(buildInfo)) {
    await fetchSourcePackage(source, join(staging, 'linux', `${source.name}_${source.version.replace(/^\d+:/, '')}`))
  }
  for (const [folder, files] of Object.entries(PINNED)) {
    for (const [url, file, hash] of files) await fetchVerified(url, join(staging, folder, file), hash)
  }
  await fetchChromiumFfmpeg(join(staging, 'electron', FFMPEG_ARCHIVE))
  await writeFile(join(staging, 'README.txt'), README(pkg.version))

  await mkdir(join(ROOT, 'release'), { recursive: true })
  const output = join(ROOT, 'release', `${name}.tar`)
  // Sorted, with a fixed format, times, owners and permissions, so that the same inputs give the same
  // archive, and without the options GNU tar would otherwise add from TAR_OPTIONS.
  const epoch = process.env.SOURCE_DATE_EPOCH ?? '0'
  const tarEnv = { ...process.env }
  delete tarEnv.TAR_OPTIONS
  const tarArgs = ['--format=gnu', '--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner', '--mode=u+rw,go=rX']
  run('tar', [...tarArgs, '-cf', output, '-C', dirname(staging), name], { env: tarEnv })
  await rm(join(CACHE, 'staging'), { recursive: true, force: true })
  console.log(`Wrote ${output} (${((await stat(output)).size / 1024 / 1024).toFixed(0)} MB)`)

  // Downloads of other versions would otherwise stay in the cache, and in CI's.
  for (const entry of await readdir(join(CACHE, 'sources'))) {
    if (usedSources.has(entry)) continue
    console.log(`Removing ${join(CACHE, 'sources', entry)}`)
    await rm(join(CACHE, 'sources', entry), { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(describe(error))
  process.exit(1)
})
