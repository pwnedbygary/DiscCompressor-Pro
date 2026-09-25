import {
  CD_FRAME_BYTES,
  CSO_FORMAT_FOR_TARGET,
  DVD_SECTOR_BYTES,
  TARGET_LABELS,
  chdMediaFor,
  csoMethodArgs,
  endsWithDataTrack,
  extractCdFormat,
  isValidChdHunk,
  targetAvailability
} from '@shared/formats'
import type { IsoLayout, JobSettings, ScannedInput, Target, ToolName } from '@shared/types'

/** A path the runner resolves when it executes the plan. */
export type PathRef =
  | { ref: 'input' }
  | { ref: 'file'; path: string }
  | { ref: 'work'; name: string }

export type Arg = string | PathRef

export type ProgressSource =
  | { kind: 'chdman' }
  /** Bytes the process has read, relative to the size of `of`. */
  | { kind: 'read'; of: PathRef }
  /** Size of `file` relative to `totalBytes`. */
  | { kind: 'output'; file: PathRef; totalBytes: number }
  | { kind: 'none' }

export interface ToolStep {
  kind: 'tool'
  tool: ToolName
  args: Arg[]
  label: string
  weight: number
  progress: ProgressSource
  /**
   * Lines the tool must print for the step to succeed. `chdman verify` exits
   * with 0 even when a checksum does not match. An error starting with
   * `unsupported.prefix` means the check could not be made at all.
   */
  confirm?: { lines: string[]; failure: string; unsupported?: { prefix: string; message: string } }
}

export interface IsoStep {
  kind: 'iso'
  label: string
  weight: number
  source: PathRef
  layout: IsoLayout
  output: PathRef
}

/** Write the input DiscJuggler image as BIN files and a cue sheet named after `baseName` in the work directory. */
export interface CdiSplitStep {
  kind: 'cdi-split'
  label: string
  weight: number
  baseName: string
  /** Mark the sessions in the cue sheet (REM SESSION). */
  sessions: boolean
}

/** Build a DiscJuggler image from a cue sheet written by chdman extractcd. */
export interface CdiBuildStep {
  kind: 'cdi-build'
  label: string
  weight: number
  sheet: PathRef
  output: PathRef
}

/** Rewrite the sheet chdman extractcd wrote for a Dreamcast CD-R so that Flycast reads it; other discs keep it as it is. */
export interface SplitTracksStep {
  kind: 'split-tracks'
  label: string
  weight: number
  sheet: PathRef
}

export type Step = ToolStep | IsoStep | CdiSplitStep | CdiBuildStep | SplitTracksStep

export type Finalize =
  /** Move one work file into the output directory under `name`. */
  | { kind: 'file'; from: PathRef; name: string }
  /** Move a sheet (CUE/GDI) and every track file chdman wrote beside it. */
  | { kind: 'sheet'; sheet: string }
  | { kind: 'none' }

export interface Plan {
  steps: Step[]
  finalize: Finalize
  /** Every file the job will create in the output directory, primary output first. */
  outputs: string[]
}

export interface PlanContext {
  /** Output file name without extension, already de-duplicated by the runner. */
  baseName: string
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; error: string }

const INPUT: PathRef = { ref: 'input' }
const work = (name: string): PathRef => ({ ref: 'work', name })

// maxcso 1.13.0 treats a "--" separator itself as an input file (cli.cpp breaks
// out of option parsing without skipping it), so it is never passed. Every path
// the runner resolves is absolute and therefore cannot be mistaken for an option.

function threadArgs(flag: '-np' | '--threads', threads: number): string[] {
  if (threads <= 0) return []
  return flag === '-np' ? ['-np', String(threads)] : [`--threads=${threads}`]
}

function chdCompressionArgs(settings: JobSettings, dvd: boolean): string[] {
  const codecs = dvd ? settings.chdCodecsDvd : settings.chdCodecsCd
  const hunk = dvd ? settings.chdHunkDvd : settings.chdHunkCd
  return ['-c', codecs.join(','), ...(hunk > 0 ? ['-hs', String(hunk)] : []), ...threadArgs('-np', settings.threads)]
}

/** chdman createcd/createdvd from an image chdman can read directly. */
function createChdStep(source: PathRef, output: PathRef, dvd: boolean, settings: JobSettings, weight: number): ToolStep {
  return {
    kind: 'tool',
    tool: 'chdman',
    args: [dvd ? 'createdvd' : 'createcd', '-i', source, '-o', output, '-f', ...chdCompressionArgs(settings, dvd)],
    label: dvd ? 'Compressing to DVD CHD' : 'Compressing to CD CHD',
    weight,
    progress: { kind: 'chdman' }
  }
}

