import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CdiInfo } from '@shared/types'
import { type CdiTrackLayout, buildCdiDescriptor, readCdiInfo } from '../formats/cdi'
import { CdiConversionError, buildCdiFromSheet, splitCdi, splitSheetTracks } from './cdi'

let root: string
let dir: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dcp-cdi-jobs-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  dir = join(root, Math.random().toString(36).slice(2))
  await mkdir(dir)
})

const progress = (): { signal: AbortSignal; onProgress: (fraction: number) => void; seen: number[] } => {
  const seen: number[] = []
  return { signal: new AbortController().signal, onProgress: (fraction) => seen.push(fraction), seen }
}

/** `count` sectors of `size` bytes with contents that differ per sector and per seed. */
function sectors(count: number, size: number, seed: number): Buffer {
  const data = Buffer.alloc(count * size)
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 31 + seed * 7 + Math.floor(i / size) * 13) & 0xff
  return data
}

const BOOT = Buffer.from('SEGA SEGAKATANA SEGA ENTERPRISES', 'latin1')

/** Mode 2 sectors of a data track: the boot sector first, and a volume descriptor 16 sectors later. */
function dataTrack(count: number, size: 2336 | 2352, volume = 'TEST_DISC'): Buffer {
  const data = sectors(count, size, 9)
  const user = size === 2336 ? 8 : 24
  BOOT.copy(data, user)
  const pvd = 16 * size + user
  data[pvd] = 1
  data.write('CD001', pvd + 1, 'latin1')
  data.write(volume.padEnd(32, ' '), pvd + 40, 'latin1')
  return data
}

const AUDIO = sectors(10, 2352, 1)
const DATA = dataTrack(20, 2336)
// Session 1 ends at 150 + 10 frames; session 2's INDEX 01 is 11,400 frames later.
const AUDIO_LAYOUT: CdiTrackLayout = { session: 1, mode: 0, sectorSize: 2352, subchannelSize: 0, pregap: 150, length: 10, start: 0, control: 0 }
const DATA_LAYOUT: CdiTrackLayout = { session: 2, mode: 2, sectorSize: 2336, subchannelSize: 0, pregap: 150, length: 20, start: 160 + 11250, control: 4 }

/** A CDI file with these tracks, whose pregaps are stored as zeros unless given. */
async function writeCdi(name: string, tracks: { layout: CdiTrackLayout; data: Buffer; pregap?: Buffer }[]): Promise<string> {
  const path = join(dir, name)
  const parts = tracks.flatMap(({ layout, data, pregap }) => [pregap ?? Buffer.alloc(layout.pregap * (layout.sectorSize + layout.subchannelSize)), data])
  parts.push(buildCdiDescriptor(tracks.map((track) => track.layout), { imageName: name }))
  await writeFile(path, Buffer.concat(parts))
  return path
}

/** Interleave 96 bytes of subchannel data after every 2352-byte sector. */
function withSubchannel(data: Buffer): Buffer {
  const count = data.length / 2352
  return Buffer.concat(Array.from({ length: count }, (_, i) => [data.subarray(i * 2352, (i + 1) * 2352), Buffer.alloc(96, 0xee)]).flat())
}

/**
 * The cue sheets chdman extractcd writes for the self-booting disc, with all
 * tracks in one file: from a CHD that stores the data track's pregap, and from
 * one that does not, as this app makes them.
 */
const CHDMAN_SHEET = 'FILE "image.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 MODE2/2336\n    INDEX 00 00:00:10\n    INDEX 01 00:02:10\n'
const CHDMAN_BIN = Buffer.concat([AUDIO, Buffer.alloc(150 * 2336), DATA])
const CHDMAN_SHEETS: [string, Buffer][] = [
  [CHDMAN_SHEET, CHDMAN_BIN],
  ['FILE "image.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 MODE2/2336\n    INDEX 01 00:00:10\n', Buffer.concat([AUDIO, DATA])]
]

async function writeSheet(text: string, bin: Buffer, name = 'image'): Promise<string> {
  await writeFile(join(dir, `${name}.bin`), bin)
  await writeFile(join(dir, `${name}.cue`), text.replace('"image.bin"', `"${name}.bin"`))
  return join(dir, `${name}.cue`)
}

