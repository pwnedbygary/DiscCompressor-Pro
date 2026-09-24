import { describe, expect, it } from 'vitest'
import { DEFAULT_JOB_SETTINGS } from '@shared/formats'
import type { Job } from './jobs'
import { parseQueueFile, serializeQueue } from './queueFile'

describe('queue files', () => {
  it('round-trips the current format', () => {
    const job = {
      input: { path: '/games/Game.iso' },
      target: 'ZSO',
      settings: { ...DEFAULT_JOB_SETTINGS, csoMode: 'max' }
    } as unknown as Job
    expect(parseQueueFile(serializeQueue([job]))).toEqual([{ path: '/games/Game.iso', target: 'ZSO', settings: job.settings }])
  })

  it('imports v1 exports and translates their settings', () => {
    const v1 = [
      {
        id: 'abc',
        fileName: 'Game.cue',
        fileType: 'CD',
        type: 'CHD',
        status: 'Completed',
        inputPath: '/games/Game.cue',
        settings: { hunkSize: 4896, chdAlgorithms: ['cdzl', 'cdlz'], compressionLevel: 9, threads: 8, maxcsoAlgorithms: ['use-zlib', 'use-zopfli'], extractFormat: 'ISO' }
      },
      { id: 'def', fileName: 'Other.iso', fileType: 'DVD', type: 'CSOv2', inputPath: '/games/Other.iso', settings: { maxcsoAlgorithms: ['fast'], hunkSize: 512 } },
      { id: 'web', fileName: 'NoPath.iso', type: 'CHD' }
    ]
    const [first, second, third] = parseQueueFile(JSON.stringify(v1))
    expect(third).toBeUndefined()
    expect(first).toMatchObject({
      path: '/games/Game.cue',
      target: 'CHD',
      settings: { chdMedia: 'cd', chdCodecsCd: ['cdzl', 'cdlz'], chdHunkCd: 4896, threads: 8, csoMode: 'custom', csoMethods: ['zlib', 'zopfli'], extractCd: 'iso' }
    })
    // 512 is not a valid DVD hunk size for chdman, so it falls back to the default.
    expect(second).toMatchObject({ path: '/games/Other.iso', target: 'CSOv2', settings: { chdMedia: 'dvd', chdHunkDvd: 0, csoMode: 'fast' } })
  })

  it('rejects unrelated JSON', () => {
    expect(() => parseQueueFile('{"hello": 1}')).toThrow(/not a DiscCompressor Pro queue file/)
  })
})
