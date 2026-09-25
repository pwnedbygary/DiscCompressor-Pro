import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseChdHeader, readChdInfo, tracksFromChcd } from './chd'
import { parseCisoHeader } from './ciso'

const tag = (name: string): number => name.split('').reduce((value, char) => (value << 8) | char.charCodeAt(0), 0) >>> 0

function metadataEntry(name: string, data: Buffer, next: number): Buffer {
  const header = Buffer.alloc(16)
  header.writeUInt32BE(tag(name), 0)
  header.writeUInt8(1, 4)
  header.writeUIntBE(data.length, 5, 3)
  header.writeBigUInt64BE(BigInt(next), 8)
  return Buffer.concat([header, data])
}

function v5Header(options: { codecs: string[]; logical: number; hunk: number; unit: number; metaOffset: number }): Buffer {
  const header = Buffer.alloc(124)
  header.write('MComprHD', 0, 'latin1')
  header.writeUInt32BE(124, 8)
  header.writeUInt32BE(5, 12)
  options.codecs.forEach((codec, i) => header.writeUInt32BE(tag(codec), 16 + i * 4))
  header.writeBigUInt64BE(BigInt(options.logical), 32)
  header.writeBigUInt64BE(0n, 40)
  header.writeBigUInt64BE(BigInt(options.metaOffset), 48)
  header.writeUInt32BE(options.hunk, 56)
  header.writeUInt32BE(options.unit, 60)
  return header
}

/** Build a CHD whose metadata chain holds the given entries, in order. */
function chdFile(header: (metaOffset: number) => Buffer, entries: [string, Buffer][]): Buffer {
  const headerSize = header(0).length
  const parts: Buffer[] = []
  let offset = headerSize
  entries.forEach(([name, data], index) => {
    const next = index === entries.length - 1 ? 0 : offset + 16 + data.length
    parts.push(metadataEntry(name, data, next))
    offset += 16 + data.length
  })
  return Buffer.concat([header(entries.length > 0 ? headerSize : 0), ...parts])
}

const text = (value: string): Buffer => Buffer.from(`${value}\0`, 'latin1')

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dcp-chd-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readChdInfo', () => {
  it('reads a v5 CD CHD with CHT2 track metadata', async () => {
    const file = join(dir, 'cd.chd')
    await writeFile(
      file,
      chdFile((meta) => v5Header({ codecs: ['cdlz', 'cdzl', 'cdfl'], logical: 48960000, hunk: 19584, unit: 2448, metaOffset: meta }), [
        ['CHT2', text('TRACK:1 TYPE:MODE2_RAW SUBTYPE:NONE FRAMES:20000 PREGAP:0 PGTYPE:MODE2_RAW PGSUB:RW POSTGAP:0')],
        ['CHT2', text('TRACK:2 TYPE:AUDIO SUBTYPE:NONE FRAMES:5000 PREGAP:150 PGTYPE:VAUDIO PGSUB:RW POSTGAP:0')]
      ])
    )
    expect(await readChdInfo(file)).toEqual({
      version: 5,
      logicalBytes: 48960000,
      hunkBytes: 19584,
      unitBytes: 2448,
      codecs: ['cdlz', 'cdzl', 'cdfl'],
      media: 'cd',
      tracks: [
        { number: 1, type: 'MODE2_RAW', sectorSize: 2352, frames: 20000 },
        { number: 2, type: 'AUDIO', sectorSize: 2352, frames: 5000 }
      ],
      hasParent: false
    })
  })

  it('detects DVD and GD-ROM media', async () => {
    const dvd = join(dir, 'dvd.chd')
    await writeFile(dvd, chdFile((meta) => v5Header({ codecs: ['lzma', 'zlib', 'huff', 'flac'], logical: 4096, hunk: 4096, unit: 2048, metaOffset: meta }), [['DVD ', Buffer.alloc(1)]]))
    expect((await readChdInfo(dvd)).media).toBe('dvd')

    const gd = join(dir, 'gd.chd')
    await writeFile(
      gd,
      chdFile((meta) => v5Header({ codecs: ['cdlz'], logical: 1, hunk: 19584, unit: 2448, metaOffset: meta }), [
        ['CHGD', text('TRACK:1 TYPE:MODE1_RAW SUBTYPE:NONE FRAMES:1000 PAD:0 PREGAP:0 PGTYPE:MODE1 PGSUB:RW POSTGAP:0')]
      ])
    )
    const info = await readChdInfo(gd)
    expect(info.media).toBe('gdrom')
    expect(info.tracks[0]).toMatchObject({ type: 'MODE1_RAW', sectorSize: 2352 })
  })

  it('stops on metadata cycles instead of looping forever', async () => {
    const file = join(dir, 'cycle.chd')
    const data = text('TRACK:1 TYPE:MODE1 SUBTYPE:NONE FRAMES:10 PREGAP:0 PGTYPE:MODE1 PGSUB:RW POSTGAP:0')
    const entry = metadataEntry('CHT2', data, 124)
    await writeFile(file, Buffer.concat([v5Header({ codecs: ['cdzl'], logical: 1, hunk: 19584, unit: 2448, metaOffset: 124 }), entry]))
    expect((await readChdInfo(file)).tracks).toHaveLength(1)
  })

  it('reads v4 headers with legacy binary CHCD metadata', async () => {
    const header = (meta: number): Buffer => {
      const buffer = Buffer.alloc(108)
      buffer.write('MComprHD', 0, 'latin1')
      buffer.writeUInt32BE(108, 8)
      buffer.writeUInt32BE(4, 12)
      buffer.writeUInt32BE(0, 16)
      buffer.writeUInt32BE(1, 20)
      buffer.writeBigUInt64BE(1000n, 28)
      buffer.writeBigUInt64BE(BigInt(meta), 36)
      buffer.writeUInt32BE(9792, 44)
      return buffer
    }
    const chcd = Buffer.alloc(4 + 99 * 24)
    chcd.writeUInt32LE(1, 0)
    chcd.writeUInt32LE(0, 4) // MODE1
    chcd.writeUInt32LE(2048, 12)
    chcd.writeUInt32LE(300, 20)
    const file = join(dir, 'v4.chd')
    await writeFile(file, chdFile(header, [['CHCD', chcd]]))
    const info = await readChdInfo(file)
    expect(info).toMatchObject({ version: 4, codecs: ['zlib'], media: 'cd', hunkBytes: 9792, unitBytes: 2448 })
    expect(info.tracks).toEqual([{ number: 1, type: 'MODE1', sectorSize: 2048, frames: 300 }])
  })
})