const SPLIT_SHEET = [
  'REM SESSION 01',
  'FILE "Game (Track 1).bin" BINARY',
  '  TRACK 01 AUDIO',
  '    INDEX 01 00:00:00',
  'REM SESSION 02',
  'FILE "Game (Track 2).bin" BINARY',
  '  TRACK 02 MODE2/2336',
  '    INDEX 01 00:00:00',
  ''
].join('\r\n')

describe('splitCdi', () => {
  it('writes one file per track and a cue sheet that marks the sessions', async () => {
    const source = await writeCdi('Game.cdi', [
      { layout: AUDIO_LAYOUT, data: AUDIO },
      { layout: DATA_LAYOUT, data: DATA }
    ])
    const info = await readCdiInfo(source)
    const p = progress()
    const files = await splitCdi({ ...p, source, info, dir, baseName: 'Game', sessions: true })

    expect(files).toEqual(['Game.cue', 'Game (Track 1).bin', 'Game (Track 2).bin'])
    expect(await readFile(join(dir, 'Game.cue'), 'utf8')).toBe(SPLIT_SHEET)
    // Neither the first 150 frames of the disc nor the pregap of the second session's track are stored.
    expect((await readFile(join(dir, 'Game (Track 1).bin'))).equals(AUDIO)).toBe(true)
    expect((await readFile(join(dir, 'Game (Track 2).bin'))).equals(DATA)).toBe(true)
    expect(p.seen.at(-1)).toBe(1)

    // chdman gets the same tracks, without the sessions.
    await splitCdi({ ...progress(), source, info, dir, baseName: 'Flat', sessions: false })
    expect(await readFile(join(dir, 'Flat.cue'), 'utf8')).toBe(SPLIT_SHEET.replace(/REM SESSION 0\d\r\n/g, '').replace(/Game/g, 'Flat'))
  })

  it('starts each file at its INDEX 01, giving the pregap of a later track in a session to the track before it', async () => {
    const second = sectors(10, 2352, 2)
    const pregap = sectors(150, 2352, 3)
    // Session 1 ends at 320 frames, 150 of them track 2's pregap.
    const source = await writeCdi('Mix.cdi', [
      { layout: AUDIO_LAYOUT, data: AUDIO },
      { layout: { ...AUDIO_LAYOUT, start: 160 }, data: second, pregap },
      { layout: { ...DATA_LAYOUT, start: 320 + 11250 }, data: DATA }
    ])
    await splitCdi({ ...progress(), source, info: await readCdiInfo(source), dir, baseName: 'Mix', sessions: true })
    const sheet = await readFile(join(dir, 'Mix.cue'), 'utf8')
    expect(sheet).not.toMatch(/INDEX 00|PREGAP/)
    expect(sheet).toMatch(/TRACK 02 AUDIO\r\n {4}INDEX 01 00:00:00\r\nREM SESSION 02\r\n/)
    expect((await readFile(join(dir, 'Mix (Track 1).bin'))).equals(Buffer.concat([AUDIO, pregap]))).toBe(true)
    expect((await readFile(join(dir, 'Mix (Track 2).bin'))).equals(second)).toBe(true)
    expect((await readFile(join(dir, 'Mix (Track 3).bin'))).equals(DATA)).toBe(true)

    // Each track is read with its own subchannel stride.
    for (const [name, tracks] of [
      ['Strides', [{ layout: { ...AUDIO_LAYOUT, subchannelSize: 96 }, data: withSubchannel(AUDIO) }, { layout: { ...AUDIO_LAYOUT, start: 160 }, data: second, pregap }]],
      ['Strides2', [{ layout: AUDIO_LAYOUT, data: AUDIO }, { layout: { ...AUDIO_LAYOUT, subchannelSize: 96, start: 160 }, data: withSubchannel(second), pregap: withSubchannel(pregap) }]]
    ] as const) {
      const strides = await writeCdi(`${name}.cdi`, [...tracks])
      await splitCdi({ ...progress(), source: strides, info: await readCdiInfo(strides), dir, baseName: name, sessions: true })
      expect((await readFile(join(dir, `${name} (Track 1).bin`))).equals(Buffer.concat([AUDIO, pregap]))).toBe(true)
      expect((await readFile(join(dir, `${name} (Track 2).bin`))).equals(second)).toBe(true)
    }
  })

  it('writes zeros for the pregap of a track in another format and for frames that no track stores', async () => {
    const data = sectors(10, 2048, 4)
    const mixed = await writeCdi('Mixed.cdi', [
      { layout: AUDIO_LAYOUT, data: AUDIO },
      { layout: { ...AUDIO_LAYOUT, mode: 1, sectorSize: 2048, start: 160, control: 4 }, data, pregap: sectors(150, 2048, 5) }
    ])
    await splitCdi({ ...progress(), source: mixed, info: await readCdiInfo(mixed), dir, baseName: 'Mixed', sessions: true })
    expect((await readFile(join(dir, 'Mixed (Track 1).bin'))).equals(Buffer.concat([AUDIO, Buffer.alloc(150 * 2352)]))).toBe(true)
    expect((await readFile(join(dir, 'Mixed (Track 2).bin'))).equals(data)).toBe(true)

    const raw = dataTrack(20, 2352)
    const sizes = await writeCdi('Sizes.cdi', [
      { layout: { ...DATA_LAYOUT, session: 1, start: 0 }, data: DATA },
      { layout: { ...DATA_LAYOUT, session: 1, sectorSize: 2352, start: 170 }, data: raw, pregap: sectors(150, 2352, 6) }
    ])
    await splitCdi({ ...progress(), source: sizes, info: await readCdiInfo(sizes), dir, baseName: 'Sizes', sessions: true })
    expect((await readFile(join(dir, 'Sizes (Track 1).bin'))).equals(Buffer.concat([DATA, Buffer.alloc(150 * 2336)]))).toBe(true)
    expect((await readFile(join(dir, 'Sizes (Track 2).bin'))).equals(raw)).toBe(true)

    // Track 1 stores two frames beyond its length, and nothing stores the three frames after them.
    const beyond = sectors(12, 2352, 7)
    const pregap = sectors(150, 2352, 8)
    const source = join(dir, 'Beyond.bin')
    await writeFile(source, Buffer.concat([Buffer.alloc(150 * 2352), beyond, pregap, AUDIO]))
    const info: CdiInfo = {
      version: '3.5',
      sessions: 1,
      tracks: [
        { number: 1, session: 1, mode: 0, sectorSize: 2352, subchannelSize: 0, pregap: 150, length: 10, stored: 162, start: 0, offset: 0, control: 0 },
        { number: 2, session: 1, mode: 0, sectorSize: 2352, subchannelSize: 0, pregap: 150, length: 10, stored: 160, start: 165, offset: 162 * 2352, control: 0 }
      ]
    }
    const p = progress()
    await splitCdi({ ...p, source, info, dir, baseName: 'Beyond', sessions: true })
    expect((await readFile(join(dir, 'Beyond (Track 1).bin'))).equals(Buffer.concat([beyond, Buffer.alloc(3 * 2352), pregap]))).toBe(true)
    expect((await readFile(join(dir, 'Beyond (Track 2).bin'))).equals(AUDIO)).toBe(true)
    expect(p.seen.at(-1)).toBe(1)
  })

  it('gives the first track its own pregap beyond 00:02:00', async () => {
    const pregap = sectors(200, 2352, 9)
    const source = await writeCdi('Late start.cdi', [{ layout: { ...AUDIO_LAYOUT, pregap: 200 }, data: AUDIO, pregap }])
    await splitCdi({ ...progress(), source, info: await readCdiInfo(source), dir, baseName: 'Late start', sessions: true })
    expect(await readFile(join(dir, 'Late start.cue'), 'utf8')).toBe('FILE "Late start.bin" BINARY\r\n  TRACK 01 AUDIO\r\n    INDEX 01 00:00:00\r\n')
    expect((await readFile(join(dir, 'Late start.bin'))).equals(Buffer.concat([pregap.subarray(150 * 2352), AUDIO]))).toBe(true)
  })

  it('drops subchannel data and pads a first session that ends early, so the second keeps its address', async () => {
    const raw = dataTrack(20, 2352)
    const source = await writeCdi('Late.cdi', [
      { layout: { ...AUDIO_LAYOUT, subchannelSize: 96 }, data: withSubchannel(AUDIO) },
      { layout: { ...DATA_LAYOUT, sectorSize: 2352, subchannelSize: 96, start: DATA_LAYOUT.start + 5 }, data: withSubchannel(raw) }
    ])
    const info = await readCdiInfo(source)
    await splitCdi({ ...progress(), source, info, dir, baseName: 'Late', sessions: true })

    expect((await readFile(join(dir, 'Late (Track 1).bin'))).equals(Buffer.concat([AUDIO, Buffer.alloc(5 * 2352)]))).toBe(true)
    expect((await readFile(join(dir, 'Late (Track 2).bin'))).equals(raw)).toBe(true)
    expect(await readFile(join(dir, 'Late.cue'), 'utf8')).toMatch(/TRACK 02 MODE2\/2352\r\n {4}INDEX 01 00:00:00\r\n$/)
  })

  it("keeps the tracks' copy, pre-emphasis and four-channel flags", async () => {
    const source = await writeCdi('Flags.cdi', [
      { layout: { ...AUDIO_LAYOUT, control: 0x0b }, data: AUDIO },
      { layout: { ...DATA_LAYOUT, control: 0x07 }, data: DATA }
    ])
    await splitCdi({ ...progress(), source, info: await readCdiInfo(source), dir, baseName: 'Flags', sessions: true })
    const sheet = await readFile(join(dir, 'Flags.cue'), 'utf8')
    expect(sheet).toMatch(/TRACK 01 AUDIO\r\n {4}FLAGS DCP 4CH PRE\r\n {4}INDEX 01/)
    // A data track's lowest bit means incremental recording, not pre-emphasis.
    expect(sheet).toMatch(/TRACK 02 MODE2\/2336\r\n {4}FLAGS DCP\r\n {4}INDEX 01/)
  })

  it('stops between chunks when cancelled', async () => {
    const source = await writeCdi('Cancel.cdi', [
      { layout: AUDIO_LAYOUT, data: AUDIO },
      { layout: DATA_LAYOUT, data: DATA }
    ])
    const controller = new AbortController()
    const run = splitCdi({ signal: controller.signal, onProgress: () => controller.abort(), source, info: await readCdiInfo(source), dir, baseName: 'Cancel', sessions: true })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readdir(dir)).not.toContain('Cancel.cue')
  })

  it('names a single track after the disc and numbers ten or more with two digits', async () => {
    const one = await writeCdi('One.cdi', [{ layout: { ...AUDIO_LAYOUT, mode: 1, sectorSize: 2048, control: 4 }, data: sectors(10, 2048, 3) }])
    expect(await splitCdi({ ...progress(), source: one, info: await readCdiInfo(one), dir, baseName: 'One', sessions: true })).toEqual(['One.cue', 'One.bin'])
    expect(await readFile(join(dir, 'One.cue'), 'utf8')).toBe('FILE "One.bin" BINARY\r\n  TRACK 01 MODE1/2048\r\n    INDEX 01 00:00:00\r\n')

    const tracks = Array.from({ length: 10 }, (_, i) => ({ layout: { ...AUDIO_LAYOUT, pregap: i === 0 ? 150 : 0, start: i === 0 ? 0 : 150 + i * 10 }, data: sectors(10, 2352, i) }))
    const ten = await writeCdi('Ten.cdi', tracks)
    const files = await splitCdi({ ...progress(), source: ten, info: await readCdiInfo(ten), dir, baseName: 'Ten', sessions: true })
    expect(files.slice(1, 3)).toEqual(['Ten (Track 01).bin', 'Ten (Track 02).bin'])
  })
})

