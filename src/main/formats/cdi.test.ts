import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CdiInfo, CdiTrackInfo, CdiVersion } from '@shared/types'
import { type CdiTrackLayout, CdiError, buildCdiDescriptor, cdiCueMode, cdiSheetLayout, parseCdiDescriptor, readCdiInfo } from './cdi'

/**
 * The descriptor of a real self-booting image: the 240p Test Suite 2.03 for
 * Dreamcast, an audio track in the first session and a Mode 2 data track in
 * the second, written with cdi4dc. Its sectors take 17,426,784 bytes.
 */
const GOLDEN = Buffer.from(
  [
    '0200010000000000000001000000ffffffff000001000000ffffffffab0010020d3234307053756974652e636469000000000000000000000002000000000000',
    '0000000080407e0500000098000200960000002e0100000000000000000000000000000000000000000000000000000000c40100000000000000000000000000',
    '0000000000020000000000000000c4010000000000000000000000000000000000000000000000ffffffffffffffff0100000080000000020000001000000044',
    'ac0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ffffffff000000000000000000000000000000',
    '00000000000000000000010000000000000001000000ffffffff000001000000ffffffffab0010020d3234307053756974652e63646900000000000000000000',
    '00020000000000000000000080407e050000009800020096000000c71a000000000000000002000000000000000100000000000000b62d00005d1b0000000000',
    '000000000000000000000000000100000004000000005d1b0000000000000000000000000000000000000000000000ffffffffffffffff010000008000000002',
    '0000001000000044ac0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ffffffff00000000000000',
    '00000000000200000000000000b62d000000000000000000000001000000ffffffff000001000000ffffffffab0010020d3234307053756974652e6364690000',
    '000000000000000000020000000000000000000080407e0500000098001349000020323430705375697465444320202020202020202020202020202020202020',
    '2020000100000001000000000000000000000000000000000000000000000000000000000000000006000080b0020000'
  ].join(''),
  'hex'
)
const GOLDEN_DATA_BYTES = 17_426_784

const SELFBOOT: CdiTrackLayout[] = [
  { session: 1, mode: 0, sectorSize: 2352, subchannelSize: 0, pregap: 150, length: 302, start: 0, control: 0 },
  { session: 2, mode: 2, sectorSize: 2336, subchannelSize: 0, pregap: 150, length: 6855, start: 11702, control: 4 }
]

const SELFBOOT_TRACKS: CdiTrackInfo[] = [
  { number: 1, session: 1, mode: 0, sectorSize: 2352, subchannelSize: 0, pregap: 150, length: 302, stored: 452, start: 0, offset: 0, control: 0 },
  { number: 2, session: 2, mode: 2, sectorSize: 2336, subchannelSize: 0, pregap: 150, length: 6855, stored: 7005, start: 11702, offset: 452 * 2352, control: 4 }
]

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dcp-cdi-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * A CDI file whose sectors are all zeros. A 3.5 descriptor ends with its own
 * footer; older versions get one with the version and the descriptor's offset.
 */
async function cdiFile(name: string, dataBytes: number, descriptor: Buffer, version: CdiVersion = '3.5'): Promise<string> {
  const path = join(dir, name)
  const parts = [Buffer.alloc(dataBytes), descriptor]
  if (version !== '3.5') {
    const footer = Buffer.alloc(8)
    footer.writeUInt32LE(version === '2.0' ? 0x80000004 : 0x80000005, 0)
    footer.writeUInt32LE(dataBytes, 4)
    parts.push(footer)
  }
  await writeFile(path, Buffer.concat(parts))
  return path
}

interface LegacyTrack {
  mode: number
  readMode: number
  pregap: number
  /** Lengths of index 1 onwards. */
  indices: number[]
  start: number
  total?: number
  /** CD-Text blocks of 18 fields each. */
  cdText?: string[][]
}

/**
 * A descriptor in the layout cdirip reads, with the optional fields of the
 * DiscJuggler versions: the 8 bytes after a non-zero first word (3.00.780 and
 * later), the DJ4 capacity fields, and the 78-byte block of 3.0 and later.
 */
