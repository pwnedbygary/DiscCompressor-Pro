import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IsoLayout } from '@shared/types'
import { IsoConversionError, convertTrackToIso } from './iso'
import { playlistName, updatePlaylist } from './playlist'
import { LineSplitter, formatCommand } from './process'
import { isChdmanNoise, parseChdmanProgress } from './progress'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dcp-io-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const SYNC = [0x00, ...Array<number>(10).fill(0xff), 0x00]

/** A sector whose user data is filled with `fill`. */
function sector(layout: IsoLayout, fill: number, options: { mode?: number; form2?: boolean } = {}): Buffer {
  const buffer = Buffer.alloc(layout.sectorSize, 0x5a)
  let data = 0
  if (layout.sectorSize === 2352) {
    Buffer.from(SYNC).copy(buffer, 0)
    buffer[15] = options.mode ?? layout.mode
    data = 16
  }
  if (layout.mode === 2 && layout.sectorSize !== 2048) {
    const submode = options.form2 ? 0x20 : 0x08
    buffer[data + 2] = submode
    buffer[data + 6] = submode
    data += 8
  }
  buffer.fill(fill, data, data + (options.form2 ? 2324 : 2048))
  return buffer
}

async function convert(layout: IsoLayout, sectors: Buffer[]): Promise<Buffer> {
  const source = join(dir, `track-${layout.sectorSize}-${layout.mode}.bin`)
  const destination = `${source}.iso`
  await writeFile(source, Buffer.concat(sectors))
  const progress: number[] = []
  await convertTrackToIso({ source, destination, layout, signal: new AbortController().signal, onProgress: (p) => progress.push(p) })
  expect(progress.at(-1)).toBe(1)
  return readFile(destination)
}

describe('convertTrackToIso', () => {
  it('extracts Mode 1 raw sectors', async () => {
    const layout: IsoLayout = { sectorSize: 2352, mode: 1 }
    const iso = await convert(layout, [sector(layout, 1), sector(layout, 2)])
    expect(iso).toEqual(Buffer.concat([Buffer.alloc(2048, 1), Buffer.alloc(2048, 2)]))
  })

  it('extracts Mode 2 Form 1 sectors from raw and 2336-byte tracks', async () => {
    for (const layout of [{ sectorSize: 2352, mode: 2 }, { sectorSize: 2336, mode: 2 }] as IsoLayout[]) {
      const iso = await convert(layout, [sector(layout, 7), sector(layout, 8)])
      expect(iso).toEqual(Buffer.concat([Buffer.alloc(2048, 7), Buffer.alloc(2048, 8)]))
    }
  })

  it('treats zero-filled Form 2 sectors as empty and Mode 0 sectors as zeros', async () => {
    const layout: IsoLayout = { sectorSize: 2352, mode: 2 }
    const iso = await convert(layout, [sector(layout, 3), sector(layout, 0, { form2: true }), sector(layout, 0, { mode: 0 })])
    expect(iso).toEqual(Buffer.concat([Buffer.alloc(2048, 3), Buffer.alloc(4096)]))
  })

  it('refuses Form 2 sectors with data', async () => {
    const layout: IsoLayout = { sectorSize: 2352, mode: 2 }
    await expect(convert(layout, [sector(layout, 1), sector(layout, 9, { form2: true })])).rejects.toThrow(/Sector 1 holds Mode 2 Form 2/)
  })

  it('refuses sectors that do not match the declared layout', async () => {
    const mode1: IsoLayout = { sectorSize: 2352, mode: 1 }
    await expect(convert(mode1, [sector({ sectorSize: 2352, mode: 2 }, 1)])).rejects.toBeInstanceOf(IsoConversionError)
    await expect(convert(mode1, [Buffer.alloc(2352)])).rejects.toThrow(/no sync pattern/)
  })

  it('stops when cancelled', async () => {
    const layout: IsoLayout = { sectorSize: 2352, mode: 1 }
    const source = join(dir, 'cancel.bin')
    await writeFile(source, sector(layout, 1))
    const controller = new AbortController()
    controller.abort()
    await expect(
      convertTrackToIso({ source, destination: `${source}.iso`, layout, signal: controller.signal, onProgress: () => undefined })
    ).rejects.toThrow()
  })
})

describe('chdman output parsing', () => {
  it('reads every progress message format', () => {
    expect(parseChdmanProgress('Compressing, 45.3% complete... (ratio=52.1%)')).toBeCloseTo(0.453)
    expect(parseChdmanProgress('Extracting, 100.0% complete...')).toBe(1)
    expect(parseChdmanProgress('Verifying, 3.0% complete...')).toBeCloseTo(0.03)
    expect(parseChdmanProgress('Examining parent, 12.5% complete...')).toBeCloseTo(0.125)
  })

  it('does not mistake the final ratio for progress', () => {
    expect(parseChdmanProgress('Compression complete ... final ratio = 45.2%')).toBeNull()
    expect(isChdmanNoise('Compression complete ... final ratio = 45.2%')).toBe(true)
  })
})