describe('buildCdiFromSheet', () => {
  it("gives a Dreamcast CD-R its second session back, with the data track where Flycast reads it in the CHD", async () => {
    for (const [index, [text, bin]] of CHDMAN_SHEETS.entries()) {
      const sheet = await writeSheet(text, bin, `image${index}`)
      const output = join(dir, `Game${index}.cdi`)
      const p = progress()
      expect(await buildCdiFromSheet({ ...p, sheet, output })).toBe(2)

      const info = await readCdiInfo(output)
      expect(info).toMatchObject({ version: '3.5', sessions: 2 })
      expect(info.tracks.map((t) => [t.session, t.mode, t.sectorSize, t.pregap, t.length, t.start])).toEqual([
        [1, 0, 2352, 150, 10, 0],
        [2, 2, 2336, 150, 20, 11410]
      ])
      // Pregaps the CHD does not store are zeros.
      const file = await readFile(output)
      const sectorBytes = 160 * 2352 + 170 * 2336
      expect(file.subarray(0, sectorBytes).equals(Buffer.concat([Buffer.alloc(150 * 2352), CHDMAN_BIN]))).toBe(true)
      expect(file.includes(Buffer.from([32, ...Buffer.from('TEST_DISC'.padEnd(32, ' '), 'latin1')]))).toBe(true)
      expect(p.seen.at(-1)).toBe(1)

      // Splitting the image again gives the tracks of the sheet.
      await splitCdi({ ...progress(), source: output, info, dir, baseName: 'Game', sessions: true })
      expect(await readFile(join(dir, 'Game.cue'), 'utf8')).toBe(SPLIT_SHEET)
    }
  })

  it('keeps any other disc in one session, writing pregaps that are not stored as zeros', async () => {
    const data = sectors(30, 2048, 4)
    const sheet = await writeSheet(
      'FILE "image.bin" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    PREGAP 00:02:00\n    INDEX 01 00:00:30\n',
      Buffer.concat([data, AUDIO])
    )
    const output = join(dir, 'Mixed.cdi')
    expect(await buildCdiFromSheet({ ...progress(), sheet, output })).toBe(1)

    const info = await readCdiInfo(output)
    expect(info.tracks.map((t) => [t.session, t.mode, t.sectorSize, t.pregap, t.length, t.start])).toEqual([
      [1, 1, 2048, 150, 30, 0],
      [1, 0, 2352, 150, 10, 180]
    ])
    const file = await readFile(output)
    const expected = Buffer.concat([Buffer.alloc(150 * 2048), data, Buffer.alloc(150 * 2352), AUDIO])
    expect(file.subarray(0, expected.length).equals(expected)).toBe(true)
  })

  it('refuses tracks a CDI cannot hold and sheets that do not match their files', async () => {
    const form2 = await writeSheet('FILE "image.bin" BINARY\n  TRACK 01 MODE2/2324\n    INDEX 01 00:00:00\n', Buffer.alloc(2324 * 4))
    await expect(buildCdiFromSheet({ ...progress(), sheet: form2, output: join(dir, 'x.cdi') })).rejects.toThrow(
      new CdiConversionError('Track 1 holds Mode 2 Form 2 sectors (2,324 bytes each), which a CDI image cannot store')
    )
    const unknown = await writeSheet('FILE "image.bin" BINARY\n  TRACK 01 CDG\n    INDEX 01 00:00:00\n', Buffer.alloc(2448 * 4), 'cdg')
    await expect(buildCdiFromSheet({ ...progress(), sheet: unknown, output: join(dir, 'z.cdi') })).rejects.toThrow('Tracks of type CDG cannot be converted')
    const short = await writeSheet(CHDMAN_SHEET, CHDMAN_BIN.subarray(0, 5 * 2352), 'short')
    await expect(buildCdiFromSheet({ ...progress(), sheet: short, output: join(dir, 'y.cdi') })).rejects.toThrow(/does not fit its file/)
  })
})

