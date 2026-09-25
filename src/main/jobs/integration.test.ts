import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_JOB_SETTINGS } from '@shared/formats'
import type { AppSettings, JobEvent, JobSettings, RunJobRequest, Target, ToolsStatus } from '@shared/types'
import { buildCdiDescriptor } from '../formats/cdi'
import { defaultSettings } from '../settings'
import { JobRunner } from './runner'

/*
 * End-to-end runs against real chdman and maxcso binaries. Run them with
 * `npm run test:integration` (or DCP_INTEGRATION=1); the tools are taken from
 * DCP_CHDMAN / DCP_MAXCSO or PATH.
 */

function onPath(name: string): string | null {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, name + suffix)
    if (dir && existsSync(candidate)) return candidate
  }
  return null
}

const chdman = process.env.DCP_CHDMAN ?? onPath('chdman')
const maxcso = process.env.DCP_MAXCSO ?? onPath('maxcso')
const requested = process.env.DCP_INTEGRATION === '1' || process.env.npm_lifecycle_event === 'test:integration'
const enabled = requested && !!chdman && !!maxcso

/** Wine does not count process I/O, so maxcso's progress can only be measured on Linux and real Windows. */
function measuresProgress(): boolean {
  if (process.platform === 'linux') return true
  if (process.platform !== 'win32') return false
  try {
    execFileSync('reg', ['query', 'HKLM\\Software\\Wine'], { stdio: 'ignore' })
    return false
  } catch {
    return true
  }
}

const SYNC = Buffer.from([0x00, ...Array<number>(10).fill(0xff), 0x00])
const bcd = (value: number): number => ((Math.floor(value / 10) << 4) | value % 10) & 0xff

/** A raw 2352-byte sector around 2048 bytes of user data (EDC/ECC left zeroed). */
function rawSector(mode: 1 | 2, data: Buffer, lba: number): Buffer {
  const address = lba + 150
  const header = Buffer.from([bcd(Math.floor(address / 4500)), bcd(Math.floor(address / 75) % 60), bcd(address % 75), mode])
  if (mode === 1) return Buffer.concat([SYNC, header, data, Buffer.alloc(288)])
  const subheader = Buffer.from([0, 0, 0x08, 0, 0, 0, 0x08, 0])
  return Buffer.concat([SYNC, header, subheader, data, Buffer.alloc(280)])
}

function sectorsOf(iso: Buffer): Buffer[] {
  return Array.from({ length: iso.length / 2048 }, (_, i) => iso.subarray(i * 2048, (i + 1) * 2048))
}

let root: string
let inputs: string
let outputs: string
let iso: Buffer
const tools = (): ToolsStatus => ({
  chdman: { name: 'chdman', path: chdman, source: 'system', version: 'test', error: null },
  maxcso: { name: 'maxcso', path: maxcso, source: 'system', version: 'test', error: null }
})

function run(
  inputPath: string,
  target: Target,
  settings: Partial<JobSettings> = {},
  overrides: Partial<AppSettings> = {},
  onEvent?: (event: JobEvent, runner: JobRunner) => void
): Promise<{ final: JobEvent; events: JobEvent[] }> {
  const events: JobEvent[] = []
  return new Promise((resolve) => {
    const runner = new JobRunner({
      settings: () => ({ ...defaultSettings(), outputDirectory: outputs, overwrite: 'rename', ...overrides }),
      tools: () => Promise.resolve(tools()),
      emit: (event) => {
        events.push(event)
        onEvent?.(event, runner)
        if (event.type === 'done' || event.type === 'failed' || event.type === 'cancelled') resolve({ final: event, events })
      },
      trash: () => Promise.resolve()
    })
    const request: RunJobRequest = { id: `job-${Math.random().toString(36).slice(2)}`, inputPath, target, settings: { ...DEFAULT_JOB_SETTINGS, ...settings } }
    runner.start(request)
  })
}