describe('tracksFromChcd', () => {
  it('detects big-endian data by the track count, like MAME', () => {
    const chcd = Buffer.alloc(4 + 99 * 24)
    chcd.writeUInt32BE(1, 0)
    chcd.writeUInt32BE(7, 4) // AUDIO
    chcd.writeUInt32BE(2352, 12)
    chcd.writeUInt32BE(42, 20)
    expect(tracksFromChcd(chcd)).toEqual([{ number: 1, type: 'AUDIO', sectorSize: 2352, frames: 42 }])
  })
})

describe('parseChdHeader', () => {
  it('rejects non-CHD data and unsupported versions', () => {
    expect(() => parseChdHeader(Buffer.from('not a chd at all, clearly'))).toThrow(/Not a CHD/)
    const header = v5Header({ codecs: [], logical: 0, hunk: 0, unit: 0, metaOffset: 0 })
    header.writeUInt32BE(2, 12)
    expect(() => parseChdHeader(header)).toThrow(/version 2/)
  })
})

describe('parseCisoHeader', () => {
  const header = (magic: string, version: number): Buffer => {
    const buffer = Buffer.alloc(24)
    buffer.write(magic, 0, 'latin1')
    buffer.writeUInt32LE(24, 4)
    buffer.writeBigUInt64LE(123456789n * 2048n, 8)
    buffer.writeUInt32LE(2048, 16)
    buffer.writeUInt8(version, 20)
    return buffer
  }

  it('identifies CSO v1, CSO v2 and ZSO', () => {
    expect(parseCisoHeader(header('CISO', 1))).toEqual({ format: 'cso1', uncompressedBytes: 123456789 * 2048, blockSize: 2048 })
    expect(parseCisoHeader(header('CISO', 2)).format).toBe('cso2')
    expect(parseCisoHeader(header('ZISO', 1)).format).toBe('zso')
  })

  it('identifies DAX', () => {
    const dax = Buffer.alloc(24)
    dax.write('DAX\0', 0, 'latin1')
    dax.writeUInt32LE(8192 * 10, 4)
    expect(parseCisoHeader(dax)).toEqual({ format: 'dax', uncompressedBytes: 81920, blockSize: 8192 })
  })

  it('rejects anything else', () => {
    expect(() => parseCisoHeader(Buffer.alloc(24))).toThrow(/Not a CSO/)
  })
})
