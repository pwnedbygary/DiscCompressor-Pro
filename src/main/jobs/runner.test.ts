import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_JOB_SETTINGS } from '@shared/formats'
import type { AppSettings, JobEvent, RunJobRequest, ToolsStatus } from '@shared/types'
import { defaultSettings } from '../settings'
import { syntheticChd, syntheticCso, writeFakeTools } from '../testing/fixtures'
import { JobRunner } from './runner'

// The fake tools are shebang scripts, which Windows cannot execute directly.
const describeUnix = process.platform === 'win32' ? describe.skip : describe

let root: string
let inputDir: string
let outputDir: string
let tools: ToolsStatus

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dcp-runner-'))
  const binDir = join(root, 'bin')
  await mkdir(binDir)
  const fake = await writeFakeTools(binDir)
  tools = {
    chdman: { name: 'chdman', path: fake.chdman, source: 'custom', version: '0.289', error: null },
    maxcso: { name: 'maxcso', path: fake.maxcso, source: 'custom', version: '1.13.0', error: null }
  }
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  inputDir = join(root, `in-${Math.random().toString(36).slice(2)}`)
  outputDir = join(root, `out-${Math.random().toString(36).slice(2)}`)
  await mkdir(inputDir)
})

type Request = Omit<RunJobRequest, 'id' | 'settings'> & Partial<RunJobRequest>

interface Harness {
  events: JobEvent[]
  trashed: string[]
  runner: JobRunner
  /** Start a job and resolve with its final event. */
  run(request: Request): Promise<JobEvent>
}

function harness(overrides: Partial<AppSettings> = {}, onEvent?: (event: JobEvent, runner: JobRunner) => void): Harness {
  const events: JobEvent[] = []
  const trashed: string[] = []
  const waiters = new Map<string, (event: JobEvent) => void>()
  const settings: AppSettings = { ...defaultSettings(), outputDirectory: outputDir, ...overrides }
  const runner: JobRunner = new JobRunner({
    settings: () => settings,
    tools: () => Promise.resolve(tools),
    emit: (event) => {
      events.push(event)
      onEvent?.(event, runner)
      if (event.type === 'done' || event.type === 'failed' || event.type === 'cancelled') waiters.get(event.jobId)?.(event)
    },
    trash: (path) => {
      trashed.push(path)
      return Promise.resolve()
    }
  })
  return {
    events,
    trashed,
    runner,
    run: (request) =>
      new Promise<JobEvent>((resolve) => {
        const id = request.id ?? 'job-1'
        waiters.set(id, resolve)
        runner.start({ id, settings: DEFAULT_JOB_SETTINGS, ...request })
      })
  }
}

const logs = (h: Harness): string[] => h.events.flatMap((e) => (e.type === 'log' ? [e.message] : []))

async function workDirsLeft(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.startsWith('.dcp-'))
  } catch {
    return []
  }
}

const MODE1_TRACK = 'TRACK:1 TYPE:MODE1 SUBTYPE:NONE FRAMES:4 PREGAP:0 PGTYPE:MODE1 PGSUB:RW POSTGAP:0'
const cdChd = (): Buffer => syntheticChd({ codecs: ['cdlz'], hunk: 19584, unit: 2448, logical: 1, metadata: [['CHT2', MODE1_TRACK]] })