function decompressCisoStep(input: ScannedInput, output: PathRef, settings: JobSettings, weight: number): ToolStep {
  return {
    kind: 'tool',
    tool: 'maxcso',
    args: ['--decompress', ...threadArgs('--threads', settings.threads), '-o', output, INPUT],
    label: `Decompressing ${input.kind.toUpperCase()}`,
    weight,
    progress: { kind: 'output', file: output, totalBytes: input.ciso?.uncompressedBytes ?? 0 }
  }
}

/** Redump names of a disc's track files: one per track, numbered with two digits from 10 tracks on. */
export function trackFileNames(baseName: string, tracks: number): string[] {
  if (tracks === 1) return [`${baseName}.bin`]
  const width = tracks >= 10 ? 2 : 1
  return Array.from({ length: tracks }, (_, index) => `${baseName} (Track ${String(index + 1).padStart(width, '0')}).bin`)
}

function extractCdSteps(output: PathRef, bin: PathRef | null, weight: number): ToolStep {
  return {
    kind: 'tool',
    tool: 'chdman',
    args: ['extractcd', '-i', INPUT, '-o', output, ...(bin ? ['-ob', bin] : []), '-f'],
    label: 'Extracting CHD',
    weight,
    progress: { kind: 'chdman' }
  }
}

/**
 * Steps that leave a 2048-byte-sector ISO for a CD image with a single data
 * track, returning where that ISO (or an equivalent track file) ends up.
 */
function isoFromCdSteps(input: ScannedInput, layout: IsoLayout, extractWeight: number, convertWeight: number): { steps: Step[]; iso: PathRef } {
  const steps: Step[] = []
  let track: PathRef
  if (input.kind === 'chd') {
    track = work('image.bin')
    steps.push(extractCdSteps(work('image.cue'), track, extractWeight))
  } else {
    track = { ref: 'file', path: input.files[1] as string }
  }
  if (layout.sectorSize === 2048) return { steps, iso: track }
  const iso = work('image.iso')
  steps.push({ kind: 'iso', label: 'Converting track to ISO', weight: convertWeight, source: track, layout, output: iso })
  return { steps, iso }
}

function planChd(input: ScannedInput, settings: JobSettings, output: PathRef): Step[] | string {
  const media = chdMediaFor(input, settings)
  const dvd = media === 'dvd'

  switch (input.kind) {
    case 'cue':
    case 'gdi':
      return [createChdStep(INPUT, output, false, settings, 1)]
    case 'cdi':
      // chdman cannot read DiscJuggler images, but it keeps the stored pregaps of a Redump-style cue sheet.
      return [
        { kind: 'cdi-split', label: 'Unpacking CDI image', weight: 0.1, baseName: 'image', sessions: false },
        createChdStep(work('image.cue'), output, false, settings, 0.9)
      ]
    case 'iso':
      if (dvd && input.size % DVD_SECTOR_BYTES !== 0) {
        return 'The ISO size is not a multiple of 2048 bytes, so it can only be stored as a CD CHD'
      }
      return [createChdStep(INPUT, output, dvd, settings, 1)]
    case 'cso':
    case 'zso':
    case 'dax':
      return [decompressCisoStep(input, work('image.iso'), settings, 0.25), createChdStep(work('image.iso'), output, dvd, settings, 0.75)]
    case 'chd': {
      const chd = input.chd
      if (!chd) return 'The CHD header could not be read'
      const hunk = dvd ? settings.chdHunkDvd : settings.chdHunkCd
      if (hunk > 0) {
        const unit = dvd ? DVD_SECTOR_BYTES : CD_FRAME_BYTES
        if (!isValidChdHunk(hunk, chd.unitBytes || unit) || (hunk % chd.hunkBytes !== 0 && chd.hunkBytes % hunk !== 0)) {
          return `A hunk size of ${hunk} bytes is incompatible with this CHD (hunk ${chd.hunkBytes}, unit ${chd.unitBytes} bytes)`
        }
      }
      return [
        {
          kind: 'tool',
          tool: 'chdman',
          args: ['copy', '-i', INPUT, '-o', output, '-f', ...chdCompressionArgs(settings, dvd)],
          label: 'Recompressing CHD',
          weight: 1,
          progress: { kind: 'chdman' }
        }
      ]
    }
  }
}

