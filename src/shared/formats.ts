import type {
  CsoMethod,
  CsoMode,
  InputKind,
  IsoLayout,
  JobSettings,
  Media,
  ScannedInput,
  Target
} from './types'

export const INPUT_EXTENSIONS: Record<string, InputKind> = {
  '.cue': 'cue',
  '.gdi': 'gdi',
  '.iso': 'iso',
  '.chd': 'chd',
  '.cso': 'cso',
  '.zso': 'zso',
  '.dax': 'dax',
  '.cdi': 'cdi'
}

export const TARGETS: readonly Target[] = ['CHD', 'CSO', 'CSOv2', 'ZSO', 'Extract', 'Info', 'Verify']

export const TARGET_LABELS: Record<Target, string> = {
  CHD: 'CHD',
  CSO: 'CSO',
  CSOv2: 'CSO v2',
  ZSO: 'ZSO',
  Extract: 'Extract',
  Info: 'Info',
  Verify: 'Verify'
}

export interface CodecInfo {
  id: string
  name: string
}

// Codec tags from MAME's src/lib/util/chdcodec.h (chdman 0.289).
export const CD_CODECS: readonly CodecInfo[] = [
  { id: 'cdlz', name: 'LZMA' },
  { id: 'cdzl', name: 'Deflate' },
  { id: 'cdzs', name: 'Zstandard' },
  { id: 'cdfl', name: 'FLAC (audio)' }
]

export const DVD_CODECS: readonly CodecInfo[] = [
  { id: 'lzma', name: 'LZMA' },
  { id: 'zlib', name: 'Deflate' },
  { id: 'zstd', name: 'Zstandard' },
  { id: 'huff', name: 'Huffman' },
  { id: 'flac', name: 'FLAC' }
]

/** chdman stores at most four codecs per CHD and ignores any beyond that. */
export const MAX_CHD_CODECS = 4

// chdman's own defaults: createcd uses cdlz,cdzl,cdfl and createdvd uses the
// hard disk set lzma,zlib,huff,flac.
export const DEFAULT_CD_CODECS = ['cdlz', 'cdzl', 'cdfl']
export const DEFAULT_DVD_CODECS = ['lzma', 'zlib', 'huff', 'flac']

/** A CD CHD frame is 2352 bytes of sector data plus 96 bytes of subcode. */
export const CD_FRAME_BYTES = 2448
export const DVD_SECTOR_BYTES = 2048
export const CHD_HUNK_MIN = 16
export const CHD_HUNK_MAX = 1024 * 1024

/** 0 means "chdman default" (8 frames = 19,584 bytes for CD, 4,096 for DVD). */
export const CD_HUNK_OPTIONS = [0, 1, 2, 4, 8, 16, 32, 64].map((frames) => frames * CD_FRAME_BYTES)
export const DVD_HUNK_OPTIONS = [0, 2048, 4096, 8192, 16384, 32768, 65536, 131072]
export const CHD_DEFAULT_HUNK = { cd: 8 * CD_FRAME_BYTES, dvd: 2 * DVD_SECTOR_BYTES }

export interface CsoMethodInfo {
  id: CsoMethod
  name: string
  family: 'deflate' | 'lz4'
  description: string
}

export const CSO_METHODS: readonly CsoMethodInfo[] = [
  { id: 'zlib', name: 'zlib', family: 'deflate', description: 'Standard deflate' },
  { id: '7zdeflate', name: '7-Zip deflate', family: 'deflate', description: 'Slightly smaller deflate output' },
  { id: 'libdeflate', name: 'libdeflate', family: 'deflate', description: 'Fast, strong deflate' },
  { id: 'zopfli', name: 'Zopfli', family: 'deflate', description: 'Smallest deflate, very slow' },
  { id: 'lz4', name: 'LZ4', family: 'lz4', description: 'Standard LZ4, very fast to decompress' },
  { id: 'lz4brute', name: 'LZ4 HC', family: 'lz4', description: 'Tries several LZ4 HC levels per block, slow' }
]

export type CsoFormat = 'cso1' | 'cso2' | 'zso'

export const CSO_FORMAT_FOR_TARGET: Partial<Record<Target, CsoFormat>> = {
  CSO: 'cso1',
  CSOv2: 'cso2',
  ZSO: 'zso'
}