describe('LineSplitter', () => {
  it('splits on CR, LF and CRLF across chunk boundaries and keeps UTF-8 intact', () => {
    const lines: string[] = []
    const splitter = new LineSplitter((line) => lines.push(line))
    const bytes = Buffer.from('Compressing, 1.0% complete...\rCompressing, 2.0%', 'utf8')
    splitter.push(bytes)
    splitter.push(Buffer.from(' complete...\r\nInput: /tmp/日本語', 'utf8').subarray(0, 32))
    splitter.push(Buffer.from(' complete...\r\nInput: /tmp/日本語', 'utf8').subarray(32))
    splitter.end()
    expect(lines).toEqual(['Compressing, 1.0% complete...', 'Compressing, 2.0% complete...', 'Input: /tmp/日本語'])
  })
})

describe('formatCommand', () => {
  it('quotes arguments with spaces', () => {
    expect(formatCommand('chdman', ['createcd', '-i', '/in/My Game.cue'])).toBe('chdman createcd -i "/in/My Game.cue"')
  })
})

describe('playlists', () => {
  it('recognises disc tags', () => {
    expect(playlistName('Final Fantasy VII (USA) (Disc 1)')).toBe('Final Fantasy VII (USA)')
    expect(playlistName('Game [Disk 2]')).toBe('Game')
    expect(playlistName('Game (Disc 1 of 3) (Rev 1)')).toBe('Game (Rev 1)')
    expect(playlistName('Game (USA)')).toBeNull()
  })

  it('lists every disc of the set in natural order', async () => {
    const set = join(dir, 'set')
    await rm(set, { recursive: true, force: true })
    await mkdir(set)
    for (const name of ['Game (Disc 10).chd', 'Game (Disc 2).chd', 'Game (Disc 1).chd', 'Game (Disc 1).cue', 'Other (Disc 1).chd']) {
      await writeFile(join(set, name), '')
    }
    const playlist = join(set, 'Game.m3u')
    expect(await updatePlaylist(join(set, 'Game (Disc 2).chd'), false)).toEqual({ path: playlist, written: true })
    expect(await readFile(playlist, 'utf8')).toBe('Game (Disc 1).chd\nGame (Disc 2).chd\nGame (Disc 10).chd\n')
    expect(await updatePlaylist(join(set, 'Single.chd'), false)).toBeNull()
  })

  it('keeps every disc when jobs finish at the same time', async () => {
    const set = join(dir, 'parallel')
    await mkdir(set, { recursive: true })
    const discs = Array.from({ length: 8 }, (_, i) => `Game (Disc ${i + 1}).chd`)
    await Promise.all(discs.map((name) => writeFile(join(set, name), '')))
    await Promise.all(discs.map((name) => updatePlaylist(join(set, name), false)))
    expect(await readFile(join(set, 'Game.m3u'), 'utf8')).toBe(`${discs.join('\n')}\n`)
    expect((await readdir(set)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('leaves hand-made playlists alone unless told to replace them', async () => {
    const set = join(dir, 'custom')
    await mkdir(set, { recursive: true })
    await writeFile(join(set, 'Game (Disc 1).chd'), '')
    await writeFile(join(set, 'Game.m3u'), 'discs/Game (Disc 1).chd\n')
    expect(await updatePlaylist(join(set, 'Game (Disc 1).chd'), false)).toEqual({ path: join(set, 'Game.m3u'), written: false })
    expect(await readFile(join(set, 'Game.m3u'), 'utf8')).toBe('discs/Game (Disc 1).chd\n')
    expect(await updatePlaylist(join(set, 'Game (Disc 1).chd'), true)).toMatchObject({ written: true })
    expect(await readFile(join(set, 'Game.m3u'), 'utf8')).toBe('Game (Disc 1).chd\n')
  })

  it('treats a playlist of another format as hand-made', async () => {
    const set = join(dir, 'other-format')
    await mkdir(set, { recursive: true })
    await writeFile(join(set, 'Game (Disc 1).chd'), '')
    await writeFile(join(set, 'Game.m3u'), 'Game (Disc 1).cue\nGame (Disc 2).cue\n')
    expect(await updatePlaylist(join(set, 'Game (Disc 1).chd'), false)).toMatchObject({ written: false })
    expect(await readFile(join(set, 'Game.m3u'), 'utf8')).toBe('Game (Disc 1).cue\nGame (Disc 2).cue\n')
  })
})
