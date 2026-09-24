import { opendir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { INPUT_EXTENSIONS, isoLayoutForChdTrack, isoLayoutForCueMode } from '@shared/formats'
import type { InputKind, IsoLayout, ScanResult, ScannedInput, TrackInfo } from '@shared/types'
import { TRACK_SECTOR_BYTES, normalizeTrackType, readChdInfo } from './formats/chd'
import { readCisoInfo } from './formats/ciso'
import { parseCue } from './formats/cue'
import { parseGdi } from './formats/gdi'

const MAX_SHEET_BYTES = 1024 * 1024
const MAX_WALK_ENTRIES = 200_000
const MAX_WALK_DEPTH = 32
const SCAN_CONCURRENCY = 8
const SKIPPED_DIRECTORIES = new Set(['$RECYCLE.BIN', 'System Volume Information'])

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function naturalCompare(a: string, b: string): number {
  return naturalCollator.compare(a, b)
}

export function inputKindOf(path: string): InputKind | null {
  return INPUT_EXTENSIONS[extname(path).toLowerCase()] ?? null
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

async function readSheet(path: string): Promise<string> {
  const size = await fileSize(path)
  if (size === null) throw new Error('File not found')
  if (size > MAX_SHEET_BYTES) throw new Error('Sheet file is too large')
  return readFile(path, 'utf8')
}

function emptyInput(path: string, kind: InputKind): ScannedInput {
  return {
    path,
    name: basename(path),
    kind,
    size: 0,
    files: [path],
    media: null,
    tracks: [],
    isoLayout: null,
    isoBlocker: null,
    chd: null,
    ciso: null,
    problem: null
  }
}

/** Sum the sheet and its track files; report the first missing one. */
async function measureFiles(files: string[]): Promise<{ size: number; missing: string | null }> {
  let size = 0
  for (const file of files) {
    const bytes = await fileSize(file)
    if (bytes === null) return { size, missing: file }
    size += bytes
  }
  return { size, missing: null }
}

async function scanCue(input: ScannedInput): Promise<void> {
  const sheet = parseCue(await readSheet(input.path))
  const dir = dirname(input.path)
  const trackFiles = [...new Set(sheet.files.map((file) => join(dir, file.name)))]
  input.files = [input.path, ...trackFiles]
  input.media = 'cd'
  input.tracks = sheet.files.flatMap((file) =>
    file.tracks.map((track) => ({
      number: track.number,
      type: track.mode,
      sectorSize: Number(/\/(\d+)$/.exec(track.mode)?.[1] ?? (track.mode === 'AUDIO' ? 2352 : 0)),
      file: file.name
    }))
  )
  if (sheet.files.length === 0 || input.tracks.length === 0) {
    input.problem = 'The cue sheet does not list any tracks'
    return
  }
  const { size, missing } = await measureFiles(input.files)
  input.size = size
  if (missing) {
    input.problem = `Missing track file: ${basename(missing)}`
    return
  }

  const [file] = sheet.files
  const [track] = file?.tracks ?? []
  const layout: IsoLayout | null = track ? isoLayoutForCueMode(track.mode) : null
  if (input.tracks.length > 1) {
    input.isoBlocker = `The disc has ${input.tracks.length} tracks; only single-data-track discs can become an ISO`
  } else if (!file || !track || track.mode === 'AUDIO') {
    input.isoBlocker = 'The disc is an audio CD'
  } else if (!layout) {
    input.isoBlocker = `Tracks of type ${track.mode} cannot be converted to ISO`
  } else if (file.type !== 'BINARY') {
    input.isoBlocker = `Track files of type ${file.type || 'unknown'} cannot be converted to ISO`
  } else if (track.index1 !== null && track.index1 !== 0) {
    input.isoBlocker = 'The data track does not start at the beginning of its file'
  } else {
    const trackBytes = (await fileSize(join(dir, file.name))) ?? 0
    if (trackBytes % layout.sectorSize !== 0) {
      input.isoBlocker = `The track file is not a whole number of ${layout.sectorSize}-byte sectors`
    } else {
      input.isoLayout = layout
    }
  }
}

async function scanGdi(input: ScannedInput): Promise<void> {
  const tracks = parseGdi(await readSheet(input.path))
  const dir = dirname(input.path)
  input.files = [input.path, ...new Set(tracks.map((track) => join(dir, track.file)))]
  input.media = 'gdrom'
  input.tracks = tracks.map((track) => ({
    number: track.number,
    type: track.type === 0 ? 'AUDIO' : 'MODE1',
    sectorSize: track.sectorSize,
    file: track.file
  }))
  const { size, missing } = await measureFiles(input.files)
  input.size = size
  if (missing) input.problem = `Missing track file: ${basename(missing)}`
}

async function scanIso(input: ScannedInput): Promise<void> {
  const size = await fileSize(input.path)
  input.size = size ?? 0
  if (size === null) input.problem = 'File not found'
  else if (size === 0) input.problem = 'The file is empty'
  else if (size % 2048 !== 0) input.isoBlocker = 'The file size is not a multiple of 2048 bytes'
}

function chdIsoLayout(tracks: TrackInfo[]): { layout: IsoLayout | null; blocker: string | null } {
  if (tracks.length === 0) return { layout: null, blocker: 'The CHD has no track information' }
  if (tracks.length > 1) {
    return { layout: null, blocker: `The disc has ${tracks.length} tracks; only single-data-track discs can become an ISO` }
  }
  const [track] = tracks as [TrackInfo]
  if (track.type === 'AUDIO') return { layout: null, blocker: 'The disc is an audio CD' }
  const layout = isoLayoutForChdTrack(track.type)
  return layout ? { layout, blocker: null } : { layout: null, blocker: `Tracks of type ${track.type} cannot be converted to ISO` }
}

async function scanChd(input: ScannedInput): Promise<void> {
  input.size = (await fileSize(input.path)) ?? 0
  const chd = await readChdInfo(input.path)
  input.chd = chd
  input.tracks = chd.tracks.map((track) => ({
    ...track,
    type: normalizeTrackType(track.type),
    sectorSize: track.sectorSize || TRACK_SECTOR_BYTES[normalizeTrackType(track.type)] || 0
  }))
  if (chd.media === 'cd' || chd.media === 'dvd' || chd.media === 'gdrom') input.media = chd.media
  if (chd.media === 'cd') {
    const { layout, blocker } = chdIsoLayout(input.tracks)
    input.isoLayout = layout
    input.isoBlocker = blocker
  }
  if (chd.hasParent) input.problem = 'This CHD depends on a parent CHD, which is not supported'
}

async function scanCiso(input: ScannedInput): Promise<void> {
  input.size = (await fileSize(input.path)) ?? 0
  input.ciso = await readCisoInfo(input.path)
}

const SCANNERS: Record<InputKind, (input: ScannedInput) => Promise<void>> = {
  cue: scanCue,
  gdi: scanGdi,
  iso: scanIso,
  chd: scanChd,
  cso: scanCiso,
  zso: scanCiso,
  dax: scanCiso
}

/** Inspect a single image file. Problems are reported on the result, never thrown. */
export async function scanInput(path: string): Promise<ScannedInput> {
  const absolute = resolve(path)
  const kind = inputKindOf(absolute)
  if (!kind) throw new Error(`Unsupported file type: ${basename(absolute)}`)
  const input = emptyInput(absolute, kind)
  try {
    await SCANNERS[kind](input)
  } catch (error) {
    input.problem = `Could not read ${input.name}: ${(error as Error).message}`
  }
  return input
}

async function walk(root: string, found: string[]): Promise<void> {
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  let entries = 0
  while (stack.length > 0) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number }
    let handle
    try {
      handle = await opendir(dir)
    } catch {
      continue
    }
    for await (const entry of handle) {
      if (++entries > MAX_WALK_ENTRIES) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        // Symlinked directories are not followed, which rules out cycles.
        if (depth < MAX_WALK_DEPTH && !entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name)) {
          stack.push({ dir: path, depth: depth + 1 })
        }
      } else if ((entry.isFile() || entry.isSymbolicLink()) && inputKindOf(entry.name)) {
        found.push(path)
      }
    }
  }
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Expand dropped or picked paths (files and folders) into disc images.
 * Track files referenced by a CUE or GDI sheet are not added separately.
 */
