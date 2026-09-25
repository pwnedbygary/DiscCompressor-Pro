import { open } from 'node:fs/promises'
import type { CdiInfo, CdiTrackInfo, CdiVersion } from '@shared/types'

/*
 * DiscJuggler (CDI) images.
 *
 * The file holds every sector of every track, pregaps included, from 00:00:00
 * onwards (the gap between sessions is not stored), followed by a descriptor.
 * The last 8 bytes are the format version and, for 3.5, the length of the
 * descriptor, or for 2.0 and 3.0 its absolute offset.
 *
 * The descriptor is a stream of variable-length records: the session count,
 * then per session a 15-byte session block and one record per track, then an
 * empty session block and a disc record. Track records begin with a 48-byte
 * header plus the image's file name, and hold the pregap and length (as index
 * lengths), CD-Text, track mode, start address, read mode (sector size) and
 * control flags. Their tail marks the last track of a session. Versions differ
 * in a few optional fields, which are recognised by marker values.
 *
 * Addresses are frames from 00:00:00 (LBA + 150). A track's start address is
 * where its stored sectors begin, so its INDEX 01 is at start + pregap.
 */

export class CdiError extends Error {}

const VERSIONS: Record<number, CdiVersion> = { 0x80000004: '2.0', 0x80000005: '3.0', 0x80000006: '3.5' }
const VERSION_MARKER: Record<CdiVersion, number> = { '2.0': 0x80000004, '3.0': 0x80000005, '3.5': 0x80000006 }
const MAX_DESCRIPTOR_BYTES = 1024 * 1024
const MAX_TRACKS = 99
/** Repeats around the start of every track record. */
const TRACK_MARK = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff])
/** Marks the capacity and medium type fields that DiscJuggler 4 added to record headers. */
const DJ4_MARKER = 0x80000000
/** Marks the 78 extra bytes that DiscJuggler 3.00.780 and later write in each track record. */
const EXTRA_BLOCK_MARKER = 0xffffffff
/** The part of SESSION_GAP_FRAMES that is the pregap of the second session's first track. */
export const SESSION_PREGAP_FRAMES = 150
/** Lead-out, lead-in and pregap between the end of the first session and INDEX 01 of the second. */
export const SESSION_GAP_FRAMES = 6750 + 4500 + SESSION_PREGAP_FRAMES
/** Frames before INDEX 01 of the first track. */
export const FIRST_PREGAP_FRAMES = 150

const READ_MODES: Record<number, { sectorSize: number; subchannelSize: number }> = {
  0: { sectorSize: 2048, subchannelSize: 0 },
  1: { sectorSize: 2336, subchannelSize: 0 },
  2: { sectorSize: 2352, subchannelSize: 0 },
  3: { sectorSize: 2352, subchannelSize: 16 },
  4: { sectorSize: 2352, subchannelSize: 96 }
}

/** Bytes stored per sector of a track, subchannel data included. */
export function cdiStoredSectorBytes(track: Pick<CdiTrackInfo, 'sectorSize' | 'subchannelSize'>): number {
  return track.sectorSize + track.subchannelSize
}

/** The cue sheet track mode of a CDI track (subchannel data is not part of it). */
export function cdiCueMode(track: Pick<CdiTrackInfo, 'mode' | 'sectorSize'>): string {
  return track.mode === 0 ? 'AUDIO' : `MODE${track.mode}/${track.sectorSize}`
}

class Reader {
  position = 0

  constructor(private readonly data: Buffer) {}

  private need(bytes: number): void {
    if (this.position + bytes > this.data.length) throw new CdiError('The CDI descriptor ends unexpectedly')
  }

  skip(bytes: number): void {
    this.need(bytes)
    this.position += bytes
  }

  u8(): number {
    this.need(1)
    return this.data.readUInt8(this.position++)
  }

  u16(): number {
    this.need(2)
    const value = this.data.readUInt16LE(this.position)
    this.position += 2
    return value
  }

  u32(): number {
    this.need(4)
    const value = this.data.readUInt32LE(this.position)
    this.position += 4
    return value
  }

  expect(bytes: Buffer, what: string): void {
    this.need(bytes.length)
    if (!this.data.subarray(this.position, this.position + bytes.length).equals(bytes)) {
      throw new CdiError(`The CDI descriptor is damaged or in an unknown format (no ${what})`)
    }
    this.position += bytes.length
  }
}

interface ParsedTrack {
  mode: number
  readMode: number
  pregap: number
  length: number
  start: number
  totalLength: number
  control: number
}