function legacyDescriptor(sessions: LegacyTrack[][], options: { version: CdiVersion; dj4?: boolean; early?: boolean }): Buffer {
  const parts: Buffer[] = []
  const u16 = (value: number): void => {
    const b = Buffer.alloc(2)
    b.writeUInt16LE(value)
    parts.push(b)
  }
  const u32 = (value: number): void => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(value >>> 0)
    parts.push(b)
  }
  const bytes = (count: number, fill = 0): void => void parts.push(Buffer.alloc(count, fill))
  const mark = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff])
  const all = sessions.flat().length
  u16(sessions.length)
  sessions.forEach((tracks, session) => {
    u16(tracks.length)
    tracks.forEach((track, index) => {
      u32(options.early ? 7 : 0)
      if (options.early) bytes(8)
      parts.push(mark, mark)
      parts.push(Buffer.from([0x12, 0x34, 0x56, all]))
      parts.push(Buffer.from([5]), Buffer.from('a.cdi', 'latin1'))
      bytes(19)
      u32(options.dj4 === false ? 0 : 0x80000000)
      if (options.dj4 !== false) bytes(8)
      u16(track.indices.length + 1)
      u32(track.pregap)
      for (const length of track.indices) u32(length)
      u32(track.cdText?.length ?? 0)
      for (const block of track.cdText ?? []) {
        for (let field = 0; field < 18; field += 1) {
          const text = Buffer.from(block[field] ?? '', 'latin1')
          parts.push(Buffer.from([text.length]), text)
        }
      }
      bytes(2)
      u32(track.mode)
      u32(0)
      u32(session)
      u32(index)
      u32(track.start)
      u32(track.total ?? track.pregap + track.indices.reduce((a, b) => a + b, 0))
      bytes(16)
      u32(track.readMode)
      u32(track.mode === 0 ? 0 : 4)
      bytes(25)
      if (options.version !== '2.0') {
        bytes(5)
        u32(0xffffffff)
        bytes(78)
      }
    })
    bytes(options.version === '2.0' ? 12 : 13)
  })
  bytes(40) // the empty session block and the start of the disc record, which readers skip
  return Buffer.concat(parts)
}

describe('the CDI writer', () => {
  it('writes the descriptor DiscJuggler-compatible tools write for a self-booting disc, byte for byte', () => {
    expect(buildCdiDescriptor(SELFBOOT, { imageName: '240pSuite.cdi', volumeId: '240pSuiteDC'.padEnd(32, ' ') }).equals(GOLDEN)).toBe(true)
  })

  it('refuses layouts a CDI cannot hold', () => {
    expect(() => buildCdiDescriptor([], { imageName: 'x.cdi' })).toThrow(CdiError)
    expect(() => buildCdiDescriptor([{ ...(SELFBOOT[1] as CdiTrackLayout), session: 2 }], { imageName: 'x.cdi' })).toThrow(/in order/)
    expect(() => buildCdiDescriptor([{ ...(SELFBOOT[1] as CdiTrackLayout), session: 1, subchannelSize: 96 }], { imageName: 'x.cdi' })).toThrow(/2336-byte sectors/)
  })

  it('numbers tracks within their session and stores the name and volume in printable ASCII', () => {
    const three = buildCdiDescriptor(
      [
        { ...(SELFBOOT[0] as CdiTrackLayout) },
        { ...(SELFBOOT[0] as CdiTrackLayout), start: 452, pregap: 0 },
        { ...(SELFBOOT[1] as CdiTrackLayout), start: 754 + 11250 }
      ],
      { imageName: 'Gäme.cdi', volumeId: 'VOL\u0001' }
    )
    const info = parseCdiDescriptor(three, '3.5', 1e9)
    expect(info.tracks.map((track) => [track.number, track.session, track.start])).toEqual([
      [1, 1, 0],
      [2, 1, 452],
      [3, 2, 12004]
    ])
    // Records are a 56-byte header (48 bytes and the 8-byte name) and a 188-byte body, after the session count and blocks.
    const bodies = [1 + 15 + 56, 1 + 15 + 56 + 188 + 56, 1 + 15 + 2 * (56 + 188) + 15 + 56]
    expect(bodies.map((body) => [three.readUInt32LE(body + 24), three.readUInt32LE(body + 28)])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0]
    ])
    expect(three.includes(Buffer.from('G_me.cdi', 'latin1'))).toBe(true)
    expect(three.includes(Buffer.from([4, ...Buffer.from('VOL_', 'latin1')]))).toBe(true)
  })
})

