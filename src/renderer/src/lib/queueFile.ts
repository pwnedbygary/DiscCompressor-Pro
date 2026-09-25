import { CD_CODECS, DVD_CODECS, TARGETS, normalizeJobSettings } from '@shared/formats'
import type { CsoMethod, JobSettings, Target } from '@shared/types'
import type { Job } from './jobs'

export interface QueueEntry {
  path: string
  target: Target | null
  settings: JobSettings | null
}

interface QueueFileV2 {
  app: 'DiscCompressor Pro'
  format: 2
  exportedAt: string
  jobs: { path: string; target: Target; settings: JobSettings }[]
}

export function serializeQueue(jobs: Job[]): string {
  const file: QueueFileV2 = {
    app: 'DiscCompressor Pro',
    format: 2,
    exportedAt: new Date().toISOString(),
    jobs: jobs.map((job) => ({ path: job.input.path, target: job.target, settings: job.settings }))
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

const V1_METHODS: Record<string, CsoMethod> = {
  'use-zlib': 'zlib',
  'use-zopfli': 'zopfli',
  'use-7zdeflate': '7zdeflate',
  'use-libdeflate': 'libdeflate',
  'use-lz4': 'lz4',
  'use-lz4brute': 'lz4brute'
}

/** Translate the settings of a v1 queue export into the current model. */
function settingsFromV1(raw: Record<string, unknown>, path: string): JobSettings {
  const settings = (raw.settings && typeof raw.settings === 'object' ? raw.settings : {}) as Record<string, unknown>
  const codecs = Array.isArray(settings.chdAlgorithms) ? settings.chdAlgorithms.filter((c) => typeof c === 'string') : []
  const methods = Array.isArray(settings.maxcsoAlgorithms) ? settings.maxcsoAlgorithms.filter((m) => typeof m === 'string') : []
  const dvd = raw.fileType === 'DVD'
  const sheet = /\.(cue|gdi)$/i.test(path)
  const hunk = typeof settings.hunkSize === 'number' ? settings.hunkSize : 0
  const extract = settings.extractFormat
  return normalizeJobSettings({
    // v1 defaulted every image except cue sheets and GDIs to DVD, so only CD on such an image was a choice.
    chdMediaChoice: dvd || sheet ? 'auto' : 'cd',
    chdCodecsCd: codecs.filter((c) => CD_CODECS.some((codec) => codec.id === c)),
    chdCodecsDvd: codecs.filter((c) => DVD_CODECS.some((codec) => codec.id === c)),
    [dvd ? 'chdHunkDvd' : 'chdHunkCd']: hunk,
    csoMode: methods.includes('fast') ? 'fast' : methods.length > 0 ? 'custom' : 'default',
    csoMethods: methods.flatMap((m) => (V1_METHODS[m] ? [V1_METHODS[m]] : [])),
    extractCd: extract === 'ISO' ? 'iso' : 'cue',
    extractGd: extract === 'BIN/CUE' ? 'cue' : 'gdi',
    threads: typeof settings.threads === 'number' ? settings.threads : 0
  })
}

/** Parse a queue file written by this version or by v1. */
export function parseQueueFile(text: string): QueueEntry[] {
  const data = JSON.parse(text) as unknown
  if (Array.isArray(data)) {
    return data.flatMap((raw: Record<string, unknown>) => {
      if (!raw || typeof raw.inputPath !== 'string' || !raw.inputPath) return []
      const target = TARGETS.includes(raw.type as Target) ? (raw.type as Target) : null
      return [{ path: raw.inputPath, target, settings: settingsFromV1(raw, raw.inputPath) }]
    })
  }
  const file = data as Partial<QueueFileV2>
  if (!file || file.format !== 2 || !Array.isArray(file.jobs)) throw new Error('This is not a DiscCompressor Pro queue file')
  return file.jobs.flatMap((raw) => {
    if (!raw || typeof raw.path !== 'string' || !raw.path) return []
    return [{ path: raw.path, target: TARGETS.includes(raw.target) ? raw.target : null, settings: normalizeJobSettings(raw.settings) }]
  })
}
