import { describe, expect, it } from 'vitest'
import { directoryRecord, syntheticIso } from '../testing/fixtures'
import { type SectorReader, hasUdf, readDirectory, readPrimaryVolume } from './iso9660'
import { PCSX2_CD_MAX_SECTORS, detectDiscMedia } from './media'

const reader =
  (image: Buffer): SectorReader =>
  (lba, count) =>
    Promise.resolve(image.subarray(lba * 2048, (lba + count) * 2048))

const detect = (image: Buffer, bytes = image.length): ReturnType<typeof detectDiscMedia> => detectDiscMedia(reader(image), bytes)

const text = (value: string): Buffer => Buffer.from(value, 'latin1')

describe('ISO 9660', () => {
  it('reads the volume descriptor and directories', async () => {
    const config = text('BOOT2 = cdrom0:\\SLUS_000.00;1')
    const image = syntheticIso({ systemId: 'PLAYSTATION', entries: [{ name: 'SYSTEM.CNF', data: config }, { name: 'DATA', entries: [] }] })
    const volume = await readPrimaryVolume(reader(image))
    expect(volume).toMatchObject({ systemId: 'PLAYSTATION', root: { lba: 24, bytes: 2048 } })
    expect(await readDirectory(reader(image), volume?.root ?? { lba: 0, bytes: 0 })).toEqual([
      { name: 'SYSTEM.CNF', directory: false, extent: { lba: 25, bytes: config.length } },
      { name: 'DATA', directory: true, extent: { lba: 26, bytes: 2048 } }
    ])
    expect(await readPrimaryVolume(reader(Buffer.alloc(40 * 2048)))).toBeNull()
  })

  it('reads directories over several sectors, losing only the sector of a damaged record', async () => {
    const name = (value: string): Buffer => Buffer.from(value, 'latin1')
    const first = Buffer.concat([directoryRecord(Buffer.from([0]), 30, 3 * 2048, true), directoryRecord(name('A.BIN;1'), 40, 10, false)], 2048)
    const damaged = Buffer.concat([directoryRecord(name('B.BIN;1'), 41, 10, false), Buffer.from([10]), directoryRecord(name('LOST.BIN;1'), 42, 10, false)], 2048)
    const last = Buffer.concat([directoryRecord(name('SYSTEM.CNF;1'), 43, 10, false)], 2048)
    const image = Buffer.concat([Buffer.alloc(30 * 2048), first, damaged, last])
    const entries = await readDirectory(reader(image), { lba: 30, bytes: 3 * 2048 })
    expect(entries.map((entry) => entry.name)).toEqual(['A.BIN', 'B.BIN', 'SYSTEM.CNF'])
  })

  it('finds a UDF file system after the ISO 9660 descriptors, or on its own', async () => {
    expect(await hasUdf(reader(syntheticIso({ udf: true })))).toBe(true)
    expect(await hasUdf(reader(syntheticIso()))).toBe(false)
    const udfOnly = Buffer.alloc(40 * 2048)
    for (const [lba, id] of [[16, 'BEA01'], [17, 'NSR03'], [18, 'TEA01']] as [number, string][]) udfOnly.write(id, lba * 2048 + 1, 'latin1')
    expect(await hasUdf(reader(udfOnly))).toBe(true)
    expect(await detect(udfOnly)).toMatchObject({ media: 'dvd' })
  })
})