function readTrack(reader: Reader, version: CdiVersion): ParsedTrack {
  if (reader.u32() !== 0) reader.skip(8)
  reader.expect(TRACK_MARK, 'track start mark')
  reader.expect(TRACK_MARK, 'track start mark')
  reader.skip(4)
  reader.skip(reader.u8()) // file name of the image
  reader.skip(19)
  if (reader.u32() === DJ4_MARKER) reader.skip(8)

  const indices = reader.u16()
  if (indices < 2 || indices > 100) throw new CdiError(`The CDI descriptor is damaged (implausible index count ${indices})`)
  const pregap = reader.u32()
  let length = 0
  for (let index = 1; index < indices; index += 1) length += reader.u32()

  const cdText = reader.u32()
  if (cdText > MAX_TRACKS) throw new CdiError('The CDI descriptor is damaged (implausible CD-Text block count)')
  // Each CD-Text block is 18 fields, each a length byte followed by that many bytes.
  for (let block = 0; block < cdText * 18; block += 1) reader.skip(reader.u8())
  reader.skip(2)

  const mode = reader.u32()
  reader.skip(12) // unknown, session index, track index
  const start = reader.u32()
  const totalLength = reader.u32()
  reader.skip(16)
  const readMode = reader.u32()
  const control = reader.u32()
  reader.skip(25) // track length again, ISRC and whether it is valid
  if (version !== '2.0') {
    reader.skip(5)
    if (reader.u32() === EXTRA_BLOCK_MARKER) reader.skip(78)
  }
  return { mode, readMode, pregap, length, start, totalLength, control }
}

/** Decode a CDI descriptor. `dataBytes` is where the descriptor starts, i.e. how many bytes of sectors precede it. */
export function parseCdiDescriptor(descriptor: Buffer, version: CdiVersion, dataBytes: number): CdiInfo {
  const reader = new Reader(descriptor)
  const sessions = reader.u16()
  if (sessions < 1 || sessions > MAX_TRACKS) throw new CdiError(`The CDI image lists ${sessions} sessions`)

  const tracks: CdiTrackInfo[] = []
  let offset = 0
  // Sessions are numbered from 1, skipping the empty ones (a disc left open ends with one).
  let session = 0
  for (let block = 0; block < sessions; block += 1) {
    const count = reader.u16()
    if (tracks.length + count > MAX_TRACKS) throw new CdiError('The CDI image lists more than 99 tracks')
    if (count > 0) session += 1
    for (let index = 0; index < count; index += 1) {
      const parsed = readTrack(reader, version)
      const number = tracks.length + 1
      if (parsed.mode > 2) throw new CdiError(`Track ${number} has an unknown mode (${parsed.mode})`)
      const layout = READ_MODES[parsed.readMode]
      if (!layout) throw new CdiError(`Track ${number} has an unknown sector format (${parsed.readMode})`)
      if (parsed.mode === 0 && layout.sectorSize !== 2352) throw new CdiError(`Audio track ${number} does not use 2352-byte sectors`)
      if (parsed.mode === 1 && layout.sectorSize === 2336) throw new CdiError(`Mode 1 track ${number} cannot use 2336-byte sectors`)
      if (parsed.length === 0) throw new CdiError(`Track ${number} is empty`)
      if (parsed.pregap + parsed.length > parsed.totalLength) throw new CdiError(`Track ${number} is longer than the space it takes up`)
      const previous = tracks.at(-1)
      if (previous && parsed.start < previous.start + previous.pregap + previous.length) {
        throw new CdiError(`Track ${number} starts before track ${previous.number} ends`)
      }
      const track: CdiTrackInfo = {
        number,
        session,
        mode: parsed.mode as CdiTrackInfo['mode'],
        sectorSize: layout.sectorSize,
        subchannelSize: layout.subchannelSize,
        pregap: parsed.pregap,
        length: parsed.length,
        stored: parsed.totalLength,
        start: parsed.start,
        offset,
        control: parsed.control & 0x0f
      }
      tracks.push(track)
      offset += track.stored * cdiStoredSectorBytes(track)
    }
    reader.skip(version === '2.0' ? 12 : 13)
  }
  if (tracks.length === 0) throw new CdiError('The CDI image contains no tracks')
  if (offset > dataBytes) throw new CdiError('The CDI image is truncated: its tracks need more data than the file holds')
  return { version, sessions: session, tracks }
}

/** The frames of a CDI track that a cue sheet or CHD holds, as addresses of the CDI image. */
export interface CdiRegion {
  /** The first frame, the track's INDEX 01 (00:02:00 for the first track). */
  start: number
  /** The frame after the last. */
  end: number
}

export interface CdiSheetLayout {
  regions: CdiRegion[]
  /** Frames of silence or zeros added to the end of the first session to keep the second at its address. */
  sessionPadding: number
  /** Why emulators may not find the data where it is, if they may not. */
  warning: string | null
}