function planCso(input: ScannedInput, target: Target, settings: JobSettings, output: PathRef): Step[] | string {
  const format = CSO_FORMAT_FOR_TARGET[target]
  if (!format) return `${target} is not a maxcso format`
  const steps: Step[] = []
  let source: PathRef = INPUT
  let maxcsoWeight = 1

  if (input.kind === 'chd' && input.chd?.media === 'dvd') {
    source = work('image.iso')
    steps.push({
      kind: 'tool',
      tool: 'chdman',
      args: ['extractdvd', '-i', INPUT, '-o', source, '-f'],
      label: 'Extracting CHD',
      weight: 0.35,
      progress: { kind: 'chdman' }
    })
    maxcsoWeight = 0.65
  } else if (input.kind === 'chd' || input.kind === 'cue') {
    if (!input.isoLayout) return input.isoBlocker ?? 'This image cannot be converted to ISO'
    const { steps: isoSteps, iso } = isoFromCdSteps(input, input.isoLayout, 0.3, 0.1)
    steps.push(...isoSteps)
    source = iso
    maxcsoWeight = 1 - isoSteps.reduce((sum, step) => sum + step.weight, 0)
  }

  steps.push({
    kind: 'tool',
    tool: 'maxcso',
    args: [
      `--format=${format}`,
      ...(settings.csoBlockSize > 0 ? [`--block=${settings.csoBlockSize}`] : []),
      ...threadArgs('--threads', settings.threads),
      ...csoMethodArgs(format, settings.csoMode, settings.csoMethods),
      '-o',
      output,
      source
    ],
    label: `Compressing to ${TARGET_LABELS[target]}`,
    weight: maxcsoWeight,
    progress: { kind: 'read', of: source }
  })
  return steps
}

/**
 * The files an extraction to a sheet may write, sheet first. `chdman
 * extractcd` (0.289, do_extract_cd) gives GDI output one file per track and
 * other cue sheets a single BIN. GD-ROM cue sheets follow the Redump layout
 * with one file per track in current versions, but a single BIN in older ones
 * such as 0.264, so both sets of names are claimed. Both are also claimed for
 * a CD that ends with a data track, which the split-tracks step gives one file
 * per track if it is a Dreamcast CD-R. DiscJuggler images get one per track.
 */
export function extractedFileNames(input: ScannedInput, sheet: string): string[] {
  const base = sheet.slice(0, sheet.lastIndexOf('.'))
  const gdi = sheet.endsWith('.gdi')
  if (input.kind === 'cdi') return [sheet, ...trackFileNames(base, input.tracks.length)]
  if (input.chd?.media === 'cd' && endsWithDataTrack(input)) return [sheet, ...trackFileNames(base, input.tracks.length), `${base}.bin`]
  if (!gdi && input.chd?.media !== 'gdrom') return [sheet, `${base}.bin`]
  const padded = gdi || input.tracks.length >= 10
  const number = (index: number): string => String(index + 1).padStart(padded ? 2 : 1, '0')
  const tracks = input.tracks.map((track, index) =>
    gdi ? `${base}${number(index)}${track.type === 'AUDIO' ? '.raw' : '.bin'}` : `${base} (Track ${number(index)}).bin`
  )
  return gdi ? [sheet, ...tracks] : [sheet, ...tracks, `${base}.bin`]
}

function outputNames(input: ScannedInput, finalize: Finalize): string[] {
  switch (finalize.kind) {
    case 'file':
      return [finalize.name]
    case 'sheet':
      return extractedFileNames(input, finalize.sheet)
    case 'none':
      return []
  }
}

