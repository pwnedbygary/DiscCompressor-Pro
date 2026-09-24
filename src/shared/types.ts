export type InputKind = 'cue' | 'gdi' | 'iso' | 'chd' | 'cso' | 'zso' | 'dax'

/** What a job does. The names match the queue files exported by v1. */
export type Target = 'CHD' | 'CSO' | 'CSOv2' | 'ZSO' | 'Extract' | 'Info' | 'Verify'

export type Media = 'cd' | 'dvd' | 'gdrom'

export type ChdMediaChoice = 'cd' | 'dvd'

export type CsoMode = 'fast' | 'default' | 'max' | 'custom'

export type CsoMethod = 'zlib' | 'zopfli' | '7zdeflate' | 'libdeflate' | 'lz4' | 'lz4brute'

export interface JobSettings {
  /** CD or DVD CHD when the input does not determine it (ISO, CSO, ZSO, DAX). */
  chdMedia: ChdMediaChoice
  chdCodecsCd: string[]
  chdCodecsDvd: string[]
  /** Hunk size in bytes; 0 keeps chdman's default. */
  chdHunkCd: number
  chdHunkDvd: number
  /** maxcso block size in bytes; 0 keeps maxcso's size-based default. */
  csoBlockSize: number
  csoMode: CsoMode
  csoMethods: CsoMethod[]
  extractCd: 'cue' | 'iso'
  extractGd: 'gdi' | 'cue'
  /** 0 lets the tool use every core. */
  threads: number
}

export type OutputMode = 'directory' | 'source'
export type OverwritePolicy = 'overwrite' | 'skip' | 'rename'

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

export interface AppSettings {
  outputMode: OutputMode
  outputDirectory: string
  overwrite: OverwritePolicy
  defaultTarget: Target
  jobDefaults: JobSettings
  themeId: string
  deleteOriginals: boolean
  autoGenerateM3U: boolean
  minimizeToTray: boolean
  notifyOnFinish: boolean
  maxConcurrentJobs: number
  chdmanPath: string
  maxcsoPath: string
  window: WindowState | null
}

export interface TrackInfo {
  number: number
  /** chdman track type, e.g. MODE1, MODE1_RAW, MODE2_RAW, AUDIO. */
  type: string
  /** Bytes per sector as stored in the track file (or extracted by chdman). */
  sectorSize: number
  frames?: number
  file?: string
}

/** How a single data track maps onto 2048-byte ISO sectors. */
export interface IsoLayout {
  sectorSize: 2048 | 2336 | 2352
  mode: 1 | 2
}

export interface ChdInfo {
  version: number
  logicalBytes: number
  hunkBytes: number
  unitBytes: number
  codecs: string[]
  media: Media | 'hdd' | 'av' | 'raw'
  tracks: TrackInfo[]
  hasParent: boolean
}

export interface CisoInfo {
  format: 'cso1' | 'cso2' | 'zso' | 'dax'
  uncompressedBytes: number
  blockSize: number
}

export interface ScannedInput {
  path: string
  name: string
  kind: InputKind
  /** Bytes on disk, including every track file a CUE/GDI sheet references. */
  size: number
  /** Every file that makes up the image (the sheet and its track files). */
  files: string[]
  media: Media | null
  tracks: TrackInfo[]
  isoLayout: IsoLayout | null
  /** Why the image cannot become an ISO, when that is the case. */
  isoBlocker: string | null
  chd: ChdInfo | null
  ciso: CisoInfo | null
  /** A problem that makes the image unusable, e.g. a missing track file. */
  problem: string | null
}

export interface ScanResult {
  inputs: ScannedInput[]
  skipped: { path: string; reason: string }[]
}

export type ToolName = 'chdman' | 'maxcso'

export interface ToolStatus {
  name: ToolName
  path: string | null
  source: 'custom' | 'bundled' | 'system' | null
  version: string | null
  error: string | null
}

export interface ToolsStatus {
  chdman: ToolStatus
  maxcso: ToolStatus
}

export interface SystemInfo {
  platform: string
  arch: string
  cpuCount: number
  homeDir: string
}

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'output'

export interface RunJobRequest {
  id: string
  inputPath: string
  target: Target
  settings: JobSettings
  /** Never move the input to the trash, because other jobs in the queue still need it. */
  keepOriginals?: boolean
}

export type JobEvent =
  | { type: 'progress'; jobId: string; progress: number | null; stage: string }
  | { type: 'log'; jobId: string | null; level: LogLevel; message: string; time: number }
  | { type: 'done'; jobId: string; outputs: string[]; outputBytes: number; skipped: boolean }
  | { type: 'failed'; jobId: string; error: string }
  | { type: 'cancelled'; jobId: string }

export interface TaskbarProgress {
  mode: 'none' | 'normal' | 'indeterminate' | 'error' | 'paused'
  progress: number
}

export type AppCommand = 'open-settings' | 'start-queue' | 'stop-queue'