// maxcso 1.13.0 enables these per format when no method flags are given
// (cli/cli.cpp, validate_args): CSO v1 cannot hold LZ4 blocks and ZSO holds only LZ4.
const CSO_FAMILIES: Record<CsoFormat, readonly CsoMethodInfo['family'][]> = {
  cso1: ['deflate'],
  cso2: ['deflate', 'lz4'],
  zso: ['lz4']
}
const CSO_DEFAULT_METHODS: Record<CsoFormat, readonly CsoMethod[]> = {
  cso1: ['zlib', '7zdeflate', 'libdeflate'],
  cso2: ['zlib', '7zdeflate', 'libdeflate', 'lz4'],
  zso: ['lz4']
}

/** 0 lets maxcso pick 2048 bytes below 2 GiB and 16384 above. */
export const CSO_BLOCK_OPTIONS = [0, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144]
export const CSO_BLOCK_MIN = 2048
export const CSO_BLOCK_MAX = 0x40000

export function csoMethodsFor(format: CsoFormat): CsoMethodInfo[] {
  return CSO_METHODS.filter((method) => CSO_FAMILIES[format].includes(method.family))
}

export function csoDefaultMethods(format: CsoFormat): CsoMethod[] {
  return [...CSO_DEFAULT_METHODS[format]]
}

/**
 * maxcso runs its brute-force LZ4 pass inside the LZ4 HC trial (src/sector.cpp),
 * so "--no-lz4" would switch brute force off as well.
 */
export function csoMethodImplies(method: CsoMethod): CsoMethod | null {
  return method === 'lz4brute' ? 'lz4' : null
}

/** The methods maxcso will try for a format under a given mode. */
export function effectiveCsoMethods(format: CsoFormat, mode: CsoMode, custom: readonly CsoMethod[]): CsoMethod[] {
  const applicable = csoMethodsFor(format).map((method) => method.id)
  switch (mode) {
    case 'fast':
      return format === 'zso' ? ['lz4'] : format === 'cso2' ? ['zlib', 'lz4'] : ['zlib']
    case 'max':
      return applicable
    case 'custom': {
      const wanted = new Set(custom.flatMap((id) => [id, csoMethodImplies(id) ?? id]))
      const chosen = applicable.filter((id) => wanted.has(id))
      return chosen.length > 0 ? chosen : csoDefaultMethods(format)
    }
    default:
      return csoDefaultMethods(format)
  }
}

/** maxcso arguments selecting the compression methods for a format. */
export function csoMethodArgs(format: CsoFormat, mode: CsoMode, custom: readonly CsoMethod[]): string[] {
  if (mode === 'fast') return ['--fast']
  const wanted = new Set(effectiveCsoMethods(format, mode, custom))
  const defaults = new Set(CSO_DEFAULT_METHODS[format])
  const args: string[] = []
  for (const { id } of csoMethodsFor(format)) {
    if (wanted.has(id) && !defaults.has(id)) args.push(`--use-${id}`)
    else if (!wanted.has(id) && defaults.has(id)) args.push(`--no-${id}`)
  }
  return args
}

export const DEFAULT_JOB_SETTINGS: JobSettings = {
  chdMedia: 'dvd',
  chdCodecsCd: [...DEFAULT_CD_CODECS],
  chdCodecsDvd: [...DEFAULT_DVD_CODECS],
  chdHunkCd: 0,
  chdHunkDvd: 0,
  // v1 always passed --block=2048; many CSO readers only support that size.
  csoBlockSize: 2048,
  csoMode: 'default',
  csoMethods: csoDefaultMethods('cso2'),
  extractCd: 'cue',
  extractGd: 'gdi',
  threads: 0
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0
}

export function isValidChdHunk(bytes: number, unitBytes: number): boolean {
  return Number.isInteger(bytes) && bytes >= CHD_HUNK_MIN && bytes <= CHD_HUNK_MAX && bytes % unitBytes === 0
}

export function isValidCsoBlock(bytes: number): boolean {
  return Number.isInteger(bytes) && bytes >= CSO_BLOCK_MIN && bytes <= CSO_BLOCK_MAX && isPowerOfTwo(bytes)
}

