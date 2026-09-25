import { type FileHandle, open } from 'node:fs/promises'
import type { ChdInfo, TrackInfo } from '@shared/types'

// Layouts and tags from MAME's src/lib/util/chd.h and cdrom.cpp (0.289). All
// header and metadata integers are big-endian.
const MAGIC = 'MComprHD'
const V5_HEADER_BYTES = 124
const METADATA_HEADER_BYTES = 16
const MAX_METADATA_ENTRIES = 512
const MAX_TEXT_METADATA_BYTES = 64 * 1024
const CD_FRAME_BYTES = 2448
const MAX_TRACKS = 99

/** chdman track type → bytes per sector as written by extractcd. */
export const TRACK_SECTOR_BYTES: Record<string, number> = {
  MODE1: 2048,
  MODE1_RAW: 2352,
  MODE2: 2336,
  MODE2_FORM1: 2048,
  MODE2_FORM2: 2324,
  MODE2_FORM_MIX: 2336,
  MODE2_RAW: 2352,
  AUDIO: 2352
}

// Older CHDs may use CUE-style names, which chdman also accepts.
const TYPE_ALIASES: Record<string, string> = {
  'MODE1/2048': 'MODE1',
  'MODE1/2352': 'MODE1_RAW',
  'MODE2/2336': 'MODE2',
  'MODE2/2048': 'MODE2_FORM1',
  'MODE2/2324': 'MODE2_FORM2',
  'MODE2/2352': 'MODE2_RAW'
}

// Order of cdrom_file's CD_TRACK_* enum, used by the binary CHCD metadata.
const TRACK_TYPE_BY_INDEX = ['MODE1', 'MODE1_RAW', 'MODE2', 'MODE2_FORM1', 'MODE2_FORM2', 'MODE2_FORM_MIX', 'MODE2_RAW', 'AUDIO']

const LEGACY_COMPRESSION = ['none', 'zlib', 'zlib+', 'avhu']

export function normalizeTrackType(type: string): string {
  const upper = type.toUpperCase()
  return TYPE_ALIASES[upper] ?? upper
}