describe('the CDI reader', () => {
  it('reads the tracks and sessions of a real image', async () => {
    const expected: CdiInfo = { version: '3.5', sessions: 2, tracks: SELFBOOT_TRACKS }
    expect(parseCdiDescriptor(GOLDEN, '3.5', GOLDEN_DATA_BYTES)).toEqual(expected)
    expect(await readCdiInfo(await cdiFile('Golden.cdi', GOLDEN_DATA_BYTES, GOLDEN))).toEqual(expected)
  })

  it('reads the images of older DiscJuggler versions, whose footer holds the descriptor offset', async () => {
    const tracks: LegacyTrack[][] = [
      [{ mode: 1, readMode: 0, pregap: 150, indices: [1000], start: 0 }],
      [{ mode: 2, readMode: 1, pregap: 150, indices: [500], start: 12400 }]
    ]
    const bytes = 1150 * 2048 + 650 * 2336
    for (const [version, options] of [
      ['2.0', { dj4: false }],
      ['3.0', { dj4: false }],
      ['3.0', { early: true }]
    ] as [CdiVersion, { dj4?: boolean; early?: boolean }][]) {
      const info = await readCdiInfo(await cdiFile(`Legacy${version}.cdi`, bytes, legacyDescriptor(tracks, { version, ...options }), version))
      expect(info).toMatchObject({ version, sessions: 2 })
      expect(info.tracks.map((track) => [track.mode, track.sectorSize, track.pregap, track.length, track.start, track.offset])).toEqual([
        [1, 2048, 150, 1000, 0, 0],
        [2, 2336, 150, 500, 12400, 1150 * 2048]
      ])
    }
  })

  it('skips CD-Text, adds up the lengths of further indices and reads subchannel layouts', () => {
    const descriptor = legacyDescriptor(
      [
        [
          { mode: 0, readMode: 4, pregap: 150, indices: [100, 50], start: 0, cdText: [['Title', 'Artist', '', 'x'.repeat(200)]] },
          { mode: 0, readMode: 2, pregap: 0, indices: [300], start: 300, total: 302 },
          { mode: 1, readMode: 3, pregap: 0, indices: [100], start: 602 }
        ]
      ],
      { version: '3.5' }
    )
    const info = parseCdiDescriptor(descriptor, '3.5', 1e9)
    expect(info.tracks).toEqual([
      { number: 1, session: 1, mode: 0, sectorSize: 2352, subchannelSize: 96, pregap: 150, length: 150, stored: 300, start: 0, offset: 0, control: 0 },
      { number: 2, session: 1, mode: 0, sectorSize: 2352, subchannelSize: 0, pregap: 0, length: 300, stored: 302, start: 300, offset: 300 * 2448, control: 0 },
      { number: 3, session: 1, mode: 1, sectorSize: 2352, subchannelSize: 16, pregap: 0, length: 100, stored: 100, start: 602, offset: 300 * 2448 + 302 * 2352, control: 4 }
    ])
  })

  it('does not count an empty session left open at the end of the disc', () => {
    const descriptor = legacyDescriptor([[{ mode: 1, readMode: 2, pregap: 150, indices: [10], start: 0 }], []], { version: '3.5' })
    expect(parseCdiDescriptor(descriptor, '3.5', 1e9)).toMatchObject({ sessions: 1, tracks: [{ session: 1 }] })
  })

  it('describes each track mode as a cue sheet does', () => {
    expect(SELFBOOT_TRACKS.map(cdiCueMode)).toEqual(['AUDIO', 'MODE2/2336'])
    expect(cdiCueMode({ mode: 1, sectorSize: 2048 })).toBe('MODE1/2048')
  })

  it('rejects damaged, truncated and unsupported images with a reason', async () => {
    const track = (overrides: Partial<LegacyTrack>): LegacyTrack[][] => [[{ mode: 1, readMode: 2, pregap: 150, indices: [10], start: 0, ...overrides }]]
    const parse = (tracks: LegacyTrack[][]): CdiInfo => parseCdiDescriptor(legacyDescriptor(tracks, { version: '3.5' }), '3.5', 1e9)
    expect(() => parse(track({ readMode: 7 }))).toThrow('Track 1 has an unknown sector format (7)')
    expect(() => parse(track({ indices: [] }))).toThrow('The CDI descriptor is damaged (implausible index count 1)')
    expect(() => parse(track({ mode: 3 }))).toThrow('Track 1 has an unknown mode (3)')
    expect(() => parse(track({ mode: 0, readMode: 0 }))).toThrow('Audio track 1 does not use 2352-byte sectors')
    expect(() => parse(track({ mode: 1, readMode: 1 }))).toThrow('Mode 1 track 1 cannot use 2336-byte sectors')
    expect(() => parse(track({ indices: [0] }))).toThrow('Track 1 is empty')
    expect(() => parse(track({ total: 100 }))).toThrow('Track 1 is longer than the space it takes up')
    expect(() =>
      parse([
        [
          { mode: 1, readMode: 2, pregap: 150, indices: [100], start: 0 },
          { mode: 0, readMode: 2, pregap: 0, indices: [100], start: 200 }
        ]
      ])
    ).toThrow('Track 2 starts before track 1 ends')
    expect(() => parseCdiDescriptor(GOLDEN.subarray(0, 300), '3.5', GOLDEN_DATA_BYTES)).toThrow('The CDI descriptor ends unexpectedly')
    expect(() => parseCdiDescriptor(Buffer.concat([GOLDEN.subarray(0, 20), Buffer.alloc(8), GOLDEN.subarray(28)]), '3.5', GOLDEN_DATA_BYTES)).toThrow(
      /no track start mark/
    )
    expect(() => parseCdiDescriptor(GOLDEN, '3.5', GOLDEN_DATA_BYTES - 1)).toThrow(/truncated/)

    await expect(readCdiInfo(await cdiFile('Tiny.cdi', 0, Buffer.alloc(4)))).rejects.toThrow('too small')
    const unknown = join(dir, 'Unknown.cdi')
    await writeFile(unknown, Buffer.alloc(64, 1))
    await expect(readCdiInfo(unknown)).rejects.toThrow('Not a DiscJuggler image')
    const outOfRange = Buffer.from(GOLDEN)
    outOfRange.writeUInt32LE(GOLDEN.length + 1, GOLDEN.length - 4)
    await expect(readCdiInfo(await cdiFile('Range.cdi', 0, outOfRange))).rejects.toThrow('out of range')
  })
})

