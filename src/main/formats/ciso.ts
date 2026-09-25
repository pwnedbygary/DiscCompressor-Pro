import { open } from 'node:fs/promises'
import type { CisoInfo } from '@shared/types'

const DAX_BLOCK_BYTES = 0x2000

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
