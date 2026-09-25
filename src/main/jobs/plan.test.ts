import { describe, expect, it } from 'vitest'
import { DEFAULT_JOB_SETTINGS } from '@shared/formats'
import type { ChdInfo, JobSettings, ScannedInput, Target, TrackInfo } from '@shared/types'
import { type Arg, type Plan, type Step, planJob } from './plan'

function input(overrides: Partial<ScannedInput>): ScannedInput {
  return {
    path: '/in/Game.iso',
    name: 'Game.iso',
    kind: 'iso',
    size: 2048 * 1000,
    files: ['/in/Game.iso'],
    media: null,
    tracks: [],
    isoLayout: null,
    isoBlocker: null,
    chd: null,
    ciso: null,
    cdi: null,
    detectedMedia: null,
    problem: null,
    ...overrides
  }
}

const chdInfo = (media: ChdInfo['media'], extra: Partial<ChdInfo> = {}): ChdInfo => ({
  version: 5,
  logicalBytes: 2048 * 1000,
  hunkBytes: media === 'dvd' ? 4096 : 19584,
  unitBytes: media === 'dvd' ? 2048 : 2448,
  codecs: [],
  media,
  tracks: [],
  hasParent: false,
  ...extra
})

const cue = (layout: ScannedInput['isoLayout']): ScannedInput =>
  input({ path: '/in/Game.cue', name: 'Game.cue', kind: 'cue', files: ['/in/Game.cue', '/in/Game.bin'], media: 'cd', isoLayout: layout })
const chd = (media: ChdInfo['media'], layout: ScannedInput['isoLayout'] = null): ScannedInput =>
  input({ path: '/in/Game.chd', name: 'Game.chd', kind: 'chd', files: ['/in/Game.chd'], media: media as ScannedInput['media'], chd: chdInfo(media), isoLayout: layout })
const cso = (kind: 'cso' | 'zso' | 'dax' = 'cso'): ScannedInput =>
  input({ path: `/in/Game.${kind}`, name: `Game.${kind}`, kind, files: [`/in/Game.${kind}`], ciso: { format: 'cso1', uncompressedBytes: 2048 * 1000, blockSize: 2048 } })
const track = (type: string, i: number): TrackInfo => ({ number: i + 1, type, sectorSize: 2352 })
const cdi = (types = ['AUDIO', 'MODE2/2336']): ScannedInput =>
  input({
    path: '/in/Game.cdi',
    name: 'Game.cdi',
    kind: 'cdi',
    files: ['/in/Game.cdi'],
    media: 'cd',
    tracks: types.map((type, i) => ({ ...track(type, i), session: i + 1 })),
    isoBlocker: 'DiscJuggler images can only become a CHD or BIN/CUE',
    cdi: { version: '3.5', sessions: types.length, tracks: [] }
  })

function plan(source: ScannedInput, target: Target, settings: Partial<JobSettings> = {}): Plan {
  const result = planJob(source, target, { ...DEFAULT_JOB_SETTINGS, ...settings }, { baseName: 'Game' })
  if (!result.ok) throw new Error(result.error)
  return result.plan
}

/** Render a step's arguments with symbolic paths spelled out, for readable assertions. */
function args(step: Step | undefined): string[] {
  if (step?.kind !== 'tool') throw new Error('not a tool step')
  return step.args.map((arg: Arg) =>
    typeof arg === 'string' ? arg : arg.ref === 'input' ? '<input>' : arg.ref === 'work' ? `<work>/${arg.name}` : arg.path
  )
}

