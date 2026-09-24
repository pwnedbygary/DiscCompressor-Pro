import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isTargetAllowed, normalizeJobSettings, outputExtension, targetAvailability } from '@shared/formats'
import type {
  AppSettings,
  JobEvent,
  JobSettings,
  LogLevel,
  OverwritePolicy,
  RunJobRequest,
  ScannedInput,
  Target,
  ToolName,
  ToolsStatus
} from '@shared/types'
import { naturalCompare, scanInput } from '../scan'
import { processBytesRead } from './ioCounters'
import { convertTrackToIso } from './iso'
import { type IsoStep, type PathRef, type Plan, type ToolStep, planJob } from './plan'
import { updatePlaylist } from './playlist'
import { type RunningTool, formatCommand, startTool } from './process'
import { isChdmanNoise, parseChdmanProgress } from './progress'
import { WORK_DIR_PREFIX, type WorkDirRegistry } from './workDirs'

const POLL_INTERVAL_MS = 500

export interface RunnerDependencies {
  settings: () => AppSettings
  tools: (refresh: boolean) => Promise<ToolsStatus>
  emit: (event: JobEvent) => void
  trash: (path: string) => Promise<void>
  /**
   * Which of `files` queued or running jobs other than `jobId` still need, or
   * null when that cannot be found out. Without it only the jobs this runner
   * is running count.
   */
  filesInUse?: (query: { jobId: string; finishing: string[]; files: string[] }) => Promise<string[] | null>
  /** Records work directories so that they can be removed after a crash. */
  workDirs?: WorkDirRegistry
  /** Called whenever the number of running jobs changes. */
  onActiveChange?: (count: number) => void
}

/** An expected failure whose message is shown to the user as-is. */
class JobError extends Error {}

interface ActiveJob {
  controller: AbortController
  finished: Promise<void>
  /** Claim key of the image the job was started for. */
  source: string
  /** Claim keys of every file the job reads. */
  inputs: Set<string>
  /** Identities of those files (see `fileState`). */
  inputIds: Set<string>
  /** Claim keys of every file the job may write. */
  outputs: Set<string>
  /** Set once the job's tools have finished, after which it no longer reads its inputs. */
  finishing: boolean
}

interface JobContext {
  job: ActiveJob
  input: ScannedInput
  workDir: string
  signal: AbortSignal
  log: (level: LogLevel, message: string) => void
  progress: (fraction: number | null, stage: string) => void
}

type Blocker = 'own-input' | 'other-output' | 'other-input' | 'other-image'

const BLOCKER_MESSAGES: Record<Blocker, (name: string) => string> = {
  'own-input': (name) => `Refusing to replace ${name}, which this job is reading`,
  'other-output': (name) => `${name} is being written by another job`,
  'other-input': (name) => `${name} is being read by another job`,
  'other-image': (name) => `${name} was just created from a different image`
}

/**
 * Output names are claimed case-insensitively: that is right on Windows and
 * on the exFAT/FAT drives common for handheld collections, and at worst adds
 * an unneeded number on a case-sensitive file system.
 */
function claimKey(path: string): string {
  return resolve(path).toLowerCase()
}

interface FileState {
  exists: boolean
  /** Device and inode, which identify a file whatever name it is reached by; null when unknown. */
  id: string | null
}

async function fileState(path: string): Promise<FileState> {
  try {
    const { dev, ino } = await stat(path, { bigint: true })
    return { exists: true, id: ino === 0n ? null : `${dev}:${ino}` }
  } catch (error) {
    return { exists: (error as NodeJS.ErrnoException).code !== 'ENOENT', id: null }
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** rename(), retried briefly on Windows, where antivirus software or the indexer may hold a new file open. */
async function moveFile(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw error
      await sleep(100 * 2 ** attempt)
    }
  }
}

/**
 * maxcso's progress is measured from the bytes it reads (/proc/<pid>/io on
 * Linux). libuv 1.45+ may read files through io_uring, which that counter
 * does not see, so maxcso is asked to use its thread pool instead.
 */
