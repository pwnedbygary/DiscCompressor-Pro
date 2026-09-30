#!/usr/bin/env node
/**
 * Write a .zsync file next to the AppImage of this version in release/. The update
 * information of appimage-update.mjs points AppImageUpdate, GearLever and
 * other tools to these files, from which they download only the parts of a
 * new AppImage that differ from the one they have. Run after electron-builder;
 * needs zsyncmake (the zsync package on Debian and Ubuntu).
 */
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UPDATE_INFORMATION, readUpdateInformation } from './appimage-update.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE = join(ROOT, 'release')

function fail(message) {
  console.error(message)
  process.exit(1)
}

const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const name = `DiscCompressorPro-${version}-x86_64.AppImage`
const path = join(RELEASE, name)
// The tools look for the latest release's .zsync by the file name pattern in the update information.
const pattern = UPDATE_INFORMATION.split('|').at(-1)
const matches = new RegExp(`^${pattern.replace(/[.+?^${}()[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
if (!matches.test(`${name}.zsync`)) fail(`${name}.zsync does not match ${pattern}, which the update information names`)
const embedded = await readUpdateInformation(path).catch((error) => fail(`Could not read ${path}: ${error.message}`))
if (embedded !== UPDATE_INFORMATION) fail(`${name} has the update information "${embedded}" instead of "${UPDATE_INFORMATION}"`)
// A relative URL makes the tools download the AppImage from wherever they found its .zsync file.
const result = spawnSync('zsyncmake', ['-u', name, '-o', `${path}.zsync`, path], { stdio: 'inherit' })
if (result.error) fail(`Could not run zsyncmake: ${result.error.message}`)
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`Wrote ${name}.zsync`)
