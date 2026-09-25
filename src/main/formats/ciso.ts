import { type FileHandle, open } from 'node:fs/promises'
import { inflateRawSync, inflateSync } from 'node:zlib'
import { CSO_BLOCK_MAX } from '@shared/formats'
import type { CisoInfo } from '@shared/types'
import { SECTOR_BYTES, type SectorReader } from './iso9660'
import { decodeLz4Block } from './lz4'

const DAX_BLOCK_BYTES = 0x2000
const CSO_HEADER_BYTES = 24
const DAX_HEADER_BYTES = 32
const CACHED_BLOCKS = 16

/**
 * Parse a CSO/ZSO/DAX header (layouts from maxcso's src/cso.h and src/dax.h,
 * little-endian):
 *   CISO/ZISO: magic[4] header_size:u32 uncompressed_size:u64 block_size:u32 version:u8 index_shift:u8
 *   DAX:       magic[4] uncompressed_size:u32 version:u32
 */
export function parseCisoHeader(header: Buffer): CisoInfo {
  if (header.length < 24) throw new Error('File is too short to be a CSO, ZSO or DAX image')
  const magic = header.toString('latin1', 0, 4)
  if (magic === 'CISO' || magic === 'ZISO') {
    const version = header.readUInt8(20)
    return {
      format: magic === 'ZISO' ? 'zso' : version === 2 ? 'cso2' : 'cso1',
      uncompressedBytes: Number(header.readBigUInt64LE(8)),
      blockSize: header.readUInt32LE(16)
    }
  }
  if (magic === 'DAX\0') {
    return { format: 'dax', uncompressedBytes: header.readUInt32LE(4), blockSize: DAX_BLOCK_BYTES }
  }
  throw new Error('Not a CSO, ZSO or DAX image')
}

export async function readCisoInfo(path: string): Promise<CisoInfo> {
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(24)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    return parseCisoHeader(header.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

async function readAt(file: FileHandle, bytes: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(bytes)
  const { bytesRead } = await file.read(buffer, 0, bytes, position)
  if (bytesRead !== bytes) throw new Error('The compressed image is truncated')
  return buffer
}

/**
 * Blocks of a CSO or ZSO image. Index entries give each block's position
 * (shifted left by index_shift); their high bit means uncompressed in CSO v1
 * and ZSO (whose blocks are otherwise raw deflate and LZ4), and LZ4 rather
 * than raw deflate in CSO v2, where blocks of block_size bytes or more are
 * stored uncompressed.
 */
function csoBlock(file: FileHandle, header: Buffer, info: CisoInfo): (index: number) => Promise<Buffer> {
  const scale = 2 ** header.readUInt8(21)
  return async (index) => {
    const entries = await readAt(file, 8, CSO_HEADER_BYTES + index * 4)
    const entry = entries.readUInt32LE(0)
    const start = (entry & 0x7fffffff) * scale
    const length = (entries.readUInt32LE(4) & 0x7fffffff) * scale - start
    if (length <= 0 || length > info.blockSize * 2) throw new Error('The compressed image has a damaged index')
    const data = await readAt(file, length, start)
    const flagged = entry >>> 31 === 1
    // A block that inflates to more than its size is damaged; the limit also keeps a damaged file from taking memory.
    const limit = { maxOutputLength: info.blockSize }
    switch (info.format) {
      case 'cso1':
        return flagged ? data.subarray(0, info.blockSize) : inflateRawSync(data, limit)
      case 'cso2':
        if (length >= info.blockSize) return data.subarray(0, info.blockSize)
        return flagged ? decodeLz4Block(data, info.blockSize) : inflateRawSync(data, limit)
      default:
        return flagged ? data.subarray(0, info.blockSize) : decodeLz4Block(data, info.blockSize)
    }
  }
}

/** DAX frames are zlib streams, but maxcso 1.13 writes raw deflate ones where libdeflate compresses best. */
function inflateDaxFrame(data: Buffer): Buffer {
  const limit = { maxOutputLength: DAX_BLOCK_BYTES }
  try {
    return inflateSync(data, limit)
  } catch {
    return inflateRawSync(data, limit)
  }
}

/**
 * Frames of a DAX image: a table of positions (u32) and one of sizes (u16)
 * follow the header, then (version 1) the areas of frames stored
 * uncompressed; the others are compressed.
 */
async function daxBlock(file: FileHandle, header: Buffer, info: CisoInfo): Promise<(index: number) => Promise<Buffer>> {
  const frames = Math.ceil(info.uncompressedBytes / DAX_BLOCK_BYTES)
  const sizesAt = DAX_HEADER_BYTES + frames * 4
  const areaCount = header.readUInt32LE(8) >= 1 ? Math.min(header.readUInt32LE(12), frames) : 0
  const areaData = await readAt(file, areaCount * 8, sizesAt + frames * 2)
  const areas = Array.from({ length: areaCount }, (_, i) => ({ start: areaData.readUInt32LE(i * 8), count: areaData.readUInt32LE(i * 8 + 4) }))
  return async (index) => {
    const position = (await readAt(file, 4, DAX_HEADER_BYTES + index * 4)).readUInt32LE(0)
    const length = (await readAt(file, 2, sizesAt + index * 2)).readUInt16LE(0)
    const data = await readAt(file, length, position)
    const stored = areas.some((area) => index >= area.start && index < area.start + area.count)
    return stored ? data.subarray(0, DAX_BLOCK_BYTES) : inflateDaxFrame(data)
  }
}

export interface CisoImage {
  info: CisoInfo
  /** Reads 2048-byte sectors of the image inside the file. */
  read: SectorReader
  close(): Promise<void>
}

/** Open a CSO, ZSO or DAX file to read the image it holds. */
export async function openCisoImage(path: string): Promise<CisoImage> {
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(DAX_HEADER_BYTES)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    const info = parseCisoHeader(header.subarray(0, bytesRead))
    if (info.blockSize < SECTOR_BYTES || info.blockSize > CSO_BLOCK_MAX) throw new Error('The compressed image has an unsupported block size')
    const block = info.format === 'dax' ? await daxBlock(file, header, info) : csoBlock(file, header, info)
    const cache = new Map<number, Buffer>()
    const cached = async (index: number): Promise<Buffer> => {
      let data = cache.get(index)
      if (!data) {
        data = await block(index)
        if (cache.size >= CACHED_BLOCKS) cache.delete(cache.keys().next().value as number)
        cache.set(index, data)
      }
      return data
    }
    const read: SectorReader = async (lba, count) => {
      const end = Math.min((lba + count) * SECTOR_BYTES, info.uncompressedBytes)
      const parts: Buffer[] = []
      for (let position = lba * SECTOR_BYTES; position < end; ) {
        const index = Math.floor(position / info.blockSize)
        const offset = position - index * info.blockSize
        const take = Math.min(end - position, info.blockSize - offset)
        const data = await cached(index)
        if (data.length < offset + take) throw new Error('A block of the compressed image is shorter than it should be')
        parts.push(data.subarray(offset, offset + take))
        position += take
      }
      return Buffer.concat(parts)
    }
    return { info, read, close: () => file.close() }
  } catch (error) {
    await file.close()
    throw error
  }
}
