import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scanInput, scanPaths } from './scan'
import { syntheticChd, syntheticCso } from './testing/fixtures'

let dir: string
const SINGLE_CUE = 'FILE "Single.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n'

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dcp-scan-'))
  const file = (name: string, data: string | Buffer): Promise<void> => writeFile(join(dir, name), data)
  await file('Single.cue', SINGLE_CUE)
  await file('Single.bin', Buffer.alloc(2352 * 4))
  await file('Multi.cue', 'FILE "Multi.bin" BINARY\n TRACK 01 MODE1/2352\n  INDEX 01 00:00:00\n TRACK 02 AUDIO\n  INDEX 01 00:10:00\n')
  await file('Multi.bin', Buffer.alloc(2352 * 800))
  await file('Missing.cue', 'FILE "Nowhere.bin" BINARY\n TRACK 01 MODE1/2048\n  INDEX 01 00:00:00\n')
  await file('Data.cue', 'FILE "Data.iso" BINARY\n TRACK 01 MODE1/2048\n  INDEX 01 00:00:00\n')
  await file('Data.iso', Buffer.alloc(2048 * 3))
  await file('Dream.gdi', '2\n1 0 4 2352 "Dream 01.bin" 0\n2 45000 4 2352 Dream02.bin 0\n')
  await file('Dream 01.bin', Buffer.alloc(2352))
  await file('Dream02.bin', Buffer.alloc(2352 * 2))
  await file('Plain.iso', Buffer.alloc(2048 * 5))
  await file('Odd.iso', Buffer.alloc(3000))
  await file('Disc.chd', syntheticChd({ codecs: ['cdlz'], hunk: 19584, unit: 2448, logical: 1, metadata: [['CHT2', 'TRACK:1 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:10 PREGAP:0 PGTYPE:MODE1 PGSUB:RW POSTGAP:0']] }))
  await file('Game.zso', syntheticCso(2048 * 10, 'ZISO'))
  await file('notes.txt', 'hello')
  await mkdir(join(dir, 'sub'))
  await writeFile(join(dir, 'sub', 'Nested.iso'), Buffer.alloc(2048))
  await mkdir(join(dir, '.hidden'))
  await writeFile(join(dir, '.hidden', 'Hidden.iso'), Buffer.alloc(2048))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('scanPaths', () => {
  it('finds images recursively, skipping hidden folders and files referenced by sheets', async () => {
    const { inputs, skipped } = await scanPaths([dir])
    expect(inputs.map((input) => input.path.slice(dir.length + 1))).toEqual([
      'Data.cue',
      'Disc.chd',
      'Dream.gdi',
      'Game.zso',
      'Missing.cue',
      'Multi.cue',
      'Odd.iso',
      'Plain.iso',
      'Single.cue',
      join('sub', 'Nested.iso')
    ])
    expect(skipped).toEqual([])
  })

  it('reports unsupported and missing paths', async () => {
    const { inputs, skipped } = await scanPaths([join(dir, 'notes.txt'), join(dir, 'nope.iso')])
    expect(inputs).toEqual([])
    expect(skipped).toEqual([
      { path: join(dir, 'nope.iso'), reason: 'Not found' },
      { path: join(dir, 'notes.txt'), reason: 'Not a supported disc image' }
    ])
  })

  it('treats track files selected with their sheet as part of it', async () => {
    const { inputs, skipped } = await scanPaths([join(dir, 'Single.cue'), join(dir, 'Single.bin'), join(dir, 'Multi.bin')])
    expect(inputs.map((input) => input.name)).toEqual(['Single.cue'])
    expect(skipped).toEqual([{ path: join(dir, 'Multi.bin'), reason: 'Not a supported disc image' }])
  })
})

describe('scanInput', () => {
  it('describes a single-track cue sheet that can become an ISO', async () => {
    const input = await scanInput(join(dir, 'Single.cue'))
    expect(input).toMatchObject({
      kind: 'cue',
      media: 'cd',
      size: 2352 * 4 + Buffer.byteLength(SINGLE_CUE),
      files: [join(dir, 'Single.cue'), join(dir, 'Single.bin')],
      isoLayout: { sectorSize: 2352, mode: 2 },
      isoBlocker: null,
      problem: null
    })
  })

  it('explains why multi-track discs cannot become ISOs', async () => {
    const input = await scanInput(join(dir, 'Multi.cue'))
    expect(input.isoLayout).toBeNull()
    expect(input.isoBlocker).toMatch(/2 tracks/)
  })

  it('flags missing track files', async () => {
    expect((await scanInput(join(dir, 'Missing.cue'))).problem).toBe('Missing track file: Nowhere.bin')
  })

  it('collects GDI track files, quoted or not', async () => {
    const input = await scanInput(join(dir, 'Dream.gdi'))
    expect(input.files.slice(1)).toEqual([join(dir, 'Dream 01.bin'), join(dir, 'Dream02.bin')])
    expect(input).toMatchObject({ media: 'gdrom', size: expect.any(Number) as unknown, problem: null })
  })

  it('reads CHD and ZSO headers', async () => {
    const chd = await scanInput(join(dir, 'Disc.chd'))
    expect(chd).toMatchObject({ media: 'cd', isoLayout: { sectorSize: 2352, mode: 1 }, tracks: [{ type: 'MODE1_RAW' }] })
    const zso = await scanInput(join(dir, 'Game.zso'))
    expect(zso.ciso).toEqual({ format: 'zso', uncompressedBytes: 20480, blockSize: 2048 })
  })

  it('marks misaligned ISOs and unreadable files without throwing', async () => {
    expect((await scanInput(join(dir, 'Odd.iso'))).isoBlocker).toMatch(/multiple of 2048/)
    expect((await scanInput(join(dir, 'Gone.iso'))).problem).toBe('File not found')
    await writeFile(join(dir, 'Broken.chd'), 'garbage')
    expect((await scanInput(join(dir, 'Broken.chd'))).problem).toMatch(/Not a CHD file/)
  })
})