/**
 * Lay out the tracks of a CDI image for a cue sheet or CHD, which store every
 * frame from 00:02:00 on but not the gap between sessions. Every track starts
 * at its INDEX 01 and takes in the pregap of the next track in its session,
 * because Flycast 2.7 and earlier refuse CHDs whose tracks have pregaps.
 *
 * Emulators take a disc whose second and last session holds a single data
 * track for a Dreamcast CD-R, and put that track's INDEX 01 SESSION_GAP_FRAMES
 * after the first session ends. The gap includes the track's pregap, which is
 * therefore not stored either (Flycast 2.7 and earlier would count it twice in
 * a cue sheet). When the image has its second session later, the first one is
 * padded to keep it there; one that starts earlier cannot be placed.
 */
export function cdiSheetLayout(info: CdiInfo): CdiSheetLayout {
  const { tracks } = info
  const first = tracks[0] as CdiTrackInfo
  if (first.start + first.pregap < FIRST_PREGAP_FRAMES) {
    throw new CdiError('The first track of the CDI image starts before 00:02:00, which a CHD or cue sheet cannot record')
  }
  const index1 = (track: CdiTrackInfo): number => track.start + track.pregap
  const regions = tracks.map((track, index) => {
    const next = tracks[index + 1]
    return {
      start: index === 0 ? FIRST_PREGAP_FRAMES : index1(track),
      end: next?.session === track.session ? index1(next) : index1(track) + track.length
    }
  })
  const layout: CdiSheetLayout = { regions, sessionPadding: 0, warning: null }
  if (info.sessions === 1) return layout

  const last = tracks.at(-1) as CdiTrackInfo
  const previous = tracks.at(-2) as CdiTrackInfo
  if (info.sessions > 2 || previous.session === last.session || last.mode === 0) {
    layout.warning =
      'Emulators expect the second session of a Dreamcast CD-R to hold a single data track. This image has a different layout, so the converted disc may not start.'
    return layout
  }
  const firstSession = regions.at(-2) as CdiRegion
  const standard = firstSession.end + SESSION_GAP_FRAMES
  if (index1(last) < standard) {
    layout.warning = `The data track of this image starts ${standard - index1(last)} frames earlier than on a standard Dreamcast CD-R, which a CHD or cue sheet cannot record, so the converted disc may not start.`
    return layout
  }
  layout.sessionPadding = index1(last) - standard
  firstSession.end += layout.sessionPadding
  return layout
}

/** Read the layout of a CDI image from the end of the file. */
export async function readCdiInfo(path: string): Promise<CdiInfo> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    if (size < 16) throw new CdiError('The file is too small to be a CDI image')
    const footer = Buffer.alloc(8)
    await file.read(footer, 0, 8, size - 8)
    const version = VERSIONS[footer.readUInt32LE(0)]
    if (!version) throw new CdiError('Not a DiscJuggler image, or an unsupported version')
    const value = footer.readUInt32LE(4)
    const start = version === '3.5' ? size - value : value
    if (value === 0 || start < 0 || start >= size - 8 || size - start > MAX_DESCRIPTOR_BYTES) {
      throw new CdiError('The CDI image is damaged (its descriptor is out of range)')
    }
    const descriptor = Buffer.alloc(size - start)
    await file.read(descriptor, 0, descriptor.length, start)
    return parseCdiDescriptor(descriptor, version, start)
  } finally {
    await file.close()
  }
}

/** A track of a CDI image being written. Sectors are written separately, in track order. */
export interface CdiTrackLayout {
  session: number
  mode: 0 | 1 | 2
  sectorSize: number
  subchannelSize: number
  pregap: number
  length: number
  start: number
  control: number
}

/** Readers ignore these header bytes; these are the values of images that DiscJuggler and burning tools accept. */
const ID_BYTES = Buffer.from([0xab, 0x00, 0x10])
const CAPACITY_FRAMES = 360000
const MEDIUM_CD_ROM = 0x0098

function recordHeader(totalTracks: number, imageName: string): Buffer {
  const name = Buffer.from(imageName.replace(/[^\x20-\x7e]/g, '_').slice(0, 255), 'latin1')
  const header = Buffer.alloc(48 + name.length)
  Buffer.from([0xff, 0xff, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff]).copy(header, 0)
  ID_BYTES.copy(header, 12)
  header[15] = totalTracks
  header[16] = name.length
  name.copy(header, 17)
  const rest = 17 + name.length
  header[rest + 11] = 0x02
  header[rest + 22] = 0x80
  header.writeUInt32LE(CAPACITY_FRAMES, rest + 23)
  header.writeUInt16LE(MEDIUM_CD_ROM, rest + 29)
  return header
}

function sessionBlock(tracks: number): Buffer {
  const block = Buffer.alloc(15)
  block[1] = tracks
  block[9] = 0x01
  block[13] = 0xff
  block[14] = 0xff
  return block
}

