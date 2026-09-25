import { open } from 'node:fs/promises'
import type { IsoLayout } from '@shared/types'

export const ISO_SECTOR_BYTES = 2048
const SECTORS_PER_CHUNK = 2048
const SYNC = Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00])
const FORM2_DATA_BYTES = 2324
const ZERO_FORM2 = Buffer.alloc(FORM2_DATA_BYTES)
const XA_SUBMODE_FORM2 = 0x20

export class IsoConversionError extends Error {}

/*
 * Sector layouts (ECMA-130 / CD-ROM XA):
 *   2352 Mode 1:  sync[12] header[4] data[2048] EDC/ECC[288]
 *   2352 Mode 2:  sync[12] header[4] subheader[8] data[2048 | 2324] ...
 *   2336 Mode 2:  subheader[8] data[2048 | 2324] ...  (sync and header stripped)
 * The subheader repeats file, channel, submode, coding; submode bit 5 marks Form 2.
 */

/**
 * Copy the 2048-byte user data of `sector` into `target`. Returns false if
 * the sector is Mode 2 Form 2 with real content, which ISO cannot represent.
 */
function extractUserData(sector: Buffer, layout: IsoLayout, index: number, target: Buffer, offset: number): boolean {
  if (layout.sectorSize === ISO_SECTOR_BYTES) {
    sector.copy(target, offset)
    return true
  }
  if (layout.sectorSize === 2352) {
    if (!sector.subarray(0, 12).equals(SYNC)) {
      throw new IsoConversionError(`Sector ${index} has no sync pattern, so the track is not raw 2352-byte data`)
    }
    const mode = sector[15]
    if (mode === 0) {
      target.fill(0, offset, offset + ISO_SECTOR_BYTES)
      return true
    }
    if (mode !== layout.mode) {
      throw new IsoConversionError(`Sector ${index} is Mode ${mode} but the track is declared as Mode ${layout.mode}`)
    }
    if (mode === 1) {
      sector.copy(target, offset, 16, 16 + ISO_SECTOR_BYTES)
      return true
    }
  }
  // Mode 2: the subheader starts at byte 16 of a raw sector, or byte 0 of a 2336-byte one.
  const subheader = layout.sectorSize === 2352 ? 16 : 0
  const data = subheader + 8
  if (((sector[subheader + 2] ?? 0) & XA_SUBMODE_FORM2) !== 0) {
    if (!sector.subarray(data, data + FORM2_DATA_BYTES).equals(ZERO_FORM2)) return false
    target.fill(0, offset, offset + ISO_SECTOR_BYTES)
    return true
  }
  sector.copy(target, offset, data, data + ISO_SECTOR_BYTES)
  return true
}

/**
 * Convert a raw single-track CD image into a 2048-byte-per-sector ISO,
 * streaming in large chunks. Tracks that already use 2048-byte sectors are
 * ISO data as-is and should be used directly instead of converted.
 */
export async function convertTrackToIso(options: {
  source: string
  destination: string
  layout: IsoLayout
  signal: AbortSignal
  onProgress: (fraction: number) => void
}): Promise<void> {
  const { source, destination, layout, signal, onProgress } = options
  const input = await open(source, 'r')
  try {
    const { size } = await input.stat()
    if (size % layout.sectorSize !== 0) {
      throw new IsoConversionError(`The track is not a whole number of ${layout.sectorSize}-byte sectors`)
    }
    const output = await open(destination, 'w')
    try {
      const readBuffer = Buffer.allocUnsafe(SECTORS_PER_CHUNK * layout.sectorSize)
      const writeBuffer = Buffer.allocUnsafe(SECTORS_PER_CHUNK * ISO_SECTOR_BYTES)
      let position = 0
      let sectorIndex = 0
      while (position < size) {
        signal.throwIfAborted()
        const { bytesRead } = await input.read(readBuffer, 0, Math.min(readBuffer.length, size - position), position)
        if (bytesRead === 0) throw new IsoConversionError('The track file ended unexpectedly')
        const sectors = Math.floor(bytesRead / layout.sectorSize)
        for (let i = 0; i < sectors; i += 1) {
          const sector = readBuffer.subarray(i * layout.sectorSize, (i + 1) * layout.sectorSize)
          if (!extractUserData(sector, layout, sectorIndex + i, writeBuffer, i * ISO_SECTOR_BYTES)) {
            throw new IsoConversionError(
              `Sector ${sectorIndex + i} holds Mode 2 Form 2 data (XA audio or video), which an ISO cannot store. ` +
                'Keep this disc as BIN/CUE or CHD instead.'
            )
          }
        }
        await output.write(writeBuffer, 0, sectors * ISO_SECTOR_BYTES)
        position += sectors * layout.sectorSize
        sectorIndex += sectors
        onProgress(position / size)
      }
    } finally {
      await output.close()
    }
  } finally {
    await input.close()
  }
}
