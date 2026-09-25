import {
  CSO_FORMAT_FOR_TARGET,
  TARGET_LABELS,
  chdMediaFor,
  csoMethodArgs,
  effectiveCsoMethods,
  outputExtension
} from '@shared/formats'
import type { InputKind, JobSettings, ScannedInput, Target } from '@shared/types'

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped'

export interface Job {
  id: string
  input: ScannedInput
  target: Target
  settings: JobSettings
  status: JobStatus
  /** 0..1, or null while progress cannot be measured. */
  progress: number | null
  stage: string | null
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  outputs: string[]
  outputBytes: number | null
  /**
   * The user asked for this job to run again (Run again, a settings change on
   * a finished job, Duplicate), so it writes a new output even when existing
   * outputs are skipped.
   */
  rerun: boolean
}

export const INPUT_LABELS: Record<InputKind, string> = {
  cue: 'BIN/CUE',
  gdi: 'GDI',
  iso: 'ISO',
  chd: 'CHD',
  cso: 'CSO',
  zso: 'ZSO',
  dax: 'DAX',
  cdi: 'CDI'
}

export const MEDIA_LABELS = { cd: 'CD', dvd: 'DVD', gdrom: 'GD-ROM' } as const

export function isFinished(status: JobStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled' || status === 'skipped'
}

/**
 * Everything that determines what a job produces, and nothing else (thread
 * counts and the settings of other formats are left out). Finished jobs are
 * queued again only when this changes.
 */
export function outputSignature(input: ScannedInput, target: Target, settings: JobSettings): string {
  switch (target) {
    case 'CHD': {
      const media = chdMediaFor(input, settings)
      const dvd = media === 'dvd'
      return JSON.stringify([target, media, dvd ? settings.chdCodecsDvd : settings.chdCodecsCd, dvd ? settings.chdHunkDvd : settings.chdHunkCd])
    }
    case 'CSO':
    case 'CSOv2':
    case 'ZSO': {
      const format = CSO_FORMAT_FOR_TARGET[target] ?? 'cso1'
      return JSON.stringify([target, csoMethodArgs(format, settings.csoMode, settings.csoMethods), settings.csoBlockSize])
    }
    case 'Extract':
      return JSON.stringify([target, outputExtension(input, target, settings)])
    case 'Info':
    case 'Verify':
      return target
  }
}

/** A short description of what a job will produce, e.g. "CD CHD · cdlz, cdzl, cdfl". */
export function describeOutput(input: ScannedInput, target: Target, settings: JobSettings): string {
  switch (target) {
    case 'CHD': {
      const media = chdMediaFor(input, settings)
      const codecs = media === 'dvd' ? settings.chdCodecsDvd : settings.chdCodecsCd
      const verb = input.kind === 'chd' ? 'Recompressed CHD' : `${MEDIA_LABELS[media]} CHD`
      return `${verb} · ${codecs.join(', ')}`
    }
    case 'CSO':
    case 'CSOv2':
    case 'ZSO': {
      const format = CSO_FORMAT_FOR_TARGET[target]
      const methods = format ? effectiveCsoMethods(format, settings.csoMode, settings.csoMethods) : []
      const effort = settings.csoMode === 'fast' ? 'fast' : settings.csoMode === 'max' ? 'maximum' : methods.join(', ')
      return `${TARGET_LABELS[target]} · ${effort}`
    }
    case 'Extract': {
      const ext = outputExtension(input, target, settings)
      return ext === '.cue' ? 'BIN/CUE' : ext === '.gdi' ? 'GDI' : ext === '.cdi' ? 'CDI' : 'ISO'
    }
    case 'Info':
      return 'CHD information'
    case 'Verify':
      return 'Integrity check'
  }
}