describe('CHD targets', () => {
  it('creates a CD CHD from a cue sheet with the chosen codecs, hunk size and threads', () => {
    const result = plan(cue(null), 'CHD', { chdCodecsCd: ['cdzs', 'cdfl'], chdHunkCd: 9792, threads: 6 })
    expect(args(result.steps[0])).toEqual(['createcd', '-i', '<input>', '-o', '<work>/Game.chd', '-f', '-c', 'cdzs,cdfl', '-hs', '9792', '-np', '6'])
    expect(result.finalize).toEqual({ kind: 'file', from: { ref: 'work', name: 'Game.chd' }, name: 'Game.chd' })
  })

  it('makes a CD or DVD CHD of an ISO as detected, unless a media type is chosen', () => {
    const detected = (media: 'cd' | 'dvd'): ScannedInput => input({ detectedMedia: { media, reason: 'Detected' } })
    expect(args(plan(detected('cd'), 'CHD').steps[0])).toEqual(['createcd', '-i', '<input>', '-o', '<work>/Game.chd', '-f', '-c', 'cdlz,cdzl,cdfl'])
    expect(args(plan(detected('dvd'), 'CHD').steps[0])[0]).toBe('createdvd')
    expect(args(plan(detected('cd'), 'CHD', { chdMediaChoice: 'dvd' }).steps[0])[0]).toBe('createdvd')
    // An ISO that is not whole 2048-byte sectors can only become a CD CHD.
    const odd = input({ size: 3000, detectedMedia: { media: 'cd', reason: 'Detected' } })
    expect(args(plan(odd, 'CHD').steps[0])[0]).toBe('createcd')
  })

  it('uses createdvd or createcd for ISOs depending on the chosen media', () => {
    expect(args(plan(input({}), 'CHD', { chdMediaChoice: 'dvd' }).steps[0])).toEqual(['createdvd', '-i', '<input>', '-o', '<work>/Game.chd', '-f', '-c', 'lzma,zlib,huff,flac'])
    expect(args(plan(input({}), 'CHD', { chdMediaChoice: 'cd' }).steps[0])[0]).toBe('createcd')
  })

  it('makes a DVD CHD of an image that could not be examined, as before detection existed', () => {
    expect(args(plan(input({ detectedMedia: null }), 'CHD').steps[0])[0]).toBe('createdvd')
  })

  it('refuses a DVD CHD from an ISO that is not 2048-byte aligned', () => {
    const result = planJob(input({ size: 2352 * 10 }), 'CHD', { ...DEFAULT_JOB_SETTINGS, chdMediaChoice: 'dvd' }, { baseName: 'Game' })
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/only be stored as a CD CHD/) as unknown })
  })

  it('always treats GDI as a CD-style CHD', () => {
    const gdi = input({ path: '/in/Game.gdi', name: 'Game.gdi', kind: 'gdi', media: 'gdrom' })
    expect(args(plan(gdi, 'CHD', { chdMediaChoice: 'dvd' }).steps[0]).slice(0, 1)).toEqual(['createcd'])
  })

  it('decompresses CSO first, using the configured maxcso path for it', () => {
    const result = plan(cso(), 'CHD')
    expect(args(result.steps[0])).toEqual(['--decompress', '-o', '<work>/image.iso', '<input>'])
    expect(args(result.steps[1]).slice(0, 5)).toEqual(['createdvd', '-i', '<work>/image.iso', '-o', '<work>/Game.chd'])
    expect(result.steps[0]).toMatchObject({ progress: { kind: 'output', totalBytes: 2048 * 1000 } })
  })

  it('recompresses CHDs with chdman copy and validates the hunk size', () => {
    expect(args(plan(chd('cd'), 'CHD').steps[0]).slice(0, 7)).toEqual(['copy', '-i', '<input>', '-o', '<work>/Game.chd', '-f', '-c'])
    expect(planJob(chd('cd'), 'CHD', { ...DEFAULT_JOB_SETTINGS, chdHunkCd: 2448 * 3 }, { baseName: 'Game' }).ok).toBe(false)
    expect(planJob(chd('cd'), 'CHD', { ...DEFAULT_JOB_SETTINGS, chdHunkCd: 2448 * 16 }, { baseName: 'Game' }).ok).toBe(true)
  })
})

describe('CSO targets', () => {
  it('compresses ISOs directly with explicit format and block size', () => {
    const result = plan(input({}), 'ZSO', { csoMode: 'max', threads: 4 })
    expect(args(result.steps[0])).toEqual(['--format=zso', '--block=2048', '--threads=4', '--use-lz4brute', '-o', '<work>/Game.zso', '<input>'])
    expect(result.steps[0]).toMatchObject({ progress: { kind: 'read', of: { ref: 'input' } } })
    expect(result.finalize).toMatchObject({ name: 'Game.zso' })
  })

  it('lets maxcso recompress CSO/ZSO/DAX input without a temporary ISO', () => {
    expect(plan(cso('dax'), 'CSOv2', { csoBlockSize: 0 }).steps.map(args)).toEqual([
      ['--format=cso2', '-o', '<work>/Game.cso', '<input>']
    ])
  })

  it('extracts DVD CHDs with extractdvd first', () => {
    const steps = plan(chd('dvd'), 'CSO').steps
    expect(args(steps[0])).toEqual(['extractdvd', '-i', '<input>', '-o', '<work>/image.iso', '-f'])
    expect(args(steps[1]).slice(-3)).toEqual(['-o', '<work>/Game.cso', '<work>/image.iso'])
  })

  it('converts single-track CD CHDs through extractcd and the ISO converter', () => {
    const steps = plan(chd('cd', { sectorSize: 2352, mode: 2 }), 'CSO').steps
    expect(args(steps[0])).toEqual(['extractcd', '-i', '<input>', '-o', '<work>/image.cue', '-ob', '<work>/image.bin', '-f'])
    expect(steps[1]).toMatchObject({ kind: 'iso', source: { ref: 'work', name: 'image.bin' }, output: { ref: 'work', name: 'image.iso' } })
    expect(args(steps[2]).slice(-1)).toEqual(['<work>/image.iso'])
  })

  it('feeds 2048-byte tracks to maxcso as they are', () => {
    const steps = plan(cue({ sectorSize: 2048, mode: 1 }), 'CSO').steps
    expect(steps).toHaveLength(1)
    expect(args(steps[0]).slice(-1)).toEqual(['/in/Game.bin'])
  })

  it('refuses multi-track discs with the scanner reason', () => {
    const multi = input({ ...cue(null), isoBlocker: 'The disc has 2 tracks' })
    expect(planJob(multi, 'CSO', DEFAULT_JOB_SETTINGS, { baseName: 'Game' })).toEqual({ ok: false, error: 'The disc has 2 tracks' })
  })
})