function normalizeCodecs(value: unknown, valid: readonly CodecInfo[], fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const ids = new Set(valid.map((codec) => codec.id))
  const codecs = [...new Set(value.filter((id): id is string => typeof id === 'string' && ids.has(id)))]
  return codecs.length > 0 ? codecs.slice(0, MAX_CHD_CODECS) : [...fallback]
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/** Coerce untrusted or outdated settings into a valid JobSettings object. */
export function normalizeJobSettings(value: unknown): JobSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const d = DEFAULT_JOB_SETTINGS
  const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null)
  const hunkCd = int(raw.chdHunkCd)
  const hunkDvd = int(raw.chdHunkDvd)
  const block = int(raw.csoBlockSize)
  const threads = int(raw.threads)
  const methods = Array.isArray(raw.csoMethods)
    ? CSO_METHODS.map((m) => m.id).filter((id) => (raw.csoMethods as unknown[]).includes(id))
    : [...d.csoMethods]
  return {
    chdMedia: pick(raw.chdMedia, ['cd', 'dvd'], d.chdMedia),
    chdCodecsCd: normalizeCodecs(raw.chdCodecsCd, CD_CODECS, DEFAULT_CD_CODECS),
    chdCodecsDvd: normalizeCodecs(raw.chdCodecsDvd, DVD_CODECS, DEFAULT_DVD_CODECS),
    chdHunkCd: hunkCd === 0 || (hunkCd !== null && isValidChdHunk(hunkCd, CD_FRAME_BYTES)) ? hunkCd : d.chdHunkCd,
    chdHunkDvd:
      hunkDvd === 0 || (hunkDvd !== null && isValidChdHunk(hunkDvd, DVD_SECTOR_BYTES)) ? hunkDvd : d.chdHunkDvd,
    csoBlockSize: block === 0 || (block !== null && isValidCsoBlock(block)) ? block : d.csoBlockSize,
    csoMode: pick(raw.csoMode, ['fast', 'default', 'max', 'custom'], d.csoMode),
    csoMethods: methods.length > 0 ? methods : [...d.csoMethods],
    extractCd: pick(raw.extractCd, ['cue', 'iso', 'cdi'], d.extractCd),
    extractGd: pick(raw.extractGd, ['gdi', 'cue'], d.extractGd),
    threads: threads !== null && threads >= 0 && threads <= 1024 ? threads : d.threads
  }
}

export function isCompressedKind(kind: InputKind): boolean {
  return kind === 'chd' || kind === 'cso' || kind === 'zso' || kind === 'dax'
}

export interface TargetAvailability {
  target: Target
  allowed: boolean
  reason: string | null
}

const DISC_CHD_MEDIA = new Set(['cd', 'dvd', 'gdrom'])

const GDROM_ISO_REASON = 'GD-ROM images cannot be converted to an ISO-based format'
export const CDI_ISO_REASON = 'DiscJuggler images can only become a CHD or BIN/CUE'

function isoReason(input: ScannedInput): string | null {
  switch (input.kind) {
    case 'iso':
      return input.isoBlocker
    case 'cso':
    case 'zso':
    case 'dax':
      return null
    case 'gdi':
      return GDROM_ISO_REASON
    case 'cdi':
      return CDI_ISO_REASON
    case 'chd':
      if (input.chd?.media === 'dvd') return null
      if (input.chd?.media === 'gdrom') return GDROM_ISO_REASON
      break
    case 'cue':
      break
  }
  return input.isoLayout ? null : (input.isoBlocker ?? 'This image cannot be converted to ISO')
}

function availability(input: ScannedInput, target: Target): string | null {
  if (input.problem) return input.problem
  const discChd = input.kind === 'chd' && input.chd !== null && DISC_CHD_MEDIA.has(input.chd.media)
  switch (target) {
    case 'CHD':
      if (input.kind === 'chd') return discChd ? null : 'Only CD, DVD and GD-ROM CHDs can be recompressed'
      return null
    case 'CSO':
    case 'CSOv2':
    case 'ZSO':
      return isoReason(input)
    case 'Extract':
      if (input.kind === 'chd') return discChd ? null : 'Only CD, DVD and GD-ROM CHDs can be extracted'
      return isCompressedKind(input.kind) || input.kind === 'cdi' ? null : 'This image is already uncompressed'
    case 'Info':
      return input.kind === 'chd' ? null : 'Info is only available for CHD files'
    case 'Verify':
      if (input.kind !== 'chd') return 'Verify is only available for CHD files'
      // chdman only records checksums in compressed CHDs (the header parser reports those as "none").
      return input.chd && input.chd.codecs.length > 0 && input.chd.codecs.every((codec) => codec === 'none')
        ? 'Uncompressed CHDs have no checksums to verify'
        : null
  }
}

