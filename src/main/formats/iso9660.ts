/*
 * The parts of ISO 9660 (ECMA-119) and UDF (ECMA-167) needed to tell what an
 * image is. Images are read as 2048-byte sectors through a `SectorReader`.
 */

export const SECTOR_BYTES = 2048

/** Read `count` 2048-byte sectors from `lba` on; the result is shorter at the end of the image. */
export type SectorReader = (lba: number, count: number) => Promise<Buffer>

const DESCRIPTORS_START = 16
/** Volume descriptors are read up to this many sectors from the start of the set. */
const MAX_DESCRIPTORS = 32
/** Directories are read up to this many bytes. */
const MAX_DIRECTORY_BYTES = 64 * 1024

export interface Extent {
  lba: number
  bytes: number
}

export interface PrimaryVolume {
  /** The system identifier, without its padding (e.g. "PLAYSTATION" or "PSP GAME"). */
  systemId: string
  root: Extent
  /** The whole 2048-byte descriptor. */
  sector: Buffer
}

export interface DirectoryEntry {
  /** The file identifier without its version (";1"), as recorded. */
  name: string
  directory: boolean
  extent: Extent
}

function identifier(sector: Buffer): string {
  return sector.toString('latin1', 1, 6)
}

/** The primary volume descriptor at sector 16, if the image has an ISO 9660 file system. */
export async function readPrimaryVolume(read: SectorReader): Promise<PrimaryVolume | null> {
  const sector = await read(DESCRIPTORS_START, 1)
  if (sector.length < SECTOR_BYTES || sector[0] !== 1 || identifier(sector) !== 'CD001') return null
  return {
    systemId: sector.toString('latin1', 8, 40).replace(/[\s\0]+$/, ''),
    root: { lba: sector.readUInt32LE(156 + 2), bytes: sector.readUInt32LE(156 + 10) },
    sector
  }
}

/** The entries of a directory, without "." and "..". */
export async function readDirectory(read: SectorReader, directory: Extent): Promise<DirectoryEntry[]> {
  const bytes = Math.min(directory.bytes, MAX_DIRECTORY_BYTES)
  const data = await read(directory.lba, Math.ceil(bytes / SECTOR_BYTES))
  const entries: DirectoryEntry[] = []
  let position = 0
  const nextSector = (position: number): number => (Math.floor(position / SECTOR_BYTES) + 1) * SECTOR_BYTES
  while (position < Math.min(bytes, data.length)) {
    const length = data[position] as number
    // Records do not cross sectors; a zero length pads the rest of one, and a damaged record loses only its sector.
    if (length < 34 || position + length > nextSector(position)) {
      position = nextSector(position)
      continue
    }
    const nameLength = Math.min(data[position + 32] as number, length - 33)
    const raw = data.subarray(position + 33, position + 33 + nameLength)
    if (!(nameLength === 1 && (raw[0] === 0 || raw[0] === 1))) {
      entries.push({
        name: raw.toString('latin1').replace(/;\d+$/, ''),
        directory: ((data[position + 25] as number) & 0x02) !== 0,
        extent: { lba: data.readUInt32LE(position + 2), bytes: data.readUInt32LE(position + 10) }
      })
    }
    position += length
  }
  return entries
}

/** The first bytes (up to `limit`) of a file. */
export async function readFileStart(read: SectorReader, file: Extent, limit: number): Promise<Buffer> {
  const bytes = Math.min(file.bytes, limit)
  const data = await read(file.lba, Math.ceil(bytes / SECTOR_BYTES))
  return data.subarray(0, bytes)
}

/** Whether the volume recognition sequence names a UDF file system (NSR02 or NSR03 descriptor). */
export async function hasUdf(read: SectorReader): Promise<boolean> {
  const data = await read(DESCRIPTORS_START, MAX_DESCRIPTORS)
  for (let offset = 0; offset + SECTOR_BYTES <= data.length; offset += SECTOR_BYTES) {
    const id = identifier(data.subarray(offset, offset + SECTOR_BYTES))
    if (id === 'NSR02' || id === 'NSR03') return true
    if (!['CD001', 'BEA01', 'TEA01', 'BOOT2', 'CDW02'].includes(id)) return false
  }
  return false
}