describe('Extract', () => {
  it('uses extractdvd only for DVD CHDs', () => {
    const result = plan(chd('dvd'), 'Extract')
    expect(args(result.steps[0])).toEqual(['extractdvd', '-i', '<input>', '-o', '<work>/Game.iso', '-f'])
    expect(result.finalize).toMatchObject({ kind: 'file', name: 'Game.iso' })
  })

  it('extracts CD CHDs to a cue sheet by default', () => {
    const result = plan(chd('cd'), 'Extract')
    expect(args(result.steps[0])).toEqual(['extractcd', '-i', '<input>', '-o', '<work>/Game.cue', '-f'])
    expect(result.finalize).toEqual({ kind: 'sheet', sheet: 'Game.cue' })
  })

  it('converts CD CHDs to ISO when the layout allows it, and to a cue sheet otherwise', () => {
    const ok = plan(chd('cd', { sectorSize: 2048, mode: 1 }), 'Extract', { extractCd: 'iso' })
    expect(ok.steps).toHaveLength(1)
    expect(ok.finalize).toEqual({ kind: 'file', from: { ref: 'work', name: 'image.bin' }, name: 'Game.iso' })
    const mixed = plan({ ...chd('cd'), isoBlocker: 'The disc has audio tracks' }, 'Extract', { extractCd: 'iso' })
    expect(args(mixed.steps[0])).toEqual(['extractcd', '-i', '<input>', '-o', '<work>/Game.cue', '-f'])
    expect(mixed.finalize).toEqual({ kind: 'sheet', sheet: 'Game.cue' })
  })

  it('extracts GD-ROM CHDs to GDI or Redump-style cue sheets', () => {
    expect(plan(chd('gdrom'), 'Extract').finalize).toEqual({ kind: 'sheet', sheet: 'Game.gdi' })
    expect(plan(chd('gdrom'), 'Extract', { extractGd: 'cue' }).finalize).toEqual({ kind: 'sheet', sheet: 'Game.cue' })
  })

  it('predicts every file extractcd writes, using chdman track names', () => {
    const gd = { ...chd('gdrom'), tracks: ['MODE1', 'AUDIO', 'MODE1'].map(track) }
    expect(plan(gd, 'Extract').outputs).toEqual(['Game.gdi', 'Game01.bin', 'Game02.raw', 'Game03.bin'])
    // Older chdman versions (0.264) write GD-ROM cue sheets with a single BIN, so that name is claimed too.
    expect(plan(gd, 'Extract', { extractGd: 'cue' }).outputs).toEqual(['Game.cue', 'Game (Track 1).bin', 'Game (Track 2).bin', 'Game (Track 3).bin', 'Game.bin'])
    const long = { ...gd, tracks: Array.from({ length: 10 }, (_, i) => track('AUDIO', i)) }
    expect(plan(long, 'Extract', { extractGd: 'cue' }).outputs.slice(1, 3)).toEqual(['Game (Track 01).bin', 'Game (Track 02).bin'])
    expect(plan({ ...chd('cd'), tracks: ['MODE1', 'AUDIO'].map(track) }, 'Extract').outputs).toEqual(['Game.cue', 'Game.bin'])
    expect(plan(chd('dvd'), 'CSO').outputs).toEqual(['Game.cso'])
  })

  it('decompresses CSO/ZSO/DAX with maxcso', () => {
    expect(args(plan(cso('zso'), 'Extract', { threads: 2 }).steps[0])).toEqual(['--decompress', '--threads=2', '-o', '<work>/Game.iso', '<input>'])
  })

  it('may give CD CHDs that end with a data track one file per track, as a Dreamcast CD-R needs', () => {
    const selfboot = { ...chd('cd'), tracks: ['AUDIO', 'MODE2'].map(track) }
    const result = plan(selfboot, 'Extract')
    expect(args(result.steps[0])).toEqual(['extractcd', '-i', '<input>', '-o', '<work>/Game.cue', '-f'])
    expect(result.steps[1]).toEqual({ kind: 'split-tracks', label: 'Writing track files', weight: 0.2, sheet: { ref: 'work', name: 'Game.cue' } })
    expect(result.finalize).toEqual({ kind: 'sheet', sheet: 'Game.cue' })
    // Other discs keep chdman's single BIN, so that name is claimed too.
    expect(result.outputs).toEqual(['Game.cue', 'Game (Track 1).bin', 'Game (Track 2).bin', 'Game.bin'])
  })

  it('builds a CDI from a CD CHD through a cue sheet', () => {
    const result = plan({ ...chd('cd'), tracks: ['AUDIO', 'MODE2'].map(track) }, 'Extract', { extractCd: 'cdi' })
    expect(args(result.steps[0])).toEqual(['extractcd', '-i', '<input>', '-o', '<work>/image.cue', '-f'])
    expect(result.steps[1]).toEqual({
      kind: 'cdi-build',
      label: 'Building CDI image',
      weight: 0.4,
      sheet: { ref: 'work', name: 'image.cue' },
      output: { ref: 'work', name: 'Game.cdi' }
    })
    expect(result.finalize).toEqual({ kind: 'file', from: { ref: 'work', name: 'Game.cdi' }, name: 'Game.cdi' })
    expect(result.outputs).toEqual(['Game.cdi'])
  })
})

