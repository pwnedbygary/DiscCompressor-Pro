import { type FileHandle, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { CdiInfo, CdiTrackInfo } from '@shared/types'
import {
  CdiError,
  FIRST_PREGAP_FRAMES,
  SESSION_GAP_FRAMES,
  SESSION_PREGAP_FRAMES,
  type CdiRegion,
  type CdiTrackLayout,
  buildCdiDescriptor,
  cdiCueMode,
  cdiSheetLayout,
  cdiStoredSectorBytes
} from '../formats/cdi'
import { parseCue } from '../formats/cue'
import { trackFileNames } from './plan'

/*
 * Dreamcast games on CD-R (MIL-CD, "selfboot" discs) have two sessions: the
 * first holds an audio or data track, the second the data track that boots,
 * with the IP.BIN boot sector as its first sector. Its file system refers to
 * addresses from the start of the disc, so the data track must stay at the
 * address the gap between the sessions puts it (usually LBA 11702).
 *
 * CHD files do not record sessions. Flycast, the emulator that reads them,
 * treats a disc with several tracks that ends with a data track as such a CD-R
 * and moves that track back by the standard gap (core/imgread/chd.cpp); these
 * functions put tracks where it expects them in both directions. Flycast 2.7
 * and earlier refuse a CHD whose tracks have pregaps, and count a stored
 * pregap of the second session's track in a cue sheet on top of the gap, so
 * neither is written.
 */

export class CdiConversionError extends Error {}

const CHUNK_BYTES = 4 * 1024 * 1024
const DREAMCAST_BOOT = Buffer.from('SEGA SEGAKATANA ', 'latin1')
const ISO_VOLUME_DESCRIPTOR = Buffer.from([0x01, 0x43, 0x44, 0x30, 0x30, 0x31])

function msf(frames: number): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(Math.floor(frames / 4500))}:${pad(Math.floor(frames / 75) % 60)}:${pad(frames % 75)}`
}

/** Where the 2048 bytes of user data start in a sector, or null for audio and Mode 2 Form 2 sectors. */
function userDataOffset(mode: number, sectorSize: number): number | null {
  if (mode === 0 || sectorSize === 2324) return null
  if (sectorSize === 2048) return 0
  if (mode === 1) return 16
  return sectorSize === 2336 ? 8 : 24
}

interface Progress {
  signal: AbortSignal
  onProgress: (fraction: number) => void
}

class Copier {
  private done = 0
  private readonly buffer = Buffer.allocUnsafe(CHUNK_BYTES)

  constructor(
    private readonly total: number,
    private readonly progress: Progress
  ) {}

  /** Append `sectors` sectors from `source`, keeping the first `keep` of every `stride` bytes. */
  async copy(source: FileHandle, position: number, sectors: number, stride: number, keep: number, output: FileHandle): Promise<void> {
    const perChunk = Math.max(1, Math.floor(CHUNK_BYTES / stride))
    for (let sector = 0; sector < sectors; sector += perChunk) {
      this.progress.signal.throwIfAborted()
      const count = Math.min(perChunk, sectors - sector)
      const { bytesRead } = await source.read(this.buffer, 0, count * stride, position + sector * stride)
      if (bytesRead !== count * stride) throw new CdiConversionError('A track ends before the length its image records')
      if (keep !== stride) {
        for (let i = 1; i < count; i += 1) this.buffer.copyWithin(i * keep, i * stride, i * stride + keep)
      }
      await output.write(this.buffer, 0, count * keep)
      this.advance(count * keep)
    }
  }

  async zeros(sectors: number, size: number, output: FileHandle): Promise<void> {
    const perChunk = Math.max(1, Math.floor(CHUNK_BYTES / size))
    const zero = Buffer.alloc(Math.min(perChunk, Math.max(sectors, 1)) * size)
    for (let sector = 0; sector < sectors; sector += perChunk) {
      this.progress.signal.throwIfAborted()
      const count = Math.min(perChunk, sectors - sector)
      await output.write(zero, 0, count * size)
      this.advance(count * size)
    }
  }

  private advance(bytes: number): void {
    this.done += bytes
    if (this.total > 0) this.progress.onProgress(Math.min(this.done / this.total, 1))
  }
}

async function withFile<T>(path: string, flags: string, use: (file: FileHandle) => Promise<T>): Promise<T> {
  const file = await open(path, flags)
  try {
    return await use(file)
  } finally {
    await file.close()
  }
}

interface SheetTrack {
  number: number
  path: string
  /** Byte offset of the track's first stored sector in its file. */
  offset: number
  cueMode: string
  mode: 0 | 1 | 2
  sectorSize: number
  /** Frames stored in the file, stored pregap included. */
  frames: number
  /** Pregap frames stored before INDEX 01. */
  storedPregap: number
  /** Pregap frames that are not stored (PREGAP). */
  virtualPregap: number
  postgap: number
}

function trackLine(track: { number: number }, mode: string): string {
  return `  TRACK ${String(track.number).padStart(2, '0')} ${mode}`
}

/** Cue sheet lines for a track stored on its own in `file`. */
function sheetLines(
  file: string,
  track: Pick<SheetTrack, 'number' | 'cueMode' | 'storedPregap' | 'virtualPregap' | 'postgap'> & { flags?: string[] }
): string[] {
  const lines = [`FILE "${file}" BINARY`, trackLine(track, track.cueMode)]
  if (track.flags && track.flags.length > 0) lines.push(`    FLAGS ${track.flags.join(' ')}`)
  if (track.virtualPregap > 0) lines.push(`    PREGAP ${msf(track.virtualPregap)}`)
  if (track.storedPregap > 0) lines.push('    INDEX 00 00:00:00')
  lines.push(`    INDEX 01 ${msf(track.storedPregap)}`)
  if (track.postgap > 0) lines.push(`    POSTGAP ${msf(track.postgap)}`)
  return lines
}

/** The cue sheet FLAGS of a track's control bits; pre-emphasis and four channels only apply to audio. */
function controlFlags(track: CdiTrackInfo): string[] {
  const flags = track.control & 0x2 ? ['DCP'] : []
  if (track.mode === 0 && track.control & 0x8) flags.push('4CH')
  if (track.mode === 0 && track.control & 0x1) flags.push('PRE')
  return flags
}

/**
 * Write the frames of a track's region: those the track stores, then those
 * of the next track's pregap if both tracks have the same format, and zeros
 * for the rest.
 */
async function writeRegion(
  copier: Copier,
  input: FileHandle,
  output: FileHandle,
  region: CdiRegion,
  track: CdiTrackInfo,
  next: CdiTrackInfo | undefined
): Promise<void> {
  const sources = [track, ...(next && next.mode === track.mode && next.sectorSize === track.sectorSize ? [next] : [])]
  let frame = region.start
  while (frame < region.end) {
    const source = sources.find((s) => s.start <= frame && frame < s.start + s.stored)
    if (source) {
      const count = Math.min(region.end, source.start + source.stored) - frame
      const stride = cdiStoredSectorBytes(source)
      await copier.copy(input, source.offset + (frame - source.start) * stride, count, stride, track.sectorSize, output)
      frame += count
    } else {
      const upcoming = sources.map((s) => s.start).filter((start) => start > frame)
      const until = Math.min(region.end, ...upcoming)
      await copier.zeros(until - frame, track.sectorSize, output)
      frame = until
    }
  }
}

/**
 * Write the tracks of a CDI image as BIN files, one per track with Redump
 * names, and a cue sheet with, if `sessions`, REM SESSION lines. Tracks keep
 * the addresses the image records, laid out by `cdiSheetLayout`, so each file
 * starts at its track's INDEX 01. Subchannel data is not kept. Returns the file
 * names, sheet first.
 */
export async function splitCdi(
  options: Progress & { source: string; info: CdiInfo; dir: string; baseName: string; sessions: boolean }
): Promise<string[]> {
  const { source, info, dir, baseName } = options
  let regions: CdiRegion[]
  try {
    regions = cdiSheetLayout(info).regions
  } catch (error) {
    throw error instanceof CdiError ? new CdiConversionError(error.message) : error
  }
  const names = trackFileNames(baseName, info.tracks.length)
  const total = info.tracks.reduce((sum, track, index) => {
    const region = regions[index] as CdiRegion
    return sum + (region.end - region.start) * track.sectorSize
  }, 0)
  const copier = new Copier(total, options)
  const lines: string[] = []
  await withFile(source, 'r', async (input) => {
    for (const [index, track] of info.tracks.entries()) {
      const region = regions[index] as CdiRegion
      const name = names[index] as string
      await withFile(join(dir, name), 'w', (output) => writeRegion(copier, input, output, region, track, info.tracks[index + 1]))
      if (options.sessions && info.sessions > 1 && info.tracks[index - 1]?.session !== track.session) {
        lines.push(`REM SESSION ${String(track.session).padStart(2, '0')}`)
      }
      lines.push(...sheetLines(name, { number: track.number, cueMode: cdiCueMode(track), storedPregap: 0, virtualPregap: 0, postgap: 0, flags: controlFlags(track) }))
    }
  })
  const sheet = `${baseName}.cue`
  await writeFile(join(dir, sheet), `${lines.join('\r\n')}\r\n`)
  return [sheet, ...names]
}

const CUE_MODES: Record<string, { mode: 0 | 1 | 2; sectorSize: number }> = {
  AUDIO: { mode: 0, sectorSize: 2352 },
  'MODE1/2048': { mode: 1, sectorSize: 2048 },
  'MODE1/2352': { mode: 1, sectorSize: 2352 },
  'MODE2/2048': { mode: 2, sectorSize: 2048 },
  'MODE2/2324': { mode: 2, sectorSize: 2324 },
  'MODE2/2336': { mode: 2, sectorSize: 2336 },
  'MODE2/2352': { mode: 2, sectorSize: 2352 }
}

/**
 * The tracks of a cue sheet written by chdman extractcd, where tracks may
 * share a file: a track's frames run from its INDEX 00 (or 01) to the next
 * track's, and its bytes follow those of the tracks before it.
 */
async function readSheetTracks(sheet: string): Promise<SheetTrack[]> {
  const cue = parseCue(await readFile(sheet, 'utf8'))
  const tracks: SheetTrack[] = []
  for (const file of cue.files) {
    const path = join(dirname(sheet), file.name)
    const { size } = await stat(path)
    let offset = 0
    for (const [index, track] of file.tracks.entries()) {
      const format = CUE_MODES[track.mode]
      if (!format) throw new CdiConversionError(`Tracks of type ${track.mode} cannot be converted`)
      const start = index === 0 ? 0 : (track.index0 ?? track.index1 ?? 0)
      const next = file.tracks[index + 1]
      const frames = next ? (next.index0 ?? next.index1 ?? 0) - start : (size - offset) / format.sectorSize
      const storedPregap = (track.index1 ?? start) - start
      if (!Number.isInteger(frames) || frames <= storedPregap || offset + frames * format.sectorSize > size) {
        throw new CdiConversionError(`Track ${track.number} of the extracted cue sheet does not fit its file`)
      }
      tracks.push({ number: track.number, path, offset, cueMode: track.mode, ...format, frames, storedPregap, virtualPregap: track.pregap, postgap: track.postgap })
      offset += frames * format.sectorSize
    }
  }
  if (tracks.length === 0) throw new CdiConversionError('The extracted cue sheet lists no tracks')
  return tracks
}

async function readSector(track: SheetTrack, sector: number): Promise<Buffer | null> {
  return withFile(track.path, 'r', async (file) => {
    const buffer = Buffer.alloc(track.sectorSize)
    const { bytesRead } = await file.read(buffer, 0, track.sectorSize, track.offset + sector * track.sectorSize)
    return bytesRead === track.sectorSize ? buffer : null
  })
}

/** Whether the last track of a disc starts with a Dreamcast boot sector, i.e. the disc is a Dreamcast CD-R. */
async function isDreamcastCdr(tracks: SheetTrack[]): Promise<boolean> {
  const last = tracks.at(-1) as SheetTrack
  const offset = userDataOffset(last.mode, last.sectorSize)
  if (tracks.length < 2 || offset === null) return false
  const sector = await readSector(last, last.storedPregap)
  return sector !== null && sector.subarray(offset, offset + DREAMCAST_BOOT.length).equals(DREAMCAST_BOOT)
}

/** The ISO 9660 volume identifier field of a data track (padded with spaces), if it has one. */
async function volumeIdOf(track: SheetTrack): Promise<string | undefined> {
  const offset = userDataOffset(track.mode, track.sectorSize)
  if (offset === null || track.frames < track.storedPregap + 17) return undefined
  const sector = await readSector(track, track.storedPregap + 16)
  if (!sector?.subarray(offset, offset + 6).equals(ISO_VOLUME_DESCRIPTOR)) return undefined
  return sector.toString('latin1', offset + 40, offset + 72).split('\0')[0]
}

/**
 * Build a DiscJuggler image from a cue sheet written by chdman extractcd. A
 * Dreamcast CD-R gets its second session back, with the data track where
 * Flycast places it when it reads the CHD; any other disc keeps one session.
 * Returns the number of sessions.
 */
export async function buildCdiFromSheet(options: Progress & { sheet: string; output: string }): Promise<number> {
  const tracks = await readSheetTracks(options.sheet)
  const form2 = tracks.find((track) => track.sectorSize === 2324)
  if (form2) throw new CdiConversionError(`Track ${form2.number} holds Mode 2 Form 2 sectors (2,324 bytes each), which a CDI image cannot store`)
  const dreamcast = await isDreamcastCdr(tracks)

  // Track addresses as Flycast computes them for a CHD, in frames from 00:00:00.
  const layouts: CdiTrackLayout[] = []
  let next = FIRST_PREGAP_FRAMES
  for (const [index, track] of tracks.entries()) {
    const pregap = track.virtualPregap + track.storedPregap
    const secondSession = dreamcast && index === tracks.length - 1
    const index1 = next + pregap + (secondSession ? SESSION_GAP_FRAMES - Math.min(pregap, SESSION_PREGAP_FRAMES) : 0)
    // Every sector from 00:00:00 is stored, except the gap between sessions; a
    // new session's first track keeps the usual 150-frame pregap.
    const stored = index === 0 ? index1 : secondSession ? Math.max(pregap, SESSION_PREGAP_FRAMES) : pregap
    const length = track.frames - track.storedPregap
    layouts.push({
      session: secondSession ? 2 : 1,
      mode: track.mode,
      sectorSize: track.sectorSize,
      subchannelSize: 0,
      pregap: stored,
      length,
      start: index1 - stored,
      control: track.mode === 0 ? 0 : 4
    })
    next = index1 + length
  }

  const total = layouts.reduce((sum, layout) => sum + (layout.pregap + layout.length) * layout.sectorSize, 0)
  const copier = new Copier(total, options)
  const lastData = [...tracks].reverse().find((track) => track.mode !== 0)
  const volumeId = lastData ? await volumeIdOf(lastData) : undefined
  let descriptor: Buffer
  try {
    descriptor = buildCdiDescriptor(layouts, { imageName: basename(options.output), volumeId })
  } catch (error) {
    throw error instanceof CdiError ? new CdiConversionError(error.message) : error
  }
  await withFile(options.output, 'w', async (output) => {
    for (const [index, track] of tracks.entries()) {
      const layout = layouts[index] as CdiTrackLayout
      await copier.zeros(layout.pregap - track.storedPregap, track.sectorSize, output)
      await withFile(track.path, 'r', (input) => copier.copy(input, track.offset, track.frames, track.sectorSize, track.sectorSize, output))
    }
    await output.write(descriptor)
  })
  return dreamcast ? 2 : 1
}

/**
 * Rewrite the cue sheet chdman extractcd wrote for a Dreamcast CD-R the way
 * Flycast's cue reader finds the data track where it is in the CHD: one BIN
 * file per track (Redump names, as `trackFileNames` gives them), the two
 * sessions marked, and pregaps stored as zeros, since it ignores PREGAP lines
 * and cannot read tracks of different sector sizes from one file. The second
 * session's track starts at INDEX 01, as the gap between the sessions covers
 * 150 frames of its pregap (Flycast 2.7 and earlier would count them twice); a
 * longer pregap pads the first session instead. The files the sheet referred
 * to before are removed; other discs are left as chdman wrote them. Returns
 * whether the disc is a Dreamcast CD-R.
 */
export async function splitSheetTracks(options: Progress & { sheet: string }): Promise<boolean> {
  const { sheet } = options
  const tracks = await readSheetTracks(sheet)
  if (!(await isDreamcastCdr(tracks))) return false
  const dir = dirname(sheet)
  const names = trackFileNames(basename(sheet, '.cue'), tracks.length)
  const originals = [...new Set(tracks.map((track) => track.path))]
  if (originals.some((path) => names.some((name) => join(dir, name) === path))) {
    throw new CdiConversionError('The extracted track files already have the names of the split ones')
  }
  const last = tracks.at(-1) as SheetTrack
  const padding = Math.max(last.virtualPregap + last.storedPregap - SESSION_PREGAP_FRAMES, 0)
  const layout = tracks.map((track, index) => {
    const secondSession = index === tracks.length - 1
    return {
      zeros: secondSession ? 0 : track.virtualPregap,
      skip: secondSession ? track.storedPregap : 0,
      padding: index === tracks.length - 2 ? padding : 0
    }
  })
  const copier = new Copier(
    tracks.reduce((sum, track, index) => {
      const { zeros, skip, padding: pad } = layout[index] as (typeof layout)[number]
      return sum + (zeros + track.frames - skip + pad) * track.sectorSize
    }, 0),
    options
  )
  const lines: string[] = []
  for (const [index, track] of tracks.entries()) {
    const name = names[index] as string
    const { zeros, skip, padding: pad } = layout[index] as (typeof layout)[number]
    await withFile(track.path, 'r', (input) =>
      withFile(join(dir, name), 'w', async (output) => {
        await copier.zeros(zeros, track.sectorSize, output)
        await copier.copy(input, track.offset + skip * track.sectorSize, track.frames - skip, track.sectorSize, track.sectorSize, output)
        await copier.zeros(pad, track.sectorSize, output)
      })
    )
    if (index === 0 || index === tracks.length - 1) lines.push(`REM SESSION ${index === 0 ? '01' : '02'}`)
    lines.push(...sheetLines(name, { ...track, storedPregap: zeros + track.storedPregap - skip, virtualPregap: 0 }))
  }
  await writeFile(sheet, `${lines.join('\r\n')}\r\n`)
  for (const path of originals) await rm(path, { force: true })
  return true
}
