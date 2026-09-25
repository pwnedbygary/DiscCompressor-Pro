#!/usr/bin/env node
/**
 * Fetch everything the Windows build bundles, on any operating system:
 *
 * - chdman.exe from the official MAME 0.289 Windows x64 release and
 *   maxcso.exe from the official maxcso 1.13.0 release, verified against
 *   pinned SHA-256 checksums, into resources/bin/win-x64;
 * - koffi's Windows x64 binary (used to measure maxcso's progress), verified
 *   against the integrity hash in package-lock.json, into build/native/koffi.
 *
 * Archives are unpacked with 7-Zip compiled to WebAssembly, so no system
 * archiver is needed. Downloads are cached in node_modules/.cache/dcp-tools.
 */
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SevenZip from '7z-wasm'
import { describe, fetchWithRetry, sha256, verifyDigest } from './download.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = process.env.DCP_TOOLS_CACHE ?? join(ROOT, 'node_modules', '.cache', 'dcp-tools')
const BIN_OUT = join(ROOT, 'resources', 'bin', 'win-x64')
const KOFFI_OUT = join(ROOT, 'build', 'native', 'koffi', 'win32_x64')

const DOWNLOADS = [
  {
    // SHA-256 as published in the release's SHA256SUMS file.
    url: 'https://github.com/mamedev/mame/releases/download/mame0289/mame0289b_x64.exe',
    file: 'mame0289b_x64.exe',
    sha256: 'a1aa7912168c9d1b05e611906bc21b8b9be3935822aead36d12a1da363150b7d',
    extract: 'chdman.exe'
  },
  {
    url: 'https://github.com/unknownbrackets/maxcso/releases/download/v1.13.0/maxcso_v1.13.0_windows.7z',
    file: 'maxcso_v1.13.0_windows.7z',
    sha256: '51362619adbb8d219af11321b56b16d4912184203c0127a1b51566c7d151df4d',
    extract: 'maxcso.exe'
  }
]

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Download `url` into the cache unless a copy that passes `verify` (which throws) is already there. */
async function download(url, file, verify) {
  const path = join(CACHE, file)
  if (await exists(path)) {
    try {
      verify(await readFile(path))
      return path
    } catch {
      // Download it again.
    }
  }
  console.log(`Downloading ${url}`)
  const data = await fetchWithRetry(url)
  verify(data)
  await writeFile(path, data)
  return path
}

async function sevenZip() {
  const messages = []
  const instance = await SevenZip({ print: (line) => messages.push(line), printErr: (line) => messages.push(line) })
  instance.FS.mkdir('/cache')
  instance.FS.mount(instance.NODEFS, { root: CACHE }, '/cache')
  return (args) => {
    messages.length = 0
    const code = instance.callMain(args)
    if (code !== 0) throw new Error(`7-Zip failed (${code}):\n${messages.join('\n')}`)
  }
}

function isWindowsExecutable(data) {
  return data.length > 0x40 && data.toString('latin1', 0, 2) === 'MZ'
}

async function koffiPackage() {
  const lock = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'))
  const entry = lock.packages?.['node_modules/@koromix/koffi-win32-x64']
  if (!entry?.resolved || !entry.integrity?.startsWith('sha512-')) {
    throw new Error('package-lock.json has no entry for @koromix/koffi-win32-x64; run npm install first')
  }
  return { url: entry.resolved, version: entry.version, sha512: entry.integrity.slice('sha512-'.length) }
}

async function main() {
  await mkdir(CACHE, { recursive: true })
  await rm(BIN_OUT, { recursive: true, force: true })
  await rm(KOFFI_OUT, { recursive: true, force: true })
  await mkdir(BIN_OUT, { recursive: true })
  await mkdir(KOFFI_OUT, { recursive: true })
  const run = await sevenZip()

  for (const item of DOWNLOADS) {
    await download(item.url, item.file, (data) => verifyDigest(data, item.sha256, item.file))
    const unpacked = join(CACHE, 'unpacked', item.file)
    await rm(unpacked, { recursive: true, force: true })
    run(['e', '-y', `-o/cache/unpacked/${item.file}`, `/cache/${item.file}`, item.extract])
    const exe = join(unpacked, item.extract)
    if (!isWindowsExecutable(await readFile(exe))) throw new Error(`${item.extract} is not a Windows executable`)
    await copyFile(exe, join(BIN_OUT, item.extract))
    console.log(`Installed ${item.extract} (${sha256(await readFile(exe))})`)
  }

  const koffi = await koffiPackage()
  const tarball = `koffi-win32-x64-${koffi.version}.tgz`
  await download(koffi.url, tarball, (data) => verifyDigest(data, koffi.sha512, tarball, 'sha512', 'base64'))
  await rm(join(CACHE, 'unpacked', 'koffi'), { recursive: true, force: true })
  run(['x', '-y', '-o/cache/unpacked/koffi', `/cache/${tarball}`])
  run(['x', '-y', '-o/cache/unpacked/koffi', `/cache/unpacked/koffi/${tarball.replace(/\.tgz$/, '.tar')}`, 'package/win32_x64/koffi.node'])
  await copyFile(join(CACHE, 'unpacked', 'koffi', 'package', 'win32_x64', 'koffi.node'), join(KOFFI_OUT, 'koffi.node'))
  console.log(`Installed koffi ${koffi.version} win32_x64/koffi.node`)
}

main().catch((error) => {
  console.error(describe(error))
  process.exit(1)
})
