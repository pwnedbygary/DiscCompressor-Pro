import type { JobEvent, TaskbarProgress } from '@shared/types'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { isFinished } from '../lib/jobs'
import { log, useLog } from './log'
import { getJob, markFailed, markRunning, useQueue } from './queue'
import { useSettings } from './settings'
import { toast } from './toasts'

/** Jobs cancelled by "Stop queue"; they return to the queue instead of being marked cancelled. */
const stopping = new Set<string>()
let runStartedAt = 0

function counts(): { queued: number; running: number } {
  const { order, jobs } = useQueue.getState()
  let queued = 0
  let running = 0
  for (const id of order) {
    const status = jobs[id]?.status
    if (status === 'queued') queued += 1
    else if (status === 'running') running += 1
  }
  return { queued, running }
}

/** Whether another queued or running job reads any of this job's files, so they must not go to the trash yet. */
function inputsNeededElsewhere(id: string): boolean {
  const { order, jobs } = useQueue.getState()
  const job = jobs[id]
  if (!job) return false
  const key = (path: string): string => (api.platform === 'win32' ? path.toLowerCase() : path)
  const files = new Set(job.input.files.map(key))
  return order.some((otherId) => {
    const other = jobs[otherId]
    if (otherId === id || !other || (other.status !== 'queued' && other.status !== 'running')) return false
    return other.input.files.some((file) => files.has(key(file)))
  })
}

function launch(id: string): void {
  const job = getJob(id)
  if (!job) return
  const keepOriginals = inputsNeededElsewhere(id)
  markRunning(id)
  api.runJob({ id, inputPath: job.input.path, target: job.target, settings: job.settings, keepOriginals }).catch((error: unknown) => {
    stopping.delete(id)
    const message = errorMessage(error)
    markFailed(id, message)
    log('error', message, job.input.name)
  })
}

function finishRun(): void {
  useQueue.getState().setRunning(false)
  const { order, jobs } = useQueue.getState()
  let done = 0
  let failed = 0
  let cancelled = 0
  for (const id of order) {
    const job = jobs[id]
    if (!job?.finishedAt || job.finishedAt < runStartedAt) continue
    if (job.status === 'done' || job.status === 'skipped') done += 1
    else if (job.status === 'failed') failed += 1
    else if (job.status === 'cancelled') cancelled += 1
  }
  if (done + failed + cancelled === 0) {
    log('warn', 'Queue stopped')
    return
  }
  const summary = [`${done} finished`, failed > 0 && `${failed} failed`, cancelled > 0 && `${cancelled} cancelled`].filter(Boolean).join(', ')
  log(failed > 0 ? 'warn' : 'success', `Queue finished: ${summary}`)
  toast(failed > 0 ? 'warning' : 'success', 'Queue finished', summary)
  if (useSettings.getState().settings?.notifyOnFinish && !document.hasFocus()) {
    new Notification('DiscCompressor Pro', { body: `Queue finished: ${summary}` })
  }
}

/** Start queued jobs until the concurrency limit is reached; finish the run when nothing is left. */
export function pump(): void {
  const state = useQueue.getState()
  if (!state.running) return
  const limit = useSettings.getState().settings?.maxConcurrentJobs ?? 1
  let { running } = counts()
  for (const id of state.order) {
    if (running >= limit) break
    if (state.jobs[id]?.status === 'queued') {
      launch(id)
      running += 1
    }
  }
  const after = counts()
  if (after.running === 0 && after.queued === 0 && stopping.size === 0) finishRun()
}

/** Keep the queue moving whenever jobs change or the concurrency limit is raised. */
export function watchScheduler(): () => void {
  let scheduled = false
  const schedule = (): void => {
    if (scheduled || !useQueue.getState().running) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      pump()
    })
  }
  const unsubscribers = [useQueue.subscribe(schedule), useSettings.subscribe(schedule)]
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}

export function startQueue(): void {
  const state = useQueue.getState()
  if (state.running) return
  if (counts().queued === 0 && stopping.size === 0) {
    toast('info', 'Nothing to process', 'Add disc images or retry finished jobs first.')
    return
  }
  runStartedAt = Date.now()
  state.setRunning(true)
  log('info', 'Queue started')
  pump()
}

export function stopQueue(): void {
  const { running, order, jobs, setRunning } = useQueue.getState()
  if (!running) return
  setRunning(false)
  const active = order.filter((id) => jobs[id]?.status === 'running')
  for (const id of active) {
    stopping.add(id)
    void api.cancelJob(id)
  }
  log('warn', active.length > 0 ? 'Stopping the queue…' : 'Queue stopped')
}

/** Cancel one running job; it is marked cancelled and the queue moves on. */
export function cancelJob(id: string): void {
  void api.cancelJob(id)
}

export function removeJobs(ids: string[]): void {
  for (const id of useQueue.getState().remove(ids)) {
    stopping.delete(id)
    void api.cancelJob(id)
  }
}

export function handleJobEvents(events: JobEvent[]): void {
  const { jobs } = useQueue.getState()
  useLog.getState().append(
    events.flatMap((event) =>
      event.type === 'log'
        ? [{ time: event.time, level: event.level, message: event.message, source: event.jobId ? (jobs[event.jobId]?.input.name ?? null) : null }]
        : []
    )
  )
  useQueue.getState().applyEvents(events, stopping)
  let stoppedOne = false
  for (const event of events) {
    if (event.type === 'done' || event.type === 'failed' || event.type === 'cancelled') {
      stoppedOne ||= stopping.delete(event.jobId)
    }
  }
  if (stoppedOne && !useQueue.getState().running && stopping.size === 0 && counts().running === 0) log('warn', 'Queue stopped')
}

/** Mirror queue activity to the taskbar and the sleep blocker. */
export function watchActivity(): () => void {
  let lastBusy = false
  let lastProgress = -1
  let lastMode: TaskbarProgress['mode'] = 'none'
  return useQueue.subscribe((state) => {
    let total = 0
    let done = 0
    let active = false
    let indeterminate = false
    for (const id of state.order) {
      const job = state.jobs[id]
      if (!job) continue
      const weight = Math.max(job.input.size, 1)
      if (job.status === 'running') {
        active = true
        total += weight
        if (job.progress === null) indeterminate = true
        else done += weight * job.progress
      } else if (job.status === 'queued' && state.running) {
        total += weight
      } else if (state.running && isFinished(job.status) && job.finishedAt && job.finishedAt >= runStartedAt) {
        total += weight
        done += weight
      }
    }
    // Stay busy between consecutive jobs so the sleep blocker is not restarted each time.
    const busy = active || state.running
    if (busy !== lastBusy) {
      lastBusy = busy
      api.setBusy(busy)
    }
    const mode: TaskbarProgress['mode'] = !busy ? 'none' : indeterminate && done === 0 ? 'indeterminate' : 'normal'
    const progress = total > 0 ? done / total : 0
    if (mode !== lastMode || Math.abs(progress - lastProgress) >= 0.005) {
      lastMode = mode
      lastProgress = progress
      api.setTaskbarProgress({ mode, progress })
    }
  })
}
