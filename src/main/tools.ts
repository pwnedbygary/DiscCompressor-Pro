import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { ToolName, ToolStatus, ToolsStatus } from '@shared/types'
import { bundledBinDir } from './paths'

const EXECUTABLE_SUFFIX = process.platform === 'win32' ? '.exe' : ''
const PROBE_TIMEOUT_MS = 5000

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    if (process.platform !== 'win32') await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function findOnPath(name: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? '')
    .split(delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, name + EXECUTABLE_SUFFIX)
    if (await isExecutableFile(candidate)) return candidate
  }
  return null
}

/** Run a tool briefly and return everything it printed. */
function captureOutput(path: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

// chdman always prints "chdman - MAME Compressed Hunks of Data (CHD) manager 0.289 (mame0289)";
// maxcso --version prints "maxcso v1.13.0".
const VERSION_PROBES: Record<ToolName, { args: string[]; pattern: RegExp }> = {
  chdman: { args: [], pattern: /Compressed Hunks of Data \(CHD\) manager\s+(\d+\.\d+)/ },
  maxcso: { args: ['--version'], pattern: /maxcso v?(\d+(?:\.\d+)+)/ }
}

async function probe(name: ToolName, path: string, source: ToolStatus['source']): Promise<ToolStatus> {
  try {
    const output = await captureOutput(path, VERSION_PROBES[name].args)
    const version = VERSION_PROBES[name].pattern.exec(output)?.[1] ?? null
    if (!version) {
      return { name, path, source, version: null, error: `${path} does not look like ${name}` }
    }
    return { name, path, source, version, error: null }
  } catch (error) {
    return { name, path, source, version: null, error: `Could not run ${path}: ${(error as Error).message}` }
  }
}

/**
 * Locate a tool: an explicit path from the settings wins, then the copy
 * bundled with the app, then the system PATH.
 */
export async function resolveTool(name: ToolName, customPath: string): Promise<ToolStatus> {
  if (customPath) {
    if (await isExecutableFile(customPath)) return probe(name, customPath, 'custom')
    return { name, path: customPath, source: 'custom', version: null, error: `${customPath} is not an executable file` }
  }
  const bundled = join(bundledBinDir(), name + EXECUTABLE_SUFFIX)
  if (await isExecutableFile(bundled)) return probe(name, bundled, 'bundled')
  const onPath = await findOnPath(name)
  if (onPath) return probe(name, onPath, 'system')
  return {
    name,
    path: null,
    source: null,
    version: null,
    error: `${name} was not found. Install it or choose its location in Settings.`
  }
}

export class ToolRegistry {
  private cache: { key: string; status: Promise<ToolsStatus> } | null = null

  get(paths: { chdmanPath: string; maxcsoPath: string }, refresh = false): Promise<ToolsStatus> {
    const key = `${paths.chdmanPath}\u0000${paths.maxcsoPath}`
    if (!refresh && this.cache?.key === key) return this.cache.status
    const status = Promise.all([resolveTool('chdman', paths.chdmanPath), resolveTool('maxcso', paths.maxcsoPath)]).then(
      ([chdman, maxcso]) => ({ chdman, maxcso })
    )
    this.cache = { key, status }
    return status
  }
}