export function targetAvailability(input: ScannedInput): TargetAvailability[] {
  return TARGETS.map((target) => {
    const reason = availability(input, target)
    return { target, allowed: reason === null, reason }
  })
}

export function isTargetAllowed(input: ScannedInput, target: Target): boolean {
  return availability(input, target) === null
}

/** Compressed inputs default to extraction, as in v1; everything else to the preferred target. */
export function defaultTargetFor(input: ScannedInput, preferred: Target): Target {
  if (isCompressedKind(input.kind) && isTargetAllowed(input, 'Extract')) return 'Extract'
  if (isTargetAllowed(input, preferred)) return preferred
  return TARGETS.find((target) => isTargetAllowed(input, target)) ?? preferred
}

/** Physical media of the CHD a job would create. */
export function chdMediaFor(input: ScannedInput, settings: JobSettings): Media {
  if (input.kind === 'cue' || input.kind === 'cdi') return 'cd'
  if (input.kind === 'gdi') return 'gdrom'
  if (input.kind === 'chd' && input.chd && DISC_CHD_MEDIA.has(input.chd.media)) return input.chd.media as Media
  return settings.chdMedia
}

/** How a CD CHD is extracted: as asked, except that an ISO needs a disc layout that allows it (BIN/CUE otherwise). */
export function extractCdFormat(input: ScannedInput, settings: JobSettings): JobSettings['extractCd'] {
  if (settings.extractCd === 'iso') return input.isoLayout ? 'iso' : 'cue'
  return settings.extractCd
}

/**
 * Whether a CD has several tracks and ends with a data track, the shape of a
 * Dreamcast CD-R (whose data track is in a second session that CHD files do not record).
 */
export function endsWithDataTrack(input: ScannedInput): boolean {
  return input.tracks.length > 1 && input.tracks.at(-1)?.type !== 'AUDIO'
}

/** Primary output extension of a job, or null when it produces no file. */
export function outputExtension(input: ScannedInput, target: Target, settings: JobSettings): string | null {
  switch (target) {
    case 'CHD':
      return '.chd'
    case 'CSO':
    case 'CSOv2':
      return '.cso'
    case 'ZSO':
      return '.zso'
    case 'Extract':
      if (input.kind === 'cdi') return '.cue'
      if (input.kind !== 'chd') return '.iso'
      if (input.chd?.media === 'dvd') return '.iso'
      if (input.chd?.media === 'gdrom') return settings.extractGd === 'cue' ? '.cue' : '.gdi'
      return `.${extractCdFormat(input, settings)}`
    case 'Info':
    case 'Verify':
      return null
  }
}

/** Whether a target shrinks the image, which is what "space saved" counts. */
export function isCompressionTarget(target: Target): boolean {
  return target === 'CHD' || target === 'CSO' || target === 'CSOv2' || target === 'ZSO'
}

const CUE_ISO_LAYOUTS: Record<string, IsoLayout> = {
  'MODE1/2048': { sectorSize: 2048, mode: 1 },
  'MODE1/2352': { sectorSize: 2352, mode: 1 },
  'MODE2/2048': { sectorSize: 2048, mode: 2 },
  'MODE2/2336': { sectorSize: 2336, mode: 2 },
  'MODE2/2352': { sectorSize: 2352, mode: 2 },
  'CDI/2336': { sectorSize: 2336, mode: 2 },
  'CDI/2352': { sectorSize: 2352, mode: 2 }
}

// chdman track types (src/lib/util/cdrom.cpp) and the bytes per sector
// extractcd writes for each.
const CHD_ISO_LAYOUTS: Record<string, IsoLayout> = {
  MODE1: { sectorSize: 2048, mode: 1 },
  MODE1_RAW: { sectorSize: 2352, mode: 1 },
  MODE2: { sectorSize: 2336, mode: 2 },
  MODE2_FORM1: { sectorSize: 2048, mode: 2 },
  MODE2_FORM_MIX: { sectorSize: 2336, mode: 2 },
  MODE2_RAW: { sectorSize: 2352, mode: 2 }
}

export function isoLayoutForCueMode(mode: string): IsoLayout | null {
  return CUE_ISO_LAYOUTS[mode.toUpperCase()] ?? null
}

export function isoLayoutForChdTrack(type: string): IsoLayout | null {
  return CHD_ISO_LAYOUTS[type.toUpperCase()] ?? null
}