function tagName(value: number): string {
  return String.fromCharCode((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

function trackFromText(text: string): TrackInfo | null {
  const number = /TRACK:(\d+)/.exec(text)?.[1]
  const type = /TYPE:(\S+)/.exec(text)?.[1]
  const frames = /FRAMES:(\d+)/.exec(text)?.[1]
  if (!number || !type) return null
  const normalized = normalizeTrackType(type)
  return {
    number: Number(number),
    type: normalized,
    sectorSize: TRACK_SECTOR_BYTES[normalized] ?? 0,
    ...(frames ? { frames: Number(frames) } : {})
  }
}

/** Decode legacy binary CD metadata (CHCD); MAME detects its byte order by the track count. */
export function tracksFromChcd(data: Buffer): TrackInfo[] {
  if (data.length < 4) return []
  let littleEndian = true
  let count = data.readUInt32LE(0)
  if (count > MAX_TRACKS) {
    littleEndian = false
    count = data.readUInt32BE(0)
  }
  if (count > MAX_TRACKS) return []
  const read = (offset: number): number => (littleEndian ? data.readUInt32LE(offset) : data.readUInt32BE(offset))
  const tracks: TrackInfo[] = []
  for (let i = 0; i < count; i += 1) {
    const base = 4 + i * 24
    if (base + 24 > data.length) break
    const type = TRACK_TYPE_BY_INDEX[read(base)] ?? 'MODE1'
    tracks.push({ number: i + 1, type, sectorSize: read(base + 8), frames: read(base + 16) })
  }
  return tracks
}

async function readExactly(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  if (bytesRead !== length) throw new Error('Unexpected end of CHD file')
  return buffer
}

interface Header {
  version: number
  logicalBytes: number
  hunkBytes: number
  unitBytes: number
  metaOffset: number
  codecs: string[]
  hasParent: boolean
}

export function parseChdHeader(buffer: Buffer): Header {
  if (buffer.length < 16 || buffer.toString('latin1', 0, 8) !== MAGIC) throw new Error('Not a CHD file')
  const version = buffer.readUInt32BE(12)
  const need = (bytes: number): void => {
    if (buffer.length < bytes) throw new Error('Truncated CHD header')
  }
  switch (version) {
    case 5: {
      need(V5_HEADER_BYTES)
      const codecs = [16, 20, 24, 28].map((offset) => buffer.readUInt32BE(offset)).filter(Boolean).map(tagName)
      return {
        version,
        codecs: codecs.length > 0 ? codecs : ['none'],
        logicalBytes: Number(buffer.readBigUInt64BE(32)),
        metaOffset: Number(buffer.readBigUInt64BE(48)),
        hunkBytes: buffer.readUInt32BE(56),
        unitBytes: buffer.readUInt32BE(60),
        hasParent: buffer.subarray(104, 124).some((byte) => byte !== 0)
      }
    }
    case 4:
    case 3: {
      need(version === 4 ? 108 : 120)
      const compression = buffer.readUInt32BE(20)
      return {
        version,
        codecs: [LEGACY_COMPRESSION[compression] ?? `type ${compression}`],
        logicalBytes: Number(buffer.readBigUInt64BE(28)),
        metaOffset: Number(buffer.readBigUInt64BE(36)),
        hunkBytes: buffer.readUInt32BE(version === 4 ? 44 : 76),
        unitBytes: 0,
        hasParent: (buffer.readUInt32BE(16) & 1) !== 0
      }
    }
    default:
      throw new Error(`CHD version ${version} is not supported`)
  }
}

export async function readChdInfo(path: string): Promise<ChdInfo> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const header = parseChdHeader(await readExactly(handle, Math.min(V5_HEADER_BYTES, size), 0))

    let media: ChdInfo['media'] = 'raw'
    const textTracks = new Map<number, TrackInfo>()
    let legacyTracks: TrackInfo[] = []
    const visited = new Set<number>()

    let offset = header.metaOffset
    while (offset !== 0 && visited.size < MAX_METADATA_ENTRIES) {
      if (visited.has(offset) || offset + METADATA_HEADER_BYTES > size) break
      visited.add(offset)
      const entry = await readExactly(handle, METADATA_HEADER_BYTES, offset)
      const tag = tagName(entry.readUInt32BE(0))
      const length = entry.readUIntBE(5, 3)
      const next = Number(entry.readBigUInt64BE(8))
      const dataOffset = offset + METADATA_HEADER_BYTES

      if (tag === 'CHT2' || tag === 'CHTR' || tag === 'CHGD' || tag === 'CHGT') {
        if (length <= MAX_TEXT_METADATA_BYTES && dataOffset + length <= size) {
          const track = trackFromText((await readExactly(handle, length, dataOffset)).toString('latin1'))
          if (track) textTracks.set(track.number, track)
        }
        media = tag === 'CHGD' || tag === 'CHGT' ? 'gdrom' : media === 'gdrom' ? media : 'cd'
      } else if (tag === 'CHCD') {
        if (length <= MAX_TEXT_METADATA_BYTES && dataOffset + length <= size) {
          legacyTracks = tracksFromChcd(await readExactly(handle, length, dataOffset))
        }
        if (media === 'raw') media = 'cd'
      } else if (tag === 'DVD ') {
        media = 'dvd'
      } else if (tag === 'GDDD' && media === 'raw') {
        media = 'hdd'
      } else if ((tag === 'AVAV' || tag === 'AVLD') && media === 'raw') {
        media = 'av'
      }
      offset = next
    }

    const tracks = textTracks.size > 0 ? [...textTracks.values()].sort((a, b) => a.number - b.number) : legacyTracks
    const unitBytes =
      header.unitBytes ||
      (media === 'cd' || media === 'gdrom' ? CD_FRAME_BYTES : media === 'dvd' ? 2048 : header.hunkBytes)

    return {
      version: header.version,
      logicalBytes: header.logicalBytes,
      hunkBytes: header.hunkBytes,
      unitBytes,
      codecs: header.codecs,
      media,
      tracks,
      hasParent: header.hasParent
    }
  } finally {
    await handle.close()
  }
}
