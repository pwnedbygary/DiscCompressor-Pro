import type { DetectedMedia } from '@shared/types'
import { type PrimaryVolume, SECTOR_BYTES, type SectorReader, hasUdf, readDirectory, readFileStart, readPrimaryVolume } from './iso9660'

/** PCSX2 takes a disc with more sectors than this for a DVD (pcsx2/CDVD/CDVDcommon.cpp, FindDiskType). */
export const PCSX2_CD_MAX_SECTORS = 452_849

const cd = (reason: string): DetectedMedia => ({ media: 'cd', reason })
const dvd = (reason: string): DetectedMedia => ({ media: 'dvd', reason })

/**
 * PlayStation 2 DVDs carry a UDF bridge (Sony's authoring tool writes ISO
 * 9660 and UDF 1.02 for them) and its CDs do not. PCSX2's own signs of a DVD
 * count too: more sectors than any CD, or differing 16-bit words at offsets
 * 166 and 171 of the volume descriptor.
 */
function playStation2(volume: PrimaryVolume, sectors: number, udf: boolean): DetectedMedia {
  const { sector } = volume
  const isDvd = udf || sectors > PCSX2_CD_MAX_SECTORS || sector.readUInt16LE(166) !== sector.readUInt16LE(171)
  return isDvd ? dvd('This is a PlayStation 2 DVD') : cd('This is a PlayStation 2 CD')
}

/** GameCube and Wii discs and Xbox game partitions (XISO) have no ISO 9660 file system, only these marks. */
async function consoleDisc(read: SectorReader): Promise<string | null> {
  const header = await read(0, 1)
  if (header.length >= 0x20) {
    if (header.readUInt32BE(0x1c) === 0xc2339f3d) return 'This is a GameCube disc'
    if (header.readUInt32BE(0x18) === 0x5d1c9ea3) return 'This is a Wii disc'
  }
  const xbox = await read(32, 1)
  return xbox.toString('latin1', 0, 20) === 'MICROSOFT*XBOX*MEDIA' ? 'This is an Xbox disc' : null
}

/**
 * Whether the disc an image of 2048-byte sectors came from was a CD or a DVD,
 * as far as its contents tell: PSP UMDs (whose system identifier PPSSPP
 * checks), DVD-Video discs and GameCube, Wii and Xbox discs are DVDs,
 * PlayStation discs CDs, and PlayStation 2 discs as above; otherwise an image
 * larger than any CD, or with a UDF file system, is a DVD.
 */
export async function detectDiscMedia(read: SectorReader, bytes: number): Promise<DetectedMedia> {
  if (bytes % SECTOR_BYTES !== 0) return cd("The image's size is not a multiple of 2,048 bytes")
  const sectors = bytes / SECTOR_BYTES
  const console = await consoleDisc(read)
  if (console) return dvd(console)
  const udf = await hasUdf(read)
  const volume = await readPrimaryVolume(read)
  if (volume) {
    if (/^"?(PSP GAME|UMD VIDEO|UMD AUDIO)/.test(volume.systemId)) return dvd('This is a PSP UMD image')
    const root = await readDirectory(read, volume.root)
    const find = (name: string) => root.find((entry) => entry.name.toUpperCase() === name)
    if (find('PSP_GAME')?.directory) return dvd('This is a PSP UMD image')
    const config = find('SYSTEM.CNF')
    if (config && !config.directory) {
      const text = (await readFileStart(read, config.extent, 4096)).toString('latin1')
      if (text.includes('BOOT2')) return playStation2(volume, sectors, udf)
      if (text.includes('BOOT')) return cd('This is a PlayStation disc')
    }
    if (find('PSX.EXE')) return cd('This is a PlayStation disc')
    const video = find('VIDEO_TS')
    if (video?.directory && (await readDirectory(read, video.extent)).some((entry) => entry.name.toUpperCase() === 'VIDEO_TS.IFO')) {
      return dvd('This is a DVD-Video disc')
    }
  }
  if (sectors > PCSX2_CD_MAX_SECTORS) return dvd('The image is larger than a CD can hold')
  if (udf) return dvd('The image has a UDF file system, as DVDs do')
  return cd('The image fits on a CD and shows no sign of being a DVD')
}