function planExtract(input: ScannedInput, settings: JobSettings, baseName: string): Omit<Plan, 'outputs'> | string {
  if (input.kind === 'cdi') {
    return {
      steps: [{ kind: 'cdi-split', label: 'Extracting CDI image', weight: 1, baseName, sessions: true }],
      finalize: { kind: 'sheet', sheet: `${baseName}.cue` }
    }
  }
  if (input.kind === 'cso' || input.kind === 'zso' || input.kind === 'dax') {
    const iso = work(`${baseName}.iso`)
    return { steps: [decompressCisoStep(input, iso, settings, 1)], finalize: { kind: 'file', from: iso, name: `${baseName}.iso` } }
  }
  if (input.kind !== 'chd' || !input.chd) return 'Only compressed images can be extracted'

  switch (input.chd.media) {
    case 'dvd': {
      const iso = work(`${baseName}.iso`)
      return {
        steps: [
          {
            kind: 'tool',
            tool: 'chdman',
            args: ['extractdvd', '-i', INPUT, '-o', iso, '-f'],
            label: 'Extracting CHD',
            weight: 1,
            progress: { kind: 'chdman' }
          }
        ],
        finalize: { kind: 'file', from: iso, name: `${baseName}.iso` }
      }
    }
    case 'gdrom': {
      const sheet = `${baseName}${settings.extractGd === 'cue' ? '.cue' : '.gdi'}`
      return { steps: [extractCdSteps(work(sheet), null, 1)], finalize: { kind: 'sheet', sheet } }
    }
    case 'cd': {
      const format = extractCdFormat(input, settings)
      if (format === 'cdi') {
        const name = `${baseName}.cdi`
        return {
          steps: [
            extractCdSteps(work('image.cue'), null, 0.6),
            { kind: 'cdi-build', label: 'Building CDI image', weight: 0.4, sheet: work('image.cue'), output: work(name) }
          ],
          finalize: { kind: 'file', from: work(name), name }
        }
      }
      if (format === 'cue') {
        const sheet = `${baseName}.cue`
        if (!endsWithDataTrack(input)) return { steps: [extractCdSteps(work(sheet), null, 1)], finalize: { kind: 'sheet', sheet } }
        return {
          steps: [extractCdSteps(work(sheet), null, 0.8), { kind: 'split-tracks', label: 'Writing track files', weight: 0.2, sheet: work(sheet) }],
          finalize: { kind: 'sheet', sheet }
        }
      }
      const { steps, iso } = isoFromCdSteps(input, input.isoLayout as IsoLayout, 0.8, 0.2)
      return { steps, finalize: { kind: 'file', from: iso, name: `${baseName}.iso` } }
    }
    default:
      return 'Only CD, DVD and GD-ROM CHDs can be extracted'
  }
}

/** Work out the commands that turn `input` into `target`. Pure: touches no files. */
export function planJob(input: ScannedInput, target: Target, settings: JobSettings, context: PlanContext): PlanResult {
  const availability = targetAvailability(input).find((entry) => entry.target === target)
  if (!availability?.allowed) return { ok: false, error: availability?.reason ?? `Unknown target ${target}` }

  const fail = (error: string): PlanResult => ({ ok: false, error })
  const planned = (plan: Omit<Plan, 'outputs'> | string): PlanResult =>
    typeof plan === 'string' ? fail(plan) : { ok: true, plan: { ...plan, outputs: outputNames(input, plan.finalize) } }
  const singleFile = (steps: Step[] | string, name: string): PlanResult =>
    planned(typeof steps === 'string' ? steps : { steps, finalize: { kind: 'file', from: work(name), name } })

  switch (target) {
    case 'CHD': {
      const name = `${context.baseName}.chd`
      return singleFile(planChd(input, settings, work(name)), name)
    }
    case 'CSO':
    case 'CSOv2':
    case 'ZSO': {
      const name = `${context.baseName}${target === 'ZSO' ? '.zso' : '.cso'}`
      return singleFile(planCso(input, target, settings, work(name)), name)
    }
    case 'Extract':
      return planned(planExtract(input, settings, context.baseName))
    case 'Info':
      return planned({
        steps: [{ kind: 'tool', tool: 'chdman', args: ['info', '-i', INPUT], label: 'Reading CHD information', weight: 1, progress: { kind: 'none' } }],
        finalize: { kind: 'none' }
      })
    case 'Verify': {
      // Only v4 and later CHDs carry the overall SHA-1, which also covers the metadata.
      const lines = ['Raw SHA1 verification successful!']
      if ((input.chd?.version ?? 5) >= 4) lines.push('Overall SHA1 verification successful!')
      return planned({
        steps: [
          {
            kind: 'tool',
            tool: 'chdman',
            args: ['verify', '-i', INPUT],
            label: 'Verifying CHD',
            weight: 1,
            progress: { kind: 'chdman' },
            confirm: {
              lines,
              failure: 'The CHD failed verification',
              unsupported: { prefix: 'No verification to be done', message: 'This CHD cannot be verified' }
            }
          }
        ],
        finalize: { kind: 'none' }
      })
    }
  }
}