describeUnix('JobRunner', () => {
  it('converts an ISO to CHD, reporting progress and leaving no temporary files', async () => {
    const iso = join(inputDir, 'Game.iso')
    await writeFile(iso, Buffer.alloc(2048 * 4))
    const h = harness()
    const final = await h.run({ inputPath: iso, target: 'CHD' })

    expect(final).toMatchObject({ type: 'done', outputs: [join(outputDir, 'Game.chd')], skipped: false })
    expect(await readFile(join(outputDir, 'Game.chd'), 'utf8')).toMatch(/^CHD:createdvd:.*-c lzma,zlib,huff,flac/)
    const progress = h.events.filter((e) => e.type === 'progress').map((e) => e.progress)
    expect(progress).toContain(0.5)
    expect(progress.at(-1)).toBe(1)
    expect(logs(h).some((line) => line.startsWith('$ chdman createdvd -i'))).toBe(true)
    expect(logs(h).some((line) => line.includes('% complete'))).toBe(false)
    expect(await workDirsLeft(outputDir)).toEqual([])
  })

  it('applies the overwrite policy to existing outputs', async () => {
    const iso = join(inputDir, 'Game.iso')
    await writeFile(iso, Buffer.alloc(2048))
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, 'Game.chd'), 'old')

    expect(await harness({ overwrite: 'skip' }).run({ inputPath: iso, target: 'CHD' })).toMatchObject({ type: 'done', skipped: true, outputs: [join(outputDir, 'Game.chd')] })
    expect(await readFile(join(outputDir, 'Game.chd'), 'utf8')).toBe('old')

    expect(await harness({ overwrite: 'rename' }).run({ inputPath: iso, target: 'CHD' })).toMatchObject({ outputs: [join(outputDir, 'Game (1).chd')] })

    await harness({ overwrite: 'overwrite' }).run({ inputPath: iso, target: 'CHD' })
    expect(await readFile(join(outputDir, 'Game.chd'), 'utf8')).toMatch(/^CHD:/)
  })

  it('never overwrites the input, even with the overwrite policy', async () => {
    const cso = join(inputDir, 'Game.cso')
    await writeFile(cso, syntheticCso(2048 * 4))
    const final = await harness({ outputMode: 'source', overwrite: 'overwrite' }).run({ inputPath: cso, target: 'CSOv2' })
    expect(final).toMatchObject({ type: 'done', outputs: [join(inputDir, 'Game (1).cso')] })
    expect((await readFile(cso)).subarray(0, 4).toString()).toBe('CISO')
  })

  it('gives jobs running at the same time different output names', async () => {
    for (const dir of ['a', 'b']) {
      await mkdir(join(inputDir, dir))
      await writeFile(join(inputDir, dir, 'Game.iso'), Buffer.alloc(2048))
    }
    const h = harness({ overwrite: 'overwrite' })
    const finals = await Promise.all(['a', 'b'].map((dir) => h.run({ id: dir, inputPath: join(inputDir, dir, 'Game.iso'), target: 'CHD' })))
    const outputs = finals.flatMap((final) => (final.type === 'done' ? final.outputs : []))
    expect(outputs.sort()).toEqual([join(outputDir, 'Game (1).chd'), join(outputDir, 'Game.chd')])
    expect((await readdir(outputDir)).sort()).toEqual(['Game (1).chd', 'Game.chd'])
  })

  it('skips outputs this image made earlier in the session, even under a numbered name', async () => {
    for (const dir of ['01', '02']) {
      await mkdir(join(inputDir, dir))
      await writeFile(join(inputDir, dir, 'disc.iso'), Buffer.alloc(2048))
    }
    const h = harness({ overwrite: 'skip' })
    const run = (dir: string, id: string): Promise<JobEvent> => h.run({ id, inputPath: join(inputDir, dir, 'disc.iso'), target: 'CHD' })
    expect(await run('01', 'a')).toMatchObject({ skipped: false, outputs: [join(outputDir, 'disc.chd')] })
    expect(await run('02', 'b')).toMatchObject({ skipped: false, outputs: [join(outputDir, 'disc (1).chd')] })
    expect(await run('01', 'c')).toMatchObject({ skipped: true, outputs: [join(outputDir, 'disc.chd')] })
    expect(await run('02', 'd')).toMatchObject({ skipped: true, outputs: [join(outputDir, 'disc (1).chd')] })
    expect((await readdir(outputDir)).sort()).toEqual(['disc (1).chd', 'disc.chd'])
  })

  it('does not replace a file it just made from a different image, but does replace its own', async () => {
    for (const dir of ['a', 'b']) {
      await mkdir(join(inputDir, dir))
      await writeFile(join(inputDir, dir, 'Game.iso'), Buffer.alloc(2048))
    }
    const h = harness({ overwrite: 'overwrite' })
    expect(await h.run({ id: 'a', inputPath: join(inputDir, 'a', 'Game.iso'), target: 'CHD' })).toMatchObject({ outputs: [join(outputDir, 'Game.chd')] })
    expect(await h.run({ id: 'b', inputPath: join(inputDir, 'b', 'Game.iso'), target: 'CHD' })).toMatchObject({ outputs: [join(outputDir, 'Game (1).chd')] })
    expect(await h.run({ id: 'a2', inputPath: join(inputDir, 'a', 'Game.iso'), target: 'CHD' })).toMatchObject({ outputs: [join(outputDir, 'Game.chd')] })
  })

  it('reports tool failures with the tool message and cleans up', async () => {
    const iso = join(inputDir, 'fail.iso')
    await writeFile(iso, Buffer.alloc(2048))
    const final = await harness().run({ inputPath: iso, target: 'CHD' })
    expect(final).toEqual({ type: 'failed', jobId: 'job-1', error: 'chdman exited with code 1: Error: simulated failure' })
    expect(await readdir(outputDir)).toEqual([])
  })

  it('cancels a running tool and removes its partial output', async () => {
    const iso = join(inputDir, 'slow.iso')
    await writeFile(iso, Buffer.alloc(2048))
    const h = harness()
    const final = h.run({ inputPath: iso, target: 'CHD' })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(h.runner.activeCount).toBe(1)
    h.runner.cancel('job-1')
    expect(await final).toEqual({ type: 'cancelled', jobId: 'job-1' })
    expect(h.runner.activeCount).toBe(0)
    expect(await readdir(outputDir)).toEqual([])
  })

  it('stops a tool when the job was cancelled just before the tool started', async () => {
    const iso = join(inputDir, 'slow.iso')
    await writeFile(iso, Buffer.alloc(2048 * 4))
    const h = harness({}, (event, runner) => {
      if (event.type === 'log' && event.message.startsWith('$ maxcso')) runner.cancel(event.jobId as string)
    })
    const started = Date.now()
    expect(await h.run({ inputPath: iso, target: 'ZSO' })).toEqual({ type: 'cancelled', jobId: 'job-1' })
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('refuses new jobs once shutting down', async () => {
    const iso = join(inputDir, 'slow.iso')
    await writeFile(iso, Buffer.alloc(2048))
    const h = harness()
    const final = h.run({ inputPath: iso, target: 'CHD' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await h.runner.shutdown()
    expect(await final).toEqual({ type: 'cancelled', jobId: 'job-1' })
    expect(() => h.runner.start({ id: 'late', inputPath: iso, target: 'CHD', settings: DEFAULT_JOB_SETTINGS })).toThrow('closing')
  })

  it('extracts CD CHDs to a cue sheet and its tracks', async () => {
    const chd = join(inputDir, 'Disc.chd')
    await writeFile(chd, cdChd())
    const final = await harness().run({ inputPath: chd, target: 'Extract' })
    expect(final).toMatchObject({ type: 'done', outputs: [join(outputDir, 'Disc.cue'), join(outputDir, 'Disc.bin')] })
  })

  it('applies the overwrite policy to track files, not just the sheet', async () => {
    const chd = join(inputDir, 'Disc.chd')
    await writeFile(chd, cdChd())
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, 'Disc.bin'), 'someone else')
    const final = await harness({ overwrite: 'skip' }).run({ inputPath: chd, target: 'Extract' })
    expect(final).toMatchObject({ type: 'done', skipped: false, outputs: [join(outputDir, 'Disc (1).cue'), join(outputDir, 'Disc (1).bin')] })
    expect(await readFile(join(outputDir, 'Disc.bin'), 'utf8')).toBe('someone else')
    expect(await readFile(join(outputDir, 'Disc (1).cue'), 'utf8')).toContain('FILE "Disc (1).bin"')
  })

  it('extracts GD-ROM CHDs with chdman track names', async () => {
    const chd = join(inputDir, 'Dream.chd')
    const tracks = ['MODE1', 'AUDIO', 'MODE1'].map((type, i) => `TRACK:${i + 1} TYPE:${type} SUBTYPE:NONE FRAMES:4 PAD:0 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0`)
    await writeFile(chd, syntheticChd({ codecs: ['cdlz'], hunk: 19584, unit: 2448, logical: 1, metadata: tracks.map((text) => ['CHGD', text] as [string, string]) }))
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, 'Dream02.raw'), 'someone else')
    const final = await harness({ overwrite: 'rename' }).run({ inputPath: chd, target: 'Extract' })
    expect(final).toMatchObject({
      type: 'done',
      outputs: ['Dream (1).gdi', 'Dream (1)01.bin', 'Dream (1)02.raw', 'Dream (1)03.bin'].map((name) => join(outputDir, name))
    })
  })

  it('turns a 2048-byte CD CHD into an ISO by renaming the extracted track', async () => {
    const chd = join(inputDir, 'Disc.chd')
    await writeFile(chd, cdChd())
    const final = await harness().run({ inputPath: chd, target: 'Extract', settings: { ...DEFAULT_JOB_SETTINGS, extractCd: 'iso' } })
    expect(final).toMatchObject({ type: 'done', outputs: [join(outputDir, 'Disc.iso')], outputBytes: 2048 * 4 })
  })

  it('fails Verify when chdman reports a checksum mismatch or cannot check the CHD', async () => {
    const good = join(inputDir, 'Good.chd')
    const bad = join(inputDir, 'badsha.chd')
    const raw = join(inputDir, 'uncompressed.chd')
    for (const file of [good, bad, raw]) await writeFile(file, cdChd())
    expect(await harness().run({ inputPath: good, target: 'Verify' })).toMatchObject({ type: 'done' })
    expect(await harness().run({ inputPath: bad, target: 'Verify' })).toMatchObject({
      type: 'failed',
      error: 'The CHD failed verification: Raw SHA1 in header = 0123'
    })
    expect(await harness().run({ inputPath: raw, target: 'Verify' })).toMatchObject({
      type: 'failed',
      error: 'This CHD cannot be verified: CHD is uncompressed'
    })
  })

  it('refuses to verify a CHD without compression, which has no checksums', async () => {
    const chd = join(inputDir, 'Plain.chd')
    await writeFile(chd, syntheticChd({ codecs: [], hunk: 19584, unit: 2448, logical: 1, metadata: [['CHT2', MODE1_TRACK]] }))
    expect(await harness().run({ inputPath: chd, target: 'Verify' })).toMatchObject({ type: 'failed', error: 'Uncompressed CHDs have no checksums to verify' })
  })

  it('moves every input file to the trash after success, but never for Verify', async () => {
    const cue = join(inputDir, 'Game (Disc 1).cue')
    await writeFile(cue, 'FILE "Game (Disc 1).bin" BINARY\n TRACK 01 MODE1/2352\n  INDEX 01 00:00:00\n')
    await writeFile(join(inputDir, 'Game (Disc 1).bin'), Buffer.alloc(2352))
    const h = harness({ deleteOriginals: true, autoGenerateM3U: true })
    await h.run({ inputPath: cue, target: 'CHD' })
    expect(h.trashed).toEqual([cue, join(inputDir, 'Game (Disc 1).bin')])
    expect(await readFile(join(outputDir, 'Game.m3u'), 'utf8')).toBe('Game (Disc 1).chd\n')

    const chd = join(inputDir, 'Verify.chd')
    await writeFile(chd, cdChd())
    const verify = harness({ deleteOriginals: true })
    expect(await verify.run({ inputPath: chd, target: 'Verify' })).toMatchObject({ type: 'done', outputs: [] })
    expect(verify.trashed).toEqual([])
    expect(logs(verify)).toContain('Raw SHA1 verification successful!')
  })

  it('keeps originals that other jobs still need', async () => {
    const iso = join(inputDir, 'waitcso.iso')
    await writeFile(iso, Buffer.alloc(2048 * 4))
    const h = harness({ deleteOriginals: true })
    const zso = h.run({ id: 'zso', inputPath: iso, target: 'ZSO' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await h.run({ id: 'chd', inputPath: iso, target: 'CHD' })).toMatchObject({ type: 'done' })
    expect(h.trashed).toEqual([])
    expect(logs(h)).toContain('Kept waitcso.iso because another job is still using it')
    h.runner.cancel('zso')
    expect(await zso).toMatchObject({ type: 'cancelled' })

    // Jobs that are only queued are known to the renderer, which asks for the originals to be kept.
    const queued = await h.run({ id: 'queued', inputPath: iso, target: 'CHD', keepOriginals: true })
    expect(queued).toMatchObject({ type: 'done' })
    expect(h.trashed).toEqual([])
    expect(logs(h)).toContain('Kept waitcso.iso because other jobs in the queue still need it')
  })

  it('keeps track files outside the folder of the sheet when moving originals to the trash', async () => {
    const games = join(inputDir, 'games')
    await mkdir(games)
    const cue = join(games, 'Game.cue')
    await writeFile(cue, 'FILE "../shared.bin" BINARY\n TRACK 01 MODE1/2352\n  INDEX 01 00:00:00\n')
    await writeFile(join(inputDir, 'shared.bin'), Buffer.alloc(2352))
    const h = harness({ deleteOriginals: true })
    expect(await h.run({ inputPath: cue, target: 'CHD' })).toMatchObject({ type: 'done' })
    expect(h.trashed).toEqual([cue])
    expect(logs(h)).toContain('Kept shared.bin because it is outside the folder of Game.cue')
  })

  it('leaves numbered duplicates out of playlists', async () => {
    const iso = join(inputDir, 'Game (Disc 1).iso')
    await writeFile(iso, Buffer.alloc(2048))
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, 'Game (Disc 1).chd'), 'old')
    const final = await harness({ overwrite: 'rename', autoGenerateM3U: true }).run({ inputPath: iso, target: 'CHD' })
    expect(final).toMatchObject({ outputs: [join(outputDir, 'Game (Disc 1) (1).chd')] })
    expect((await readdir(outputDir)).filter((name) => name.endsWith('.m3u'))).toEqual([])
  })

  it('refuses targets the input does not support', async () => {
    const iso = join(inputDir, 'Game.iso')
    await writeFile(iso, Buffer.alloc(2048))
    expect(await harness().run({ inputPath: iso, target: 'Verify' })).toMatchObject({ type: 'failed', error: 'Verify is only available for CHD files' })
  })
})