describe('detectDiscMedia', () => {
  it('takes PSP UMDs for DVDs, by system identifier or by their PSP_GAME folder', async () => {
    expect(await detect(syntheticIso({ systemId: 'PSP GAME' }))).toEqual({ media: 'dvd', reason: 'This is a PSP UMD image' })
    expect(await detect(syntheticIso({ systemId: 'UMD VIDEO' }))).toMatchObject({ media: 'dvd' })
    expect(await detect(syntheticIso({ systemId: '"PSP GAME"' }))).toMatchObject({ media: 'dvd' })
    expect(await detect(syntheticIso({ systemId: 'GAME', entries: [{ name: 'PSP_GAME', entries: [] }] }))).toMatchObject({ media: 'dvd' })
  })

  it('takes PlayStation 2 discs with the UDF bridge of its DVDs for DVDs, and counts PCSX2 signs of a DVD', async () => {
    const ps2 = { systemId: 'PLAYSTATION', entries: [{ name: 'SYSTEM.CNF', data: text('BOOT2 = cdrom0:\\SLUS_203.12;1\r\nVER = 1.00\r\n') }] }
    expect(await detect(syntheticIso(ps2))).toEqual({ media: 'cd', reason: 'This is a PlayStation 2 CD' })
    expect(await detect(syntheticIso({ ...ps2, udf: true }))).toEqual({ media: 'dvd', reason: 'This is a PlayStation 2 DVD' })
    // PCSX2 takes differing 16-bit words at offsets 166 and 171 of the volume descriptor for a DVD.
    expect(await detect(syntheticIso({ ...ps2, bigEndianRootLength: 0 }))).toEqual({ media: 'dvd', reason: 'This is a PlayStation 2 DVD' })
    const image = syntheticIso(ps2)
    expect(await detect(image, (PCSX2_CD_MAX_SECTORS + 1) * 2048)).toEqual({ media: 'dvd', reason: 'This is a PlayStation 2 DVD' })
    expect(await detect(image, PCSX2_CD_MAX_SECTORS * 2048)).toMatchObject({ media: 'cd' })
  })

  it('takes GameCube, Wii and Xbox images for DVDs by their marks', async () => {
    const header = (offset: number, magic: number): Buffer => {
      const image = Buffer.alloc(40 * 2048)
      image.writeUInt32BE(magic, offset)
      return image
    }
    expect(await detect(header(0x1c, 0xc2339f3d))).toEqual({ media: 'dvd', reason: 'This is a GameCube disc' })
    expect(await detect(header(0x18, 0x5d1c9ea3))).toEqual({ media: 'dvd', reason: 'This is a Wii disc' })
    const xiso = Buffer.alloc(40 * 2048)
    xiso.write('MICROSOFT*XBOX*MEDIA', 32 * 2048, 'latin1')
    expect(await detect(xiso)).toEqual({ media: 'dvd', reason: 'This is an Xbox disc' })
  })

  it('takes PlayStation discs for CDs and DVD-Video discs for DVDs', async () => {
    expect(await detect(syntheticIso({ systemId: 'PLAYSTATION', entries: [{ name: 'SYSTEM.CNF', data: text('BOOT = cdrom:\\SCUS_944.55;1') }] }))).toEqual({
      media: 'cd',
      reason: 'This is a PlayStation disc'
    })
    expect(await detect(syntheticIso({ entries: [{ name: 'PSX.EXE', data: Buffer.alloc(16) }] }))).toMatchObject({ media: 'cd' })
    const video = syntheticIso({ entries: [{ name: 'VIDEO_TS', entries: [{ name: 'VIDEO_TS.IFO', data: Buffer.alloc(64) }] }] })
    expect(await detect(video)).toEqual({ media: 'dvd', reason: 'This is a DVD-Video disc' })
  })

  it('needs the files that identify a platform, not just their names', async () => {
    expect(await detect(syntheticIso({ entries: [{ name: 'SYSTEM.CNF', data: text('VER = 1.00') }] }))).toMatchObject({ media: 'cd' })
    expect(await detect(syntheticIso({ entries: [{ name: 'VIDEO_TS', entries: [{ name: 'AUDIO.BIN', data: Buffer.alloc(8) }] }] }))).toEqual({
      media: 'cd',
      reason: 'The image fits on a CD and shows no sign of being a DVD'
    })
  })

  it('goes by size and file systems for other images', async () => {
    expect(await detect(syntheticIso(), (PCSX2_CD_MAX_SECTORS + 1) * 2048)).toEqual({ media: 'dvd', reason: 'The image is larger than a CD can hold' })
    expect(await detect(Buffer.alloc(64 * 2048), (PCSX2_CD_MAX_SECTORS + 1) * 2048)).toMatchObject({ media: 'dvd' })
    expect(await detect(syntheticIso({ udf: true }))).toEqual({ media: 'dvd', reason: 'The image has a UDF file system, as DVDs do' })
    expect(await detect(syntheticIso())).toEqual({ media: 'cd', reason: 'The image fits on a CD and shows no sign of being a DVD' })
    expect(await detect(Buffer.alloc(64 * 2048))).toMatchObject({ media: 'cd' })
  })

  it('cannot store an image whose size is not a multiple of 2048 bytes as a DVD', async () => {
    expect(await detect(Buffer.alloc(3000))).toEqual({ media: 'cd', reason: "The image's size is not a multiple of 2,048 bytes" })
  })
})