export async function scanPaths(paths: string[]): Promise<ScanResult> {
  const skipped: ScanResult['skipped'] = []
  const candidates: string[] = []
  const unsupported: string[] = []

  for (const path of new Set(paths.map((p) => resolve(p)))) {
    let info
    try {
      info = await stat(path)
    } catch {
      skipped.push({ path, reason: 'Not found' })
      continue
    }
    if (info.isDirectory()) {
      const before = candidates.length
      await walk(path, candidates)
      if (candidates.length === before) skipped.push({ path, reason: 'No disc images found in this folder' })
    } else if (inputKindOf(path)) {
      candidates.push(path)
    } else {
      unsupported.push(path)
    }
  }

  const unique = [...new Set(candidates)]
  const inputs = await mapConcurrent(unique, SCAN_CONCURRENCY, scanInput)
  const key = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path)
  const referenced = new Set(
    inputs.filter((input) => input.kind === 'cue' || input.kind === 'gdi').flatMap((input) => input.files.slice(1).map(key))
  )
  const standalone = inputs.filter((input) => !referenced.has(key(input.path)))
  standalone.sort((a, b) => naturalCompare(a.path, b.path))
  // Track files selected together with their sheet are part of that image, not unsupported files.
  for (const path of unsupported) {
    if (!referenced.has(key(path))) skipped.push({ path, reason: 'Not a supported disc image' })
  }
  return { inputs: standalone, skipped }
}