describe('cdiSheetLayout', () => {
  const info = (tracks: CdiTrackInfo[]): CdiInfo => ({ version: '3.5', sessions: new Set(tracks.map((t) => t.session)).size, tracks })
  const [audio, data] = SELFBOOT_TRACKS as [CdiTrackInfo, CdiTrackInfo]

  it('keeps a standard self-booting disc as it is, without the first 150 frames', () => {
    expect(cdiSheetLayout(info(SELFBOOT_TRACKS))).toEqual({
      regions: [
        { start: 150, end: 452 },
        { start: 11702, end: 18707 }
      ],
      sessionPadding: 0,
      warning: null
    })
  })

  it('pads the first session when the second starts later than usual, so that it keeps its address', () => {
    expect(cdiSheetLayout(info([audio, { ...data, start: 11732 }]))).toMatchObject({
      regions: [
        { start: 150, end: 482 },
        { start: 11732, end: 18737 }
      ],
      sessionPadding: 30,
      warning: null
    })
    // A data track without pregap counts the whole 150 frames towards the gap.
    expect(cdiSheetLayout(info([audio, { ...data, start: 11852, pregap: 0, stored: 6855 }])).regions[1]).toEqual({ start: 11852, end: 18707 })
  })

  it('warns about layouts emulators cannot find the data of', () => {
    expect(cdiSheetLayout(info([audio, { ...data, start: 11700 }])).warning).toMatch(/starts 2 frames earlier than on a standard Dreamcast CD-R/)
    expect(cdiSheetLayout(info([audio, { ...audio, number: 2, session: 2, start: 11702 }])).warning).toMatch(/single data track/)
    const third = { ...data, number: 3, session: 3, start: 30000 }
    expect(cdiSheetLayout(info([audio, data, third])).warning).toMatch(/single data track/)
  })

  it('follows the recorded addresses of tracks within a session', () => {
    const first = { ...audio, session: 1, length: 300, stored: 452 }
    const second = { ...audio, number: 2, pregap: 150, length: 300, stored: 450, start: 452, offset: 452 * 2352 }
    // Track 1 stores two sectors beyond its length and track 2 starts after them.
    expect(cdiSheetLayout(info([first, second])).regions).toEqual([
      { start: 150, end: 452 },
      { start: 452, end: 902 }
    ])
    // A track that starts after a gap is reached through the frames before it.
    expect(cdiSheetLayout(info([{ ...first, stored: 450 }, { ...second, start: 460 }])).regions[0]).toEqual({ start: 150, end: 460 })
  })

  it('cannot place a first track that starts before 00:02:00', () => {
    expect(() => cdiSheetLayout(info([{ ...audio, pregap: 100, stored: 402 }]))).toThrow(/before 00:02:00/)
  })
})
