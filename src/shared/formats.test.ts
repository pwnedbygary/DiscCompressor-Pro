import { describe, expect, it } from 'vitest'
import {
  DEFAULT_JOB_SETTINGS,
  csoMethodArgs,
  defaultTargetFor,
  effectiveCsoMethods,
  normalizeJobSettings,
  outputExtension,
  targetAvailability
} from './formats'
import type { ScannedInput } from './types'

function input(overrides: Partial<ScannedInput>): ScannedInput {
  return {
    path: '/games/Game.iso',
    name: 'Game.iso',
    kind: 'iso',
    size: 2048 * 100,
    files: ['/games/Game.iso'],
    media: null,
    tracks: [],
    isoLayout: null,
    isoBlocker: null,
    chd: null,
    ciso: null,
    problem: null,
    ...overrides
  }
}

const cdChd = (tracks: number, blocker: string | null = null): ScannedInput =>
  input({
    kind: 'chd',
    name: 'Game.chd',
    path: '/games/Game.chd',
    media: 'cd',
    isoLayout: blocker ? null : { sectorSize: 2352, mode: 2 },
    isoBlocker: blocker,
    chd: { version: 5, logicalBytes: 1, hunkBytes: 19584, unitBytes: 2448, codecs: ['cdlz'], media: 'cd', tracks: [], hasParent: false },
    tracks: Array.from({ length: tracks }, (_, i) => ({ number: i + 1, type: 'MODE2_RAW', sectorSize: 2352 }))
  })

describe('csoMethodArgs', () => {
  it('emits nothing for maxcso defaults', () => {
    expect(csoMethodArgs('cso1', 'default', [])).toEqual([])
    expect(csoMethodArgs('cso2', 'default', [])).toEqual([])
    expect(csoMethodArgs('zso', 'default', [])).toEqual([])
  })

  it('uses --fast for fast mode', () => {
    expect(csoMethodArgs('zso', 'fast', [])).toEqual(['--fast'])
  })

  it('enables every applicable method for max mode', () => {
    expect(csoMethodArgs('cso1', 'max', [])).toEqual(['--use-zopfli'])
    expect(csoMethodArgs('cso2', 'max', [])).toEqual(['--use-zopfli', '--use-lz4brute'])
    expect(csoMethodArgs('zso', 'max', [])).toEqual(['--use-lz4brute'])
  })

  it('translates a custom selection relative to the defaults, ignoring inapplicable methods', () => {
    expect(csoMethodArgs('cso1', 'custom', ['zlib', 'zopfli', 'lz4'])).toEqual(['--no-7zdeflate', '--no-libdeflate', '--use-zopfli'])
    expect(csoMethodArgs('cso2', 'custom', ['zlib', 'lz4'])).toEqual(['--no-7zdeflate', '--no-libdeflate'])
  })

  it('keeps LZ4 HC enabled when brute force is chosen, because maxcso runs brute force inside it', () => {
    expect(effectiveCsoMethods('zso', 'custom', ['lz4brute'])).toEqual(['lz4', 'lz4brute'])
    expect(csoMethodArgs('zso', 'custom', ['zlib', 'lz4brute'])).toEqual(['--use-lz4brute'])
    expect(csoMethodArgs('cso2', 'custom', ['zlib', 'lz4brute'])).toEqual(['--no-7zdeflate', '--no-libdeflate', '--use-lz4brute'])
  })

  it('falls back to the defaults when a custom selection has no applicable method', () => {
    expect(csoMethodArgs('zso', 'custom', ['zlib'])).toEqual([])
    expect(effectiveCsoMethods('zso', 'custom', ['zlib'])).toEqual(['lz4'])
  })
})