function toolEnvironment(step: ToolStep): NodeJS.ProcessEnv {
  if (process.platform === 'linux' && step.progress.kind === 'read') return { ...process.env, UV_USE_IO_URING: '0' }
  return process.env
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

export class JobRunner {
  private readonly active = new Map<string, ActiveJob>()
  private readonly processes = new Set<RunningTool>()
  /** Files created since the app started, mapped to the claim key of the image each was made from. */
  private readonly producedBy = new Map<string, string>()
  /** Settles when the job currently deciding which originals to move to the trash is done. */
  private trashing: Promise<void> = Promise.resolve()
  private closing = false

  constructor(private readonly deps: RunnerDependencies) {}

  get activeCount(): number {
    return this.active.size
  }

  /**
   * Start a job. Progress is reported through `emit`; the final done, failed
   * or cancelled event is emitted only after temporary files are removed and
   * the job no longer counts as running.
   */
  start(request: RunJobRequest): void {
    if (this.closing) throw new Error('DiscCompressor Pro is closing')
    if (this.active.has(request.id)) throw new Error(`Job ${request.id} is already running`)
    const source = claimKey(request.inputPath)
    const job: ActiveJob = {
      controller: new AbortController(),
      finished: Promise.resolve(),
      source,
      inputs: new Set([source]),
      inputIds: new Set(),
      outputs: new Set(),
      finishing: false
    }
    this.active.set(request.id, job)
    this.deps.onActiveChange?.(this.active.size)
    job.finished = this.run(request, job).then((outcome) => {
      this.active.delete(request.id)
      this.deps.onActiveChange?.(this.active.size)
      this.deps.emit(outcome)
    })
  }

  cancel(id: string): void {
    this.active.get(id)?.controller.abort()
  }

  /** Cancel every running job and wait until their processes and temporary files are gone. */
  async cancelAll(): Promise<void> {
    while (this.active.size > 0) {
      const jobs = [...this.active.values()]
      for (const job of jobs) job.controller.abort()
      await Promise.allSettled(jobs.map((job) => job.finished))
    }
  }

  /** Refuse new jobs, then cancel the running ones. */
  async shutdown(): Promise<void> {
    this.closing = true
    await this.cancelAll()
  }

  /** Last resort when the app exits: kill any tool that is still running. */
  killAll(): void {
    for (const tool of this.processes) tool.kill(true)
  }

  /** Run a job to completion and return its final event. Never throws. */
  private async run(request: RunJobRequest, job: ActiveJob): Promise<JobEvent> {
    const { emit } = this.deps
    const { signal } = job.controller
    const log = (level: LogLevel, message: string): void => {
      emit({ type: 'log', jobId: request.id, level, message, time: Date.now() })
    }
    let workDir: string | null = null
    try {
      const input = await scanInput(request.inputPath)
      if (input.problem) throw new JobError(input.problem)
      if (!isTargetAllowed(input, request.target)) {
        const reason = targetAvailability(input).find((entry) => entry.target === request.target)?.reason
        throw new JobError(reason ?? `${request.target} is not possible for this image`)
      }
      for (const file of input.files) job.inputs.add(claimKey(file))
      const busy = input.files.find((file) => this.writtenByOther(file, job))
      if (busy) throw new JobError(BLOCKER_MESSAGES['other-output'](basename(busy)))
      const ids = await Promise.all(input.files.map(async (file) => (await fileState(file)).id))
      job.inputIds = new Set(ids.filter((id) => id !== null))

      const settings = normalizeJobSettings(request.settings)
      const appSettings = this.deps.settings()
      // A job the user asked to run again writes a new, numbered output instead of skipping the existing one.
      const policy: OverwritePolicy = appSettings.overwrite === 'skip' && request.rerun === true ? 'rename' : appSettings.overwrite
      const ext = outputExtension(input, request.target, settings)
      let baseName = basename(input.name, extname(input.name))
      let outputDir: string | null = null
      let plan: Plan
      let renamed = false

      if (ext) {
        outputDir = appSettings.outputMode === 'source' ? dirname(input.path) : appSettings.outputDirectory
        await mkdir(outputDir, { recursive: true })
        // chdman refuses track file names containing quotes in CUE/GDI sheets.
        if (ext === '.cue' || ext === '.gdi') baseName = baseName.replaceAll('"', "'")
        const claimed = await this.claimOutputs(job, outputDir, baseName, policy, (base) => this.plan(input, request.target, settings, base))
        if ('skip' in claimed) {
          log('warn', `Skipped ${input.name}: ${basename(claimed.skip)} already exists`)
          return { type: 'done', jobId: request.id, outputs: [claimed.skip], outputBytes: await sizeOf(claimed.skip), skipped: true }
        }
        plan = claimed.plan
        renamed = claimed.renamed
      } else {
        plan = this.plan(input, request.target, settings, baseName)
      }
      const tools = await this.requireTools(plan)

      signal.throwIfAborted()
      if (outputDir) {
        workDir = await mkdtemp(join(outputDir, WORK_DIR_PREFIX))
        await this.deps.workDirs?.add(workDir)
      }
      const context: JobContext = {
        job,
        input,
        workDir: workDir ?? tmpdir(),
        signal,
        log,
        progress: (fraction, stage) => emit({ type: 'progress', jobId: request.id, progress: fraction, stage })
      }

      log('info', `Started ${input.name} → ${ext ?? request.target}`)
      await this.execute(plan, tools, context)
      job.finishing = true
      const outputs = outputDir ? await this.finalize(plan, context, outputDir, policy) : []
      for (const output of outputs) this.producedBy.set(claimKey(output), job.source)
      const outputBytes = (await Promise.all(outputs.map(sizeOf))).reduce((sum, bytes) => sum + bytes, 0)

      if (outputs[0]) {
        const percent = input.size > 0 ? (outputBytes / input.size) * 100 : null
        const share = percent !== null && percent > 0 && percent < 0.1 ? 'under 0.1%' : `${percent?.toFixed(1)}%`
        const ratio = percent === null ? '' : ` (${share} of the original)`
        log('success', `Created ${basename(outputs[0])}: ${formatBytes(outputBytes)}${ratio}`)
        await this.afterSuccess(outputs, input, { jobId: request.id, job, renamed, policy }, log)
      } else {
        log('success', `Finished ${input.name}`)
      }
      return { type: 'done', jobId: request.id, outputs, outputBytes, skipped: false }
    } catch (error) {
      job.finishing = true
      if (signal.aborted) {
        log('warn', 'Cancelled')
        return { type: 'cancelled', jobId: request.id }
      }
      const message = error instanceof Error ? error.message : String(error)
      if (!(error instanceof JobError)) console.error(`Job ${request.id} failed`, error)
      log('error', message)
      return { type: 'failed', jobId: request.id, error: message }
    } finally {
      if (workDir) {
        const dir = workDir
        // A directory that cannot be removed now stays in the journal and is removed on the next start.
        await rm(dir, { recursive: true, force: true, maxRetries: 5 }).then(
          () => this.deps.workDirs?.remove(dir),
          () => undefined
        )
      }
    }
  }

  private plan(input: ScannedInput, target: Target, settings: JobSettings, baseName: string): Plan {
    const planned = planJob(input, target, settings, { baseName })
    if (!planned.ok) throw new JobError(planned.error)
    return planned.plan
  }

  /** Why `job` must not write `path`, if it must not. */
  private blocker(path: string, state: FileState, job: ActiveJob): Blocker | null {
    const key = claimKey(path)
    if (job.inputs.has(key) || (state.id !== null && job.inputIds.has(state.id))) return 'own-input'
    for (const other of this.active.values()) {
      if (other === job) continue
      if (other.outputs.has(key)) return 'other-output'
      if (other.inputs.has(key)) return 'other-input'
    }
    const producer = this.producedBy.get(key)
    return state.exists && producer !== undefined && producer !== job.source ? 'other-image' : null
  }

  private writtenByOther(path: string, job: ActiveJob): boolean {
    const key = claimKey(path)
    return [...this.active.values()].some((other) => other !== job && other.outputs.has(key))
  }

  private readByOther(path: string, job: ActiveJob): boolean {
    const key = claimKey(path)
    return [...this.active.values()].some((other) => other !== job && !other.finishing && other.inputs.has(key))
  }

  /**
   * Pick the output base name and claim every file the plan for it creates.
   * Existing files are replaced, skipped or kept (by numbering the new
   * output) according to the policy, but a number is always added when a
   * name belongs to another running job, to a file just made from a different
   * image, or to one of this job's inputs.
   */
  private async claimOutputs(
    job: ActiveJob,
    dir: string,
    base: string,
    policy: OverwritePolicy,
    planFor: (base: string) => Plan
  ): Promise<{ plan: Plan; renamed: boolean } | { skip: string }> {
    for (let n = 0; n < 10_000; n += 1) {
      const plan = planFor(n === 0 ? base : `${base} (${n})`)
      const paths = plan.outputs.map((name) => join(dir, name))
      const states = await Promise.all(paths.map(fileState))
      // Nothing is awaited from here on, so checking and claiming cannot interleave with another job.
      const blockers = paths.map((path, i) => this.blocker(path, states[i] as FileState, job))
      const [primary] = paths
      // A numbered name only counts as this image's existing output if this image made it earlier in this session.
      const ownName = primary !== undefined && (n === 0 || this.producedBy.get(claimKey(primary)) === job.source)
      if (primary && ownName && policy === 'skip' && states[0]?.exists && (blockers[0] === null || blockers[0] === 'other-input')) {
        return { skip: primary }
      }
      if (blockers.some((blocker) => blocker !== null)) continue
      if (policy !== 'overwrite' && states.some((state) => state.exists)) continue
      for (const path of paths) job.outputs.add(claimKey(path))
      return { plan, renamed: n > 0 }
    }
    throw new JobError('Could not find a free output file name')
  }

  /** Check a destination again right before moving a file there, claiming names the plan did not predict. */
  private async ensureWritable(path: string, job: ActiveJob, policy: OverwritePolicy): Promise<void> {
    const state = await fileState(path)
    const blocker = this.blocker(path, state, job)
    if (blocker) throw new JobError(BLOCKER_MESSAGES[blocker](basename(path)))
    if (state.exists && policy !== 'overwrite') throw new JobError(`${basename(path)} appeared in the output folder while the job was running`)
    job.outputs.add(claimKey(path))
  }

  private async requireTools(plan: Plan): Promise<ToolsStatus> {
    const needed = new Set<ToolName>(plan.steps.flatMap((step) => (step.kind === 'tool' ? [step.tool] : [])))
    const missing = (tools: ToolsStatus): ToolName[] => [...needed].filter((name) => !tools[name].path || tools[name].error)
    let tools = await this.deps.tools(false)
    if (missing(tools).length > 0) tools = await this.deps.tools(true)
    const [first] = missing(tools)
    if (first) throw new JobError(tools[first].error ?? `${first} was not found`)
    return tools
  }

  private resolve(ref: PathRef, context: JobContext): string {
    switch (ref.ref) {
      case 'input':
        return context.input.path
      case 'file':
        return ref.path
      case 'work':
        return join(context.workDir, ref.name)
    }
  }

  private async execute(plan: Plan, tools: ToolsStatus, context: JobContext): Promise<void> {
    const totalWeight = plan.steps.reduce((sum, step) => sum + step.weight, 0) || 1
    let completed = 0
    for (const step of plan.steps) {
      context.signal.throwIfAborted()
      const report = (fraction: number | null): void =>
        context.progress(fraction === null ? null : (completed + step.weight * fraction) / totalWeight, step.label)
      report(0)
      if (step.kind === 'tool') await this.runTool(step, tools, context, report)
      else await this.runIso(step, context, report)
      completed += step.weight
    }
  }

  private async runIso(step: IsoStep, context: JobContext, report: (fraction: number) => void): Promise<void> {
    const source = this.resolve(step.source, context)
    const destination = this.resolve(step.output, context)
    context.log('info', `Converting ${basename(source)} (${step.layout.sectorSize}-byte Mode ${step.layout.mode} sectors) to ISO`)
    await convertTrackToIso({ source, destination, layout: step.layout, signal: context.signal, onProgress: report })
  }

  private async runTool(step: ToolStep, tools: ToolsStatus, context: JobContext, report: (fraction: number | null) => void): Promise<void> {
    const executable = tools[step.tool].path as string
    const args = step.args.map((arg) => (typeof arg === 'string' ? arg : this.resolve(arg, context)))
    const total = await this.progressTotal(step, context)
    context.signal.throwIfAborted()
    context.log('info', `$ ${formatCommand(step.tool, args)}`)

    let lastError = ''
    let firstError = ''
    const printed = new Set<string>()
    const tool = startTool(
      executable,
      args,
      (line, stream) => {
        if (step.progress.kind === 'chdman') {
          const fraction = parseChdmanProgress(line)
          if (fraction !== null) return report(fraction)
          if (isChdmanNoise(line)) return
        }
        if (stream === 'stderr') {
          lastError = line
          if (!firstError && /^(Error|No verification)/.test(line)) firstError = line
        } else if (step.confirm) {
          printed.add(line)
        }
        context.log(stream === 'stderr' ? 'warn' : 'output', line)
      },
      toolEnvironment(step)
    )
    // Nothing may be awaited between starting the tool and awaiting its exit: a failed
    // spawn rejects `exited` right away, and a cancellation must reach the process.
    this.processes.add(tool)
    const abort = (): void => tool.kill()
    context.signal.addEventListener('abort', abort, { once: true })
    if (context.signal.aborted) tool.kill()
    const stopPolling = this.pollProgress(step, total, tool.pid, context, report)
    let exit
    try {
      exit = await tool.exited
    } catch (error) {
      throw new JobError(`Could not start ${step.tool} (${executable}): ${(error as Error).message}`)
    } finally {
      stopPolling()
      this.processes.delete(tool)
      context.signal.removeEventListener('abort', abort)
    }
    context.signal.throwIfAborted()
    if (exit.code !== 0) {
      const how = exit.code === null ? `was terminated by ${exit.signal ?? 'a signal'}` : `exited with code ${exit.code}`
      throw new JobError(`${step.tool} ${how}${lastError ? `: ${lastError}` : ''}`)
    }
    if (step.confirm && !step.confirm.lines.every((line) => printed.has(line))) {
      const detail = (firstError || lastError).replace(/^Error:\s*/, '')
      const { unsupported } = step.confirm
      if (unsupported && detail.startsWith(unsupported.prefix)) {
        throw new JobError(`${unsupported.message}: ${detail.slice(unsupported.prefix.length).replace(/^[;:\s]+/, '')}`)
      }
      throw new JobError(`${step.confirm.failure}: ${detail || `${step.tool} did not report a result`}`)
    }
    report(1)
  }

  /** The byte count that corresponds to 100% for tools whose progress is measured from outside. */
  private async progressTotal(step: ToolStep, context: JobContext): Promise<number> {
    const source = step.progress
    if (source.kind === 'read') return sizeOf(this.resolve(source.of, context))
    if (source.kind === 'output') return source.totalBytes
    return 0
  }

  /** Measure progress from bytes read or written; returns a function that stops measuring. */
  private pollProgress(
    step: ToolStep,
    total: number,
    pid: number | undefined,
    context: JobContext,
    report: (fraction: number | null) => void
  ): () => void {
    const source = step.progress
    if (source.kind === 'chdman') return () => undefined
    if (source.kind === 'none' || total <= 0 || (source.kind === 'read' && pid === undefined)) {
      report(null)
      return () => undefined
    }
    let stopped = false
    let busy = false
    const timer = setInterval(() => {
      if (busy) return
      busy = true
      const measure = source.kind === 'read' ? processBytesRead(pid as number) : sizeOf(this.resolve(source.file, context))
      void measure
        .then(
          (bytes) => {
            // A measurement that was in flight when the step ended must not report afterwards. Nothing
            // counted yet (or a system that does not count, such as Wine) shows as indeterminate.
            if (!stopped) report(bytes === null || bytes === 0 ? null : Math.min(bytes / total, 0.999))
          },
          () => undefined
        )
        .finally(() => {
          busy = false
        })
    }, POLL_INTERVAL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }

  /** Move finished files out of the work directory. Returns their final paths, primary output first. */
  private async finalize(plan: Plan, context: JobContext, outputDir: string, policy: OverwritePolicy): Promise<string[]> {
    const { finalize } = plan
    if (finalize.kind === 'none') return []
    if (finalize.kind === 'file') {
      const destination = join(outputDir, finalize.name)
      await this.ensureWritable(destination, context.job, policy)
      await moveFile(this.resolve(finalize.from, context), destination)
      return [destination]
    }
    const names = await readdir(context.workDir)
    if (!names.includes(finalize.sheet)) throw new JobError(`chdman did not create ${finalize.sheet}`)
    const tracks = names.filter((name) => name !== finalize.sheet).sort(naturalCompare)
    // The sheet goes last so that it never lists track files which are not in place.
    const order = [...tracks, finalize.sheet]
    for (const name of order) await this.ensureWritable(join(outputDir, name), context.job, policy)
    const moved: string[] = []
    try {
      for (const name of order) {
        await moveFile(join(context.workDir, name), join(outputDir, name))
        moved.push(name)
      }
    } catch (error) {
      // Take back what was already moved; the work directory is deleted afterwards.
      for (const name of moved) await rename(join(outputDir, name), join(context.workDir, name)).catch(() => undefined)
      throw error
    }
    return [finalize.sheet, ...tracks].map((name) => join(outputDir, name))
  }

  private async afterSuccess(
    outputs: string[],
    input: ScannedInput,
    { jobId, job, renamed, policy }: { jobId: string; job: ActiveJob; renamed: boolean; policy: OverwritePolicy },
    log: JobContext['log']
  ): Promise<void> {
    const settings = this.deps.settings()
    const [primary] = outputs
    // A numbered output duplicates a disc that already exists, so it stays out of the set's playlist.
    if (primary && settings.autoGenerateM3U && !renamed) {
      try {
        const playlist = await updatePlaylist(primary, policy === 'overwrite')
        if (playlist?.written) log('success', `Updated playlist ${basename(playlist.path)}`)
        else if (playlist) log('info', `Left ${basename(playlist.path)} unchanged because it lists other files`)
      } catch (error) {
        log('warn', `Could not write the playlist: ${(error as Error).message}`)
      }
    }
    if (!settings.deleteOriginals) return
    // Jobs decide one at a time, so that of several jobs converting the same image the last one moves it.
    await this.exclusively(async () => {
      const outputKeys = new Set(outputs.map(claimKey))
      const outputIds = new Set((await Promise.all(outputs.map(fileState))).flatMap((state) => (state.id ? [state.id] : [])))
      const folder = dirname(input.path)
      const candidates: string[] = []
      for (const file of input.files) {
        if (outputKeys.has(claimKey(file))) continue
        const { exists, id } = await fileState(file)
        // Gone already, e.g. moved by a job that converted the same image at the same time.
        if (!exists) continue
        if (id !== null && outputIds.has(id)) continue
        if (file !== input.path && !isInside(folder, file)) {
          log('warn', `Kept ${basename(file)} because it is outside the folder of ${input.name}`)
          continue
        }
        if (this.readByOther(file, job)) {
          log('info', `Kept ${basename(file)} because another job is still using it`)
          continue
        }
        candidates.push(file)
      }
      if (candidates.length === 0) return
      // Asked only now, so that jobs queued while this one ran count too.
      const finishing = [...this.active].flatMap(([id, other]) => (other.finishing ? [id] : []))
      const inUse = this.deps.filesInUse ? await this.deps.filesInUse({ jobId, finishing, files: candidates }).catch(() => null) : []
      if (inUse === null) {
        for (const file of candidates) log('warn', `Kept ${basename(file)} because it could not be checked whether queued jobs still need it`)
        return
      }
      const needed = new Set(inUse.map(claimKey))
      for (const file of candidates) {
        if (needed.has(claimKey(file))) {
          log('info', `Kept ${basename(file)} because another job in the queue still needs it`)
          continue
        }
        try {
          await this.deps.trash(file)
          log('info', `Moved ${basename(file)} to the trash`)
        } catch (error) {
          log('warn', `Could not move ${basename(file)} to the trash: ${(error as Error).message}`)
        }
      }
    })
  }

  /** Run `work` once every earlier call has finished. */
  private exclusively(work: () => Promise<void>): Promise<void> {
    const run = this.trashing.then(work)
    this.trashing = run.catch(() => undefined)
    return run
  }
}