async function expectDone(promise: ReturnType<typeof run>): Promise<string[]> {
  const { final, events } = await promise
  if (final.type !== 'done') {
    const logs = events.flatMap((e) => (e.type === 'log' ? [`${e.level}: ${e.message}`] : []))
    throw new Error(`Job did not finish: ${JSON.stringify(final)}\n${logs.join('\n')}`)
  }
  return final.outputs
}

describe.runIf(requested && !enabled)('integration test setup', () => {
  it('finds chdman and maxcso', () => {
    throw new Error(`Integration tests need chdman (${chdman ?? 'not found'}) and maxcso (${maxcso ?? 'not found'}); set DCP_CHDMAN and DCP_MAXCSO or add them to PATH.`)
  })
})

describe.skipIf(!enabled)('real chdman and maxcso', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dcp-integration-'))
    inputs = join(root, 'in')
    outputs = join(root, 'out')
    await mkdir(inputs)
    // 12 MiB: compressible text followed by incompressible noise.
    const text = Buffer.alloc(8 * 1024 * 1024, 'DiscCompressor Pro integration test data. ')
    const noise = Buffer.alloc(4 * 1024 * 1024)
    for (let i = 0; i < noise.length; i += 4) noise.writeUInt32LE((Math.imul(i, 2654435761) ^ (i >>> 7)) >>> 0, i)
    iso = Buffer.concat([text, noise])
    await writeFile(join(inputs, 'Game.iso'), iso)

    const sectors = sectorsOf(iso)
    await writeFile(join(inputs, 'Mode1.bin'), Buffer.concat(sectors.map((s, i) => rawSector(1, s, i))))
    await writeFile(join(inputs, 'Mode1.cue'), 'FILE "Mode1.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n')
    await writeFile(join(inputs, 'Mode2.bin'), Buffer.concat(sectors.map((s, i) => rawSector(2, s, i))))
    await writeFile(join(inputs, 'Mode2.cue'), 'FILE "Mode2.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n')
    for (const n of [1, 2]) {
      await writeFile(join(inputs, `Saga (Disc ${n}).bin`), iso.subarray(0, 2048 * 512))
      await writeFile(join(inputs, `Saga (Disc ${n}).cue`), `FILE "Saga (Disc ${n}).bin" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n`)
    }
    await writeFile(join(inputs, 'track01.bin'), Buffer.concat(sectors.slice(0, 300).map((s, i) => rawSector(1, s, i))))
    await writeFile(join(inputs, 'track02.raw'), noise.subarray(0, 2352 * 150))
    await writeFile(join(inputs, 'track03.bin'), Buffer.concat(sectors.slice(0, 600).map((s, i) => rawSector(1, s, 45000 + i))))
    await writeFile(join(inputs, 'Dream.gdi'), '3\n1 0 4 2352 track01.bin 0\n2 450 0 2352 track02.raw 0\n3 45000 4 2352 track03.bin 0\n')

    // A self-booting Dreamcast CD-R as DiscJuggler images hold it: 302 frames of audio in the first session,
    // then a Mode 2 data track in the second, which starts with the boot sector.
    const data = Buffer.concat(
      sectorsOf(iso.subarray(0, 2048 * 400)).map((user, i) => Buffer.concat([Buffer.from([0, 0, 0x08, 0, 0, 0, 0x08, 0]), user, Buffer.alloc(280, i & 0xff)]))
    )
    data.write('SEGA SEGAKATANA SEGA ENTERPRISES', 8, 'latin1')
    data.set(Buffer.from([1, ...Buffer.from('CD001', 'latin1')]), 16 * 2336 + 8)
    data.write('SELFBOOT'.padEnd(32, ' '), 16 * 2336 + 8 + 40, 'latin1')
    await writeFile(
      join(inputs, 'Selfboot.cdi'),
      Buffer.concat([
        Buffer.alloc(150 * 2352),
        noise.subarray(0, 302 * 2352),
        Buffer.alloc(150 * 2336),
        data,
        buildCdiDescriptor(
          [
            { session: 1, mode: 0, sectorSize: 2352, subchannelSize: 0, pregap: 150, length: 302, start: 0, control: 0 },
            { session: 2, mode: 2, sectorSize: 2336, subchannelSize: 0, pregap: 150, length: 400, start: 11702, control: 4 }
          ],
          { imageName: 'Selfboot.cdi', volumeId: 'SELFBOOT'.padEnd(32, ' ') }
        )
      ])
    )
  }, 60_000)

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('round-trips an ISO through a DVD CHD bit for bit', async () => {
    const [chd] = await expectDone(run(join(inputs, 'Game.iso'), 'CHD'))
    expect(execFileSync(chdman as string, ['verify', '-i', chd as string], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toMatch(/verification successful/i)
    const [back] = await expectDone(run(chd as string, 'Extract'))
    expect((await readFile(back as string)).equals(iso)).toBe(true)
  }, 120_000)

  it('round-trips an ISO through CSO, CSO v2 and ZSO, reporting measured progress', async () => {
    for (const [target, settings] of [
      ['CSO', {}],
      ['CSOv2', { csoMode: 'max' }],
      ['ZSO', { csoBlockSize: 0 }]
    ] as [Target, Partial<JobSettings>][]) {
      const { final, events } = await run(join(inputs, 'Game.iso'), target, settings)
      expect(final.type).toBe('done')
      // Only the slow Zopfli run lasts long enough for the 500 ms progress sampling.
      if (settings.csoMode === 'max' && measuresProgress()) {
        const measured = events.flatMap((e) => (e.type === 'progress' && e.progress !== null && e.progress < 1 ? [e.progress] : []))
        expect(Math.max(...measured)).toBeGreaterThan(0.2)
      }
      const [back] = await expectDone(run((final as Extract<JobEvent, { type: 'done' }>).outputs[0] as string, 'Extract'))
      expect((await readFile(back as string)).equals(iso)).toBe(true)
    }
  }, 300_000)

  it('turns raw Mode 1 and Mode 2 Form 1 cue sheets into the original ISO data', async () => {
    for (const cue of ['Mode1.cue', 'Mode2.cue']) {
      const [cso] = await expectDone(run(join(inputs, cue), 'CSO'))
      const [back] = await expectDone(run(cso as string, 'Extract'))
      expect((await readFile(back as string)).equals(iso)).toBe(true)
    }
  }, 180_000)

  it('extracts a raw CD CHD back to the original ISO data and converts it to CSO', async () => {
    const [chd] = await expectDone(run(join(inputs, 'Mode1.cue'), 'CHD'))
    const [asIso] = await expectDone(run(chd as string, 'Extract', { extractCd: 'iso' }))
    expect((await readFile(asIso as string)).equals(iso)).toBe(true)
    const [cso] = await expectDone(run(chd as string, 'CSO'))
    const [back] = await expectDone(run(cso as string, 'Extract'))
    expect((await readFile(back as string)).equals(iso)).toBe(true)
  }, 240_000)

  it('recompresses CHDs, prints info and converts CSO to CHD', async () => {
    const [chd] = await expectDone(run(join(inputs, 'Game.iso'), 'CHD', { chdCodecsDvd: ['zlib'] }))
    const [recompressed] = await expectDone(run(chd as string, 'CHD', { chdCodecsDvd: ['zstd', 'lzma'] }))
    const info = execFileSync(chdman as string, ['info', '-i', recompressed as string], { encoding: 'utf8' })
    expect(info).toMatch(/zstd/)
    expect(info).toMatch(/lzma/)

    const { events } = await run(recompressed as string, 'Info')
    expect(events.some((e) => e.type === 'log' && e.level === 'output' && /Logical size/.test(e.message))).toBe(true)

    const [cso] = await expectDone(run(join(inputs, 'Game.iso'), 'CSO'))
    const [fromCso] = await expectDone(run(cso as string, 'CHD'))
    const [back] = await expectDone(run(fromCso as string, 'Extract'))
    expect((await readFile(back as string)).equals(iso)).toBe(true)
  }, 300_000)

  it('fails Verify for a CHD whose checksum does not match, although chdman exits with 0', async () => {
    const [chd] = await expectDone(run(join(inputs, 'Mode2.cue'), 'CHD'))
    expect(await expectDone(run(chd as string, 'Verify'))).toEqual([])
    const data = await readFile(chd as string)
    // The raw data SHA-1 starts at byte 64 of a v5 header.
    data.writeUInt8(data.readUInt8(64) ^ 0xff, 64)
    const broken = join(inputs, 'Broken.chd')
    await writeFile(broken, data)
    const { final } = await run(broken, 'Verify')
    expect(final).toMatchObject({ type: 'failed', error: expect.stringMatching(/^The CHD failed verification: Raw SHA1 in header = [0-9a-f]{40}$/) as unknown })
  }, 120_000)

  it('writes a playlist for multi-disc sets', async () => {
    await expectDone(run(join(inputs, 'Saga (Disc 1).cue'), 'CHD', {}, { autoGenerateM3U: true }))
    await expectDone(run(join(inputs, 'Saga (Disc 2).cue'), 'CHD', {}, { autoGenerateM3U: true }))
    expect(await readFile(join(outputs, 'Saga.m3u'), 'utf8')).toBe('Saga (Disc 1).chd\nSaga (Disc 2).chd\n')
  }, 120_000)

  it('stores GDI images as GD-ROM CHDs and extracts them again', async () => {
    const [chd] = await expectDone(run(join(inputs, 'Dream.gdi'), 'CHD'))
    expect(execFileSync(chdman as string, ['info', '-i', chd as string], { encoding: 'utf8' })).toMatch(/CHGD/)
    const files = await expectDone(run(chd as string, 'Extract'))
    expect(files[0]).toMatch(/Dream\.gdi$/)
    expect(files.length).toBe(4)
  }, 120_000)

  it('converts a Dreamcast CD-R between CDI, CHD and BIN/CUE, keeping its data track where Flycast reads it', async () => {
    const cdi = join(inputs, 'Selfboot.cdi')
    const sha1 = (chd: string): string => /^SHA1:\s+([0-9a-f]{40})$/m.exec(execFileSync(chdman as string, ['info', '-i', chd], { encoding: 'utf8' }))?.[1] ?? ''
    const [chd] = await expectDone(run(cdi, 'CHD', {}, { outputDirectory: join(root, 'selfboot-chd') }))
    expect(execFileSync(chdman as string, ['verify', '-i', chd as string], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toMatch(/verification successful/i)

    // The pregap of the data track is stored in the CHD, as a cue sheet's INDEX 00 has it.
    const metadata = [...execFileSync(chdman as string, ['info', '-v', '-i', chd as string], { encoding: 'utf8' }).matchAll(/TRACK:\d+ TYPE:(\S+) SUBTYPE:\S+ FRAMES:(\d+) PREGAP:(\d+) PGTYPE:(\S+)/g)]
    const tracks = metadata.map(([, type, frames, pregap, pgtype]) => ({ type: type as string, frames: Number(frames), pregap: Number(pregap), stored: (pgtype as string).startsWith('V') }))
    expect(tracks).toEqual([
      { type: 'AUDIO', frames: 302, pregap: 0, stored: false },
      { type: 'MODE2', frames: 550, pregap: 150, stored: true }
    ])
    // Flycast (core/imgread/chd.cpp) puts INDEX 01 after the pregap, and moves the last track of a disc
    // that ends with a data track back by the gap between the sessions of a CD-R, less the pregap it has.
    let frame = 150
    const starts = tracks.map((track) => {
      const start = frame + track.pregap
      frame = start + track.frames - (track.stored ? track.pregap : 0)
      return start
    })
    starts[1] = (starts[1] as number) + 11400 - Math.min(tracks[1]?.pregap ?? 0, 150)
    expect(starts).toEqual([150, 11702 + 150])

    const [back] = await expectDone(run(chd as string, 'Extract', { extractCd: 'cdi' }, { outputDirectory: join(root, 'selfboot-cdi') }))
    expect((await readFile(back as string)).equals(await readFile(cdi))).toBe(true)

    const sheets = []
    for (const [source, dir] of [
      [cdi, 'selfboot-cue'],
      [chd as string, 'selfboot-cue-from-chd']
    ]) {
      const files = await expectDone(run(source as string, 'Extract', {}, { outputDirectory: join(root, dir as string) }))
      expect(files.map((file) => file.slice(join(root, dir as string).length + 1))).toEqual(['Selfboot.cue', 'Selfboot (Track 1).bin', 'Selfboot (Track 2).bin'])
      sheets.push(await Promise.all(files.map((file) => readFile(file))))
    }
    const [fromCdi, fromChd] = sheets as [Buffer[], Buffer[]]
    expect(fromCdi[0]?.toString('utf8')).toMatch(/^REM SESSION 01\r\n.*\r\nREM SESSION 02\r\n/s)
    fromCdi.forEach((file, i) => expect(file.equals(fromChd[i] as Buffer)).toBe(true))

    const [fromSheet] = await expectDone(run(join(root, 'selfboot-cue', 'Selfboot.cue'), 'CHD', {}, { outputDirectory: join(root, 'selfboot-cue-chd') }))
    expect(sha1(fromSheet as string)).toBe(sha1(chd as string))
  }, 180_000)

  it('extracts other discs that end with a data track as chdman does', async () => {
    const dir = join(root, 'extra')
    await mkdir(dir)
    await writeFile(join(dir, 'Extra (Track 1).bin'), iso.subarray(iso.length - 300 * 2352))
    await writeFile(join(dir, 'Extra (Track 2).bin'), Buffer.concat([Buffer.alloc(150 * 2352), ...sectorsOf(iso.subarray(0, 2048 * 300)).map((s, i) => rawSector(1, s, 450 + i))]))
    await writeFile(
      join(dir, 'Extra.cue'),
      'FILE "Extra (Track 1).bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\nFILE "Extra (Track 2).bin" BINARY\n  TRACK 02 MODE1/2352\n    INDEX 00 00:00:00\n    INDEX 01 00:02:00\n'
    )
    const [chd] = await expectDone(run(join(dir, 'Extra.cue'), 'CHD', {}, { outputDirectory: join(root, 'extra-chd') }))
    const files = await expectDone(run(chd as string, 'Extract', {}, { outputDirectory: join(root, 'extra-cue') }))
    expect(files.map((file) => file.slice(join(root, 'extra-cue').length + 1))).toEqual(['Extra.cue', 'Extra.bin'])
    expect(await readFile(files[0] as string, 'utf8')).not.toMatch(/REM SESSION/)
  }, 120_000)

  it('cancels a running chdman job without leaving files behind', async () => {
    const long = join(inputs, 'Long.iso')
    await writeFile(long, Buffer.concat(Array.from({ length: 8 }, () => iso)))
    const before = await readdir(outputs)
    const { final, events } = await run(long, 'CHD', { chdCodecsDvd: ['lzma'], threads: 1 }, {}, (event, runner) => {
      // Cancel once chdman itself reports progress, so that the tool is really running.
      if (event.type === 'progress' && event.progress !== null && event.progress > 0) runner.cancel(event.jobId)
    })
    expect(final.type).toBe('cancelled')
    expect(events.some((event) => event.type === 'log' && event.message.startsWith('$ chdman createdvd'))).toBe(true)
    expect(await readdir(outputs)).toEqual(before)
  }, 120_000)
})