function readModeOf(track: CdiTrackLayout): number {
  const found = Object.entries(READ_MODES).find(([, layout]) => layout.sectorSize === track.sectorSize && layout.subchannelSize === track.subchannelSize)
  if (!found) throw new CdiError(`CDI images cannot store ${track.sectorSize}-byte sectors with ${track.subchannelSize} bytes of subchannel data`)
  return Number(found[0])
}

/** 0 for an audio session, 2 if it has a Mode 2 track, otherwise 1. */
function sessionType(tracks: CdiTrackLayout[]): number {
  if (tracks.some((track) => track.mode === 2)) return 2
  return tracks.some((track) => track.mode === 1) ? 1 : 0
}

function trackRecord(track: CdiTrackLayout, index: number, totalTracks: number, imageName: string, last: boolean, type: number): Buffer {
  const body = Buffer.alloc(188)
  let p = 0
  const u32 = (value: number): void => {
    body.writeUInt32LE(value >>> 0, p)
    p += 4
  }
  const totalLength = track.pregap + track.length
  body.writeUInt16LE(2, p) // two indices: the pregap and index 1
  p += 2
  u32(track.pregap)
  u32(track.length)
  u32(0) // no CD-Text
  p += 2
  u32(track.mode)
  p += 4
  u32(track.session - 1)
  u32(index)
  u32(track.start)
  u32(totalLength)
  p += 16
  u32(readModeOf(track))
  u32(track.control)
  p += 1
  u32(totalLength)
  p += 4 + 12 + 4 // unknown, ISRC, ISRC valid
  // The tail, with the values DiscJuggler writes.
  const tail = p
  body.fill(0xff, tail + 1, tail + 9)
  body.writeUInt32LE(1, tail + 9)
  body.writeUInt32LE(0x80, tail + 13)
  body.writeUInt32LE(2, tail + 17)
  body.writeUInt32LE(0x10, tail + 21)
  body.writeUInt32LE(44100, tail + 25)
  body.writeUInt32LE(0xffffffff, tail + 71)
  body[tail + 87] = last ? type : 0
  body[tail + 93] = last ? 0 : 1
  if (last) body.writeUInt32LE(track.start, tail + 95)
  else Buffer.from([0x00, 0x00, 0xff, 0xff]).copy(body, tail + 95)
  return Buffer.concat([recordHeader(totalTracks, imageName), body])
}

/**
 * The descriptor that ends a DiscJuggler 3.5 image with these tracks. Tracks
 * must be in order, sessions numbered from 1 without gaps.
 */
export function buildCdiDescriptor(tracks: CdiTrackLayout[], options: { imageName: string; volumeId?: string }): Buffer {
  if (tracks.length === 0 || tracks.length > MAX_TRACKS) throw new CdiError(`A CDI image holds 1 to 99 tracks, not ${tracks.length}`)
  const sessions: CdiTrackLayout[][] = []
  for (const track of tracks) {
    if (track.session !== sessions.length && track.session !== sessions.length + 1) throw new CdiError('CDI sessions must be numbered in order')
    if (track.session > sessions.length) sessions.push([])
    sessions[track.session - 1]?.push(track)
  }

  const parts: Buffer[] = [Buffer.from([sessions.length])]
  for (const session of sessions) {
    parts.push(sessionBlock(session.length))
    const type = sessionType(session)
    session.forEach((track, index) => {
      parts.push(trackRecord(track, index, tracks.length, options.imageName, index === session.length - 1, type))
    })
  }
  parts.push(sessionBlock(0))

  const last = tracks.at(-1) as CdiTrackLayout
  const volume = Buffer.from((options.volumeId ?? '').replace(/[^\x20-\x7e]/g, '_').slice(0, 32), 'latin1')
  // Disc length, volume identifier, a byte and two words of 1, the MCN (13 bytes) and whether it
  // is valid, the length of CD-Text (none), 8 bytes of zeros and the version.
  const disc = Buffer.alloc(4 + 1 + volume.length + 9 + 13 + 4 + 4 + 12)
  disc.writeUInt32LE(last.start + last.pregap + last.length, 0)
  disc[4] = volume.length
  volume.copy(disc, 5)
  const p = 5 + volume.length
  disc.writeUInt32LE(1, p + 1)
  disc.writeUInt32LE(1, p + 5)
  disc.writeUInt32LE(VERSION_MARKER['3.5'], p + 9 + 13 + 4 + 4 + 8)
  parts.push(recordHeader(tracks.length, options.imageName), disc)

  const descriptor = Buffer.concat(parts)
  const length = Buffer.alloc(4)
  length.writeUInt32LE(descriptor.length + 4)
  return Buffer.concat([descriptor, length])
}
