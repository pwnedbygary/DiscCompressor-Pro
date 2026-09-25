import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openCisoImage } from './ciso'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dcp-ciso-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Sectors that differ from each other, so that a sector read from the wrong place shows. */
function image(sectors: number): Buffer {
  const data = Buffer.alloc(sectors * 2048)
  for (let i = 0; i < data.length; i += 1) data[i] = (Math.floor(i / 2048) * 7 + (i % 251)) & 0xff
  return data
}

/** An LZ4 block of `size` copies of one byte: a literal, then a match of the rest. */
function lz4Run(byte: number, size: number): Buffer {
  let rest = size - 1 - 4 - 15
  const extra: number[] = []
  for (; rest >= 255; rest -= 255) extra.push(255)
  return Buffer.from([0x1f, byte, 1, 0, ...extra, rest])
}

type Block = { data: Buffer; flag: boolean }

/** A CSO or ZSO file of the given blocks, with its data aligned to 2^shift bytes. */
function csoFile(magic: 'CISO' | 'ZISO', version: number, blockSize: number, bytes: number, blocks: Block[], shift = 0): Buffer {
  const header = Buffer.alloc(24)
  header.write(magic, 0, 'latin1')
  header.writeUInt32LE(24, 4)
  header.writeBigUInt64LE(BigInt(bytes), 8)
  header.writeUInt32LE(blockSize, 16)
  header[20] = version
  header[21] = shift
  const align = (n: number): number => Math.ceil(n / 2 ** shift) * 2 ** shift
  let position = align(24 + (blocks.length + 1) * 4)
  const index = Buffer.alloc((blocks.length + 1) * 4)
  const parts: Buffer[] = []
  blocks.forEach((block, i) => {
    index.writeUInt32LE(((position / 2 ** shift) | (block.flag ? 0x80000000 : 0)) >>> 0, i * 4)
    const padded = Buffer.concat([block.data], align(block.data.length))
    parts.push(padded)
    position += padded.length
  })
  index.writeUInt32LE(position / 2 ** shift, blocks.length * 4)
  const head = Buffer.concat([header, index])
  return Buffer.concat([head, Buffer.alloc(align(head.length) - head.length), ...parts])
}

async function sectors(file: Buffer, name: string, lbas: number[]): Promise<Buffer[]> {
  const path = join(dir, name)
  await writeFile(path, file)
  const opened = await openCisoImage(path)
  try {
    return await Promise.all(lbas.map((lba) => opened.read(lba, 1)))
  } finally {
    await opened.close()
  }
}

const sector = (data: Buffer, lba: number): Buffer => data.subarray(lba * 2048, (lba + 1) * 2048)

describe('openCisoImage', () => {
  it('reads CSO v1 blocks, compressed with raw deflate or stored, with or without an index shift', async () => {
    const data = image(8)
    const blocks = [0, 1, 2, 3].map((i) => {
      const plain = data.subarray(i * 4096, (i + 1) * 4096)
      return i === 2 ? { data: plain, flag: true } : { data: deflateRawSync(plain), flag: false }
    })
    for (const shift of [0, 2]) {
      const read = await sectors(csoFile('CISO', 1, 4096, data.length, blocks, shift), `v1-${shift}.cso`, [0, 3, 4, 5, 7])
      expect(read.map((s) => s.toString('hex'))).toEqual([0, 3, 4, 5, 7].map((lba) => sector(data, lba).toString('hex')))
    }
  })

  it('reads CSO v2 blocks by their size and flag, and ZSO blocks as LZ4', async () => {
    const data = Buffer.concat([Buffer.alloc(2048, 0x41), image(2), Buffer.alloc(2048, 0x42)])
    const v2 = csoFile('CISO', 2, 2048, data.length, [
      { data: lz4Run(0x41, 2048), flag: true },
      { data: deflateRawSync(sector(data, 1)), flag: false },
      { data: sector(data, 2), flag: true },
      { data: lz4Run(0x42, 2048), flag: true }
    ])
    expect(Buffer.concat(await sectors(v2, 'v2.cso', [0, 1, 2, 3])).equals(data)).toBe(true)
    const zso = csoFile('ZISO', 1, 2048, data.length, [
      { data: lz4Run(0x41, 2048), flag: false },
      { data: sector(data, 1), flag: true },
      { data: sector(data, 2), flag: true },
      { data: lz4Run(0x42, 2048), flag: false }
    ])
    expect(Buffer.concat(await sectors(zso, 'image.zso', [0, 1, 2, 3])).equals(data)).toBe(true)
  })

  it('reads DAX frames, compressed with zlib or raw deflate or stored in an uncompressed area', async () => {
    const data = image(12)
    const frames = [0, 1, 2].map((i) => data.subarray(i * 0x2000, (i + 1) * 0x2000))
    const stored = [false, true, false]
    const header = Buffer.alloc(32)
    header.write('DAX\0', 0, 'latin1')
    header.writeUInt32LE(data.length, 4)
    header.writeUInt32LE(1, 8)
    header.writeUInt32LE(1, 12)
    const bodies = frames.map((frame, i) => (stored[i] ? frame : i === 2 ? deflateRawSync(frame) : deflateSync(frame)))
    const tables = Buffer.alloc(3 * 4 + 3 * 2 + 8)
    let position = 32 + tables.length
    bodies.forEach((body, i) => {
      tables.writeUInt32LE(position, i * 4)
      tables.writeUInt16LE(body.length, 12 + i * 2)
      position += body.length
    })
    tables.writeUInt32LE(1, 18)
    tables.writeUInt32LE(1, 22)
    const read = await sectors(Buffer.concat([header, tables, ...bodies]), 'image.dax', [0, 5, 11])
    expect(read.map((s) => s.toString('hex'))).toEqual([0, 5, 11].map((lba) => sector(data, lba).toString('hex')))
  })

  it('reads sectors across blocks and stops at the end of the image', async () => {
    const data = image(4)
    const file = csoFile('CISO', 1, 2048, data.length, [0, 1, 2, 3].map((i) => ({ data: deflateRawSync(sector(data, i)), flag: false })))
    const path = join(dir, 'span.cso')
    await writeFile(path, file)
    const opened = await openCisoImage(path)
    try {
      expect((await opened.read(1, 2)).equals(data.subarray(2048, 3 * 2048))).toBe(true)
      expect(await opened.read(3, 5)).toHaveLength(2048)
      expect(await opened.read(9, 1)).toHaveLength(0)
    } finally {
      await opened.close()
    }
  })

  it('rejects damaged files', async () => {
    const bad = csoFile('CISO', 1, 2048, 2048, [{ data: Buffer.alloc(8), flag: false }])
    bad.writeUInt32LE(0, 28)
    const path = join(dir, 'bad.cso')
    await writeFile(path, bad)
    const opened = await openCisoImage(path)
    await expect(opened.read(0, 1)).rejects.toThrow(/damaged index/)
    await opened.close()
    await writeFile(join(dir, 'tiny.cso'), csoFile('CISO', 1, 512, 2048, []))
    await expect(openCisoImage(join(dir, 'tiny.cso'))).rejects.toThrow(/block size/)
  })
})