describe('DiscJuggler images', () => {
  it('become CD CHDs through a Redump-style cue sheet, which chdman can read', () => {
    const result = plan(cdi(), 'CHD', { chdCodecsCd: ['cdzs'], chdMediaChoice: 'dvd' })
    expect(result.steps[0]).toEqual({ kind: 'cdi-split', label: 'Unpacking CDI image', weight: 0.1, baseName: 'image', sessions: false })
    expect(args(result.steps[1])).toEqual(['createcd', '-i', '<work>/image.cue', '-o', '<work>/Game.chd', '-f', '-c', 'cdzs'])
    expect(result.outputs).toEqual(['Game.chd'])
  })

  it('are extracted to one BIN per track and a cue sheet that marks the sessions', () => {
    const result = plan(cdi(), 'Extract')
    expect(result.steps).toEqual([{ kind: 'cdi-split', label: 'Extracting CDI image', weight: 1, baseName: 'Game', sessions: true }])
    expect(result.finalize).toEqual({ kind: 'sheet', sheet: 'Game.cue' })
    expect(result.outputs).toEqual(['Game.cue', 'Game (Track 1).bin', 'Game (Track 2).bin'])
    expect(plan(cdi(['MODE1/2048']), 'Extract').outputs).toEqual(['Game.cue', 'Game.bin'])
  })

  it('cannot become an ISO-based format', () => {
    expect(planJob(cdi(), 'CSO', DEFAULT_JOB_SETTINGS, { baseName: 'Game' })).toEqual({ ok: false, error: 'DiscJuggler images can only become a CHD or BIN/CUE' })
    expect(planJob(cdi(), 'Info', DEFAULT_JOB_SETTINGS, { baseName: 'Game' }).ok).toBe(false)
  })
})

describe('Info and Verify', () => {
  it('never produce output files', () => {
    expect(plan(chd('cd'), 'Info')).toMatchObject({ finalize: { kind: 'none' }, outputs: [] })
    expect(args(plan(chd('cd'), 'Verify').steps[0])).toEqual(['verify', '-i', '<input>'])
  })

  it('require chdman to confirm each checksum, since it exits with 0 on a mismatch', () => {
    const confirmed = (source: ScannedInput): string[] | undefined => {
      const [step] = plan(source, 'Verify').steps
      return step?.kind === 'tool' ? step.confirm?.lines : undefined
    }
    expect(confirmed(chd('cd'))).toEqual(['Raw SHA1 verification successful!', 'Overall SHA1 verification successful!'])
    const v3 = chd('cd')
    expect(confirmed({ ...v3, chd: { ...(v3.chd as ChdInfo), version: 3 } })).toEqual(['Raw SHA1 verification successful!'])
  })

  it('are refused for non-CHD input', () => {
    expect(planJob(input({}), 'Verify', DEFAULT_JOB_SETTINGS, { baseName: 'Game' }).ok).toBe(false)
  })
})