describe('normalizeJobSettings', () => {
  it('returns defaults for garbage', () => {
    expect(normalizeJobSettings(null)).toEqual(DEFAULT_JOB_SETTINGS)
    expect(normalizeJobSettings('x')).toEqual(DEFAULT_JOB_SETTINGS)
  })

  it('drops unknown codecs, duplicates and anything past four', () => {
    const settings = normalizeJobSettings({ chdCodecsDvd: ['zlib', 'zlib', 'nope', 'lzma', 'huff', 'flac', 'zstd'] })
    expect(settings.chdCodecsDvd).toEqual(['zlib', 'lzma', 'huff', 'flac'])
  })

  it('rejects hunk sizes chdman would refuse', () => {
    expect(normalizeJobSettings({ chdHunkCd: 2048 }).chdHunkCd).toBe(0)
    expect(normalizeJobSettings({ chdHunkCd: 4896 }).chdHunkCd).toBe(4896)
    expect(normalizeJobSettings({ chdHunkDvd: 1024 }).chdHunkDvd).toBe(0)
    expect(normalizeJobSettings({ chdHunkDvd: 8192 }).chdHunkDvd).toBe(8192)
  })

  it('rejects block sizes maxcso would refuse', () => {
    expect(normalizeJobSettings({ csoBlockSize: 3000 }).csoBlockSize).toBe(2048)
    expect(normalizeJobSettings({ csoBlockSize: 1024 }).csoBlockSize).toBe(2048)
    expect(normalizeJobSettings({ csoBlockSize: 16384 }).csoBlockSize).toBe(16384)
    expect(normalizeJobSettings({ csoBlockSize: 0 }).csoBlockSize).toBe(0)
  })
})

describe('targetAvailability', () => {
  const allowed = (i: ScannedInput): string[] => targetAvailability(i).filter((a) => a.allowed).map((a) => a.target)

  it('offers compression targets for ISOs', () => {
    expect(allowed(input({}))).toEqual(['CHD', 'CSO', 'CSOv2', 'ZSO'])
  })

  it('blocks ISO-based formats for misaligned ISOs', () => {
    expect(allowed(input({ isoBlocker: 'bad size' }))).toEqual(['CHD'])
  })

  it('only allows CHD for GDI', () => {
    expect(allowed(input({ kind: 'gdi', media: 'gdrom' }))).toEqual(['CHD'])
  })

  it('allows CSO for single-data-track CD CHDs only', () => {
    expect(allowed(cdChd(1))).toEqual(['CHD', 'CSO', 'CSOv2', 'ZSO', 'Extract', 'Info', 'Verify'])
    expect(allowed(cdChd(3, 'three tracks'))).toEqual(['CHD', 'Extract', 'Info', 'Verify'])
  })

  it('allows nothing for broken inputs', () => {
    expect(allowed(input({ problem: 'Missing track file' }))).toEqual([])
  })

  it('does not offer Verify for uncompressed CHDs, which have no checksums', () => {
    const plain = cdChd(1)
    const uncompressed = { ...plain, chd: { ...(plain.chd as NonNullable<ScannedInput['chd']>), codecs: ['none'] } }
    expect(allowed(plain)).toContain('Verify')
    expect(allowed(uncompressed)).not.toContain('Verify')
    expect(targetAvailability(uncompressed).find((a) => a.target === 'Verify')?.reason).toBe('Uncompressed CHDs have no checksums to verify')
  })
})

describe('defaultTargetFor', () => {
  it('extracts compressed inputs, as v1 did', () => {
    expect(defaultTargetFor(cdChd(1), 'CHD')).toBe('Extract')
    expect(defaultTargetFor(input({ kind: 'cso' }), 'CHD')).toBe('Extract')
  })

  it('uses the preferred target when possible', () => {
    expect(defaultTargetFor(input({}), 'ZSO')).toBe('ZSO')
    expect(defaultTargetFor(input({ kind: 'cue', media: 'cd' }), 'ZSO')).toBe('CHD')
  })
})

describe('outputExtension', () => {
  it('follows the extraction settings for CHDs', () => {
    const settings = { ...DEFAULT_JOB_SETTINGS }
    expect(outputExtension(cdChd(1), 'Extract', settings)).toBe('.cue')
    expect(outputExtension(cdChd(1), 'Extract', { ...settings, extractCd: 'iso' })).toBe('.iso')
    expect(outputExtension(cdChd(2, 'The disc has audio tracks'), 'Extract', { ...settings, extractCd: 'iso' })).toBe('.cue')
    const gd = input({ kind: 'chd', chd: { ...(cdChd(1).chd as NonNullable<ScannedInput['chd']>), media: 'gdrom' } })
    expect(outputExtension(gd, 'Extract', settings)).toBe('.gdi')
    expect(outputExtension(gd, 'Extract', { ...settings, extractGd: 'cue' })).toBe('.cue')
    expect(outputExtension(input({ kind: 'zso' }), 'Extract', settings)).toBe('.iso')
    expect(outputExtension(input({}), 'ZSO', settings)).toBe('.zso')
    expect(outputExtension(cdChd(1), 'Verify', settings)).toBeNull()
  })
})