describe('splitSheetTracks', () => {
  it('gives each track of a Dreamcast CD-R its own file and marks the sessions, leaving out the pregap of the second', async () => {
    for (const [text, bin] of CHDMAN_SHEETS) {
      await rm(dir, { recursive: true })
      await mkdir(dir)
      const sheet = await writeSheet(text, bin, 'Game')
      expect(await splitSheetTracks({ ...progress(), sheet })).toBe(true)

      expect((await readdir(dir)).sort()).toEqual(['Game (Track 1).bin', 'Game (Track 2).bin', 'Game.cue'])
      expect(await readFile(sheet, 'utf8')).toBe(SPLIT_SHEET)
      expect((await readFile(join(dir, 'Game (Track 1).bin'))).equals(AUDIO)).toBe(true)
      expect((await readFile(join(dir, 'Game (Track 2).bin'))).equals(DATA)).toBe(true)
    }
  })

  it('pads the first session by the part of a longer pregap that the gap between the sessions does not cover', async () => {
    const text = 'FILE "image.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 MODE2/2336\n    PREGAP 00:01:00\n    INDEX 00 00:00:10\n    INDEX 01 00:02:10\n'
    const sheet = await writeSheet(text, CHDMAN_BIN, 'Long')
    const p = progress()
    expect(await splitSheetTracks({ ...p, sheet })).toBe(true)
    // 75 frames of PREGAP and 150 stored ones: the gap covers 150 of them.
    expect((await readFile(join(dir, 'Long (Track 1).bin'))).equals(Buffer.concat([AUDIO, Buffer.alloc(75 * 2352)]))).toBe(true)
    expect((await readFile(join(dir, 'Long (Track 2).bin'))).equals(DATA)).toBe(true)
    expect(await readFile(sheet, 'utf8')).toMatch(/TRACK 02 MODE2\/2336\r\n {4}INDEX 01 00:00:00\r\n$/)
    expect(p.seen.at(-1)).toBe(1)
  })

  it('stores pregaps as zeros, because Flycast ignores PREGAP lines, and numbers ten or more tracks with two digits', async () => {
    // Audio tracks as chdman writes them: the first with its pregap stored, the others with PREGAP lines.
    const audio = Array.from({ length: 9 }, (_, i) => sectors(2, 2352, 20 + i))
    const text = [
      'FILE "image.bin" BINARY',
      '  TRACK 01 AUDIO',
      '    INDEX 00 00:00:00',
      '    INDEX 01 00:00:03',
      ...audio.slice(1).flatMap((_, i) => [`  TRACK ${String(i + 2).padStart(2, '0')} AUDIO`, '    PREGAP 00:00:05', `    INDEX 01 00:00:${String(5 + i * 2).padStart(2, '0')}`]),
      '  TRACK 10 MODE2/2336',
      '    INDEX 00 00:00:21',
      '    INDEX 01 00:02:21',
      ''
    ].join('\n')
    const sheet = await writeSheet(text, Buffer.concat([Buffer.alloc(3 * 2352), ...audio, Buffer.alloc(150 * 2336), DATA]), 'Long')
    expect(await splitSheetTracks({ ...progress(), sheet })).toBe(true)

    const files = (await readdir(dir)).sort()
    expect(files.slice(0, 2)).toEqual(['Long (Track 01).bin', 'Long (Track 02).bin'])
    expect(files).toHaveLength(11)
    expect((await readFile(join(dir, 'Long (Track 01).bin'))).equals(Buffer.concat([Buffer.alloc(3 * 2352), audio[0] as Buffer]))).toBe(true)
    expect((await readFile(join(dir, 'Long (Track 02).bin'))).equals(Buffer.concat([Buffer.alloc(5 * 2352), audio[1] as Buffer]))).toBe(true)
    const rewritten = await readFile(sheet, 'utf8')
    expect(rewritten).not.toMatch(/PREGAP/)
    expect(rewritten).toMatch(/^REM SESSION 01\r\nFILE "Long \(Track 01\).bin" BINARY\r\n {2}TRACK 01 AUDIO\r\n {4}INDEX 00 00:00:00\r\n {4}INDEX 01 00:00:03\r\n/)
    expect(rewritten).toMatch(/TRACK 02 AUDIO\r\n {4}INDEX 00 00:00:00\r\n {4}INDEX 01 00:00:05\r\n/)
    expect(rewritten).toMatch(/REM SESSION 02\r\nFILE "Long \(Track 10\).bin" BINARY\r\n {2}TRACK 10 MODE2\/2336\r\n {4}INDEX 01 00:00:00\r\n$/)
    expect((await readFile(join(dir, 'Long (Track 09).bin'))).equals(Buffer.concat([Buffer.alloc(5 * 2352), audio[8] as Buffer]))).toBe(true)
    expect((await readFile(join(dir, 'Long (Track 10).bin'))).equals(DATA)).toBe(true)
  })

  it('leaves other discs as chdman wrote them, Mode 2 Form 2 tracks included', async () => {
    const text = 'FILE "Game.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 MODE1/2048\n    PREGAP 00:02:00\n    INDEX 01 00:00:10\n'
    const sheet = await writeSheet(text, Buffer.concat([AUDIO, sectors(30, 2048, 5)]), 'Game')
    expect(await splitSheetTracks({ ...progress(), sheet })).toBe(false)
    expect(await readFile(sheet, 'utf8')).toBe(text)
    expect((await readdir(dir)).sort()).toEqual(['Game.bin', 'Game.cue'])

    const video = await writeSheet(
      'FILE "Video.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n  TRACK 02 MODE2/2324\n    INDEX 01 00:00:10\n',
      Buffer.concat([sectors(10, 2352, 6), sectors(10, 2324, 7)]),
      'Video'
    )
    expect(await splitSheetTracks({ ...progress(), sheet: video })).toBe(false)
  })
})
