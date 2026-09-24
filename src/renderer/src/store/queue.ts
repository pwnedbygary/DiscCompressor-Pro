import { create } from 'zustand'
import { defaultTargetFor, isTargetAllowed, normalizeJobSettings } from '@shared/formats'
import type { JobEvent, JobSettings, ScannedInput, Target } from '@shared/types'
import { type Job, isFinished, outputSignature } from '../lib/jobs'

export interface NewJob {
  input: ScannedInput
  target?: Target | null
  settings?: JobSettings | null
}

export interface JobDefaults {
  target: Target
  settings: JobSettings
}

/**
 * How `add` recognises jobs that are already queued: by image path (files
 * dropped or picked), or by path, target and settings (imported queues,
 * which may deliberately contain the same image twice).
 */
export type Dedupe = 'path' | 'job'

interface QueueState {
  order: string[]
  jobs: Record<string, Job>
  selected: ReadonlySet<string>
  /** Where a Shift range selection starts. */
  anchor: string | null
  /** The row the keyboard is on. */
  focus: string | null
  /** Whether the queue is being processed. */
  running: boolean
  add: (entries: NewJob[], defaults: JobDefaults, dedupe?: Dedupe) => { added: number; duplicates: number }
  remove: (ids: string[]) => string[]
  duplicate: (ids: string[]) => void
  move: (ids: string[], toIndex: number) => void
  nudge: (ids: string[], delta: -1 | 1) => void
  setTarget: (ids: string[], target: Target) => { applied: number; skipped: number }
  updateSettings: (ids: string[], patch: Partial<JobSettings>) => void
  applyToAll: (sourceId: string) => { applied: number; requeued: number; targetSkipped: number }
  reset: (ids: string[]) => void
  clearFinished: () => void
  select: (id: string, options?: { toggle?: boolean; range?: boolean }) => void
  setSelection: (ids: string[], anchor: string | null, focus: string | null) => void
  moveFocus: (to: number | 'first' | 'last', extend: boolean) => string | null
  selectAll: () => void
  clearSelection: () => void
  applyEvents: (events: JobEvent[], requeue: ReadonlySet<string>) => void
  setRunning: (running: boolean) => void
}

function freshJob(input: ScannedInput, target: Target, settings: JobSettings): Job {
  return {
    id: crypto.randomUUID(),
    input,
    target,
    settings,
    status: input.problem ? 'failed' : 'queued',
    progress: null,
    stage: null,
    startedAt: null,
    finishedAt: null,
    error: input.problem,
    outputs: [],
    outputBytes: null,
    rerun: false
  }
}

/** Put a finished job back in the queue, dropping its previous result. */
function requeued(job: Job): Job {
  if (!isFinished(job.status) || job.input.problem) return job
  return { ...job, status: 'queued', progress: null, stage: null, startedAt: null, finishedAt: null, error: null, outputs: [], outputBytes: null, rerun: true }
}

/** Apply a new target and settings, requeueing a finished job only if its output would change. */
function edited(job: Job, target: Target, settings: JobSettings): Job {
  const before = outputSignature(job.input, job.target, job.settings)
  const next = { ...job, target, settings }
  return outputSignature(next.input, next.target, next.settings) === before ? next : requeued(next)
}

function jobKey(input: ScannedInput, target: Target, settings: JobSettings, dedupe: Dedupe): string {
  return dedupe === 'path' ? input.path : JSON.stringify([input.path, target, settings])
}

function range(order: string[], from: string, to: string): string[] {
  const [start, end] = [order.indexOf(from), order.indexOf(to)].sort((a, b) => a - b) as [number, number]
  return start < 0 ? [to] : order.slice(start, end + 1)
}

export const useQueue = create<QueueState>((set, get) => ({
  order: [],
  jobs: {},
  selected: new Set(),
  anchor: null,
  focus: null,
  running: false,

  add(entries, defaults, dedupe = 'path') {
    const { order, jobs } = get()
    const known = new Set(order.flatMap((id) => (jobs[id] ? [jobKey(jobs[id].input, jobs[id].target, jobs[id].settings, dedupe)] : [])))
    const added: Job[] = []
    let duplicates = 0
    for (const entry of entries) {
      const settings = normalizeJobSettings(entry.settings ?? defaults.settings)
      const target = entry.target && isTargetAllowed(entry.input, entry.target) ? entry.target : defaultTargetFor(entry.input, defaults.target)
      const key = jobKey(entry.input, target, settings, dedupe)
      if (known.has(key)) {
        duplicates += 1
        continue
      }
      known.add(key)
      added.push(freshJob(entry.input, target, settings))
    }
    const [first] = added
    if (first) {
      set((state) => ({
        order: [...state.order, ...added.map((job) => job.id)],
        jobs: { ...state.jobs, ...Object.fromEntries(added.map((job) => [job.id, job])) },
        selected: new Set([first.id]),
        anchor: first.id,
        focus: first.id
      }))
    }
    return { added: added.length, duplicates }
  },

  remove(ids) {
    const removing = new Set(ids)
    const running = ids.filter((id) => get().jobs[id]?.status === 'running')
    set((state) => {
      const jobs = { ...state.jobs }
      for (const id of removing) delete jobs[id]
      return {
        order: state.order.filter((id) => !removing.has(id)),
        jobs,
        selected: new Set([...state.selected].filter((id) => !removing.has(id))),
        anchor: state.anchor && removing.has(state.anchor) ? null : state.anchor,
        focus: state.focus && removing.has(state.focus) ? null : state.focus
      }
    })
    return running
  },

  duplicate(ids) {
    const { order, jobs } = get()
    const copies = new Map<string, Job>()
    for (const id of ids) {
      const job = jobs[id]
      if (job) copies.set(id, { ...freshJob(job.input, job.target, job.settings), rerun: true })
    }
    const first = order.map((id) => copies.get(id)).find(Boolean)
    if (!first) return
    set((state) => ({
      order: state.order.flatMap((id) => {
        const copy = copies.get(id)
        return copy ? [id, copy.id] : [id]
      }),
      jobs: { ...state.jobs, ...Object.fromEntries([...copies.values()].map((job) => [job.id, job])) },
      selected: new Set([...copies.values()].map((job) => job.id)),
      anchor: first.id,
      focus: first.id
    }))
  },

  move(ids, toIndex) {
    const moving = new Set(ids)
    const { order } = get()
    const kept = order.filter((id) => !moving.has(id))
    const insertAt = order.slice(0, toIndex).filter((id) => !moving.has(id)).length
    const moved = order.filter((id) => moving.has(id))
    const next = [...kept.slice(0, insertAt), ...moved, ...kept.slice(insertAt)]
    if (next.some((id, i) => id !== order[i])) set({ order: next })
  },

  nudge(ids, delta) {
    const moving = new Set(ids)
    const order = [...get().order]
    if (delta < 0) {
      for (let i = 1; i < order.length; i += 1) {
        if (moving.has(order[i] as string) && !moving.has(order[i - 1] as string)) {
          ;[order[i - 1], order[i]] = [order[i] as string, order[i - 1] as string]
        }
      }
    } else {
      for (let i = order.length - 2; i >= 0; i -= 1) {
        if (moving.has(order[i] as string) && !moving.has(order[i + 1] as string)) {
          ;[order[i], order[i + 1]] = [order[i + 1] as string, order[i] as string]
        }
      }
    }
    set({ order })
  },

  setTarget(ids, target) {
    let applied = 0
    let skipped = 0
    set((state) => {
      const jobs = { ...state.jobs }
      for (const id of ids) {
        const job = jobs[id]
        if (!job || job.status === 'running') continue
        if (!isTargetAllowed(job.input, target)) {
          skipped += 1
          continue
        }
        applied += 1
        if (job.target !== target) jobs[id] = edited(job, target, job.settings)
      }
      return { jobs }
    })
    return { applied, skipped }
  },

  updateSettings(ids, patch) {
    set((state) => {
      const jobs = { ...state.jobs }
      for (const id of ids) {
        const job = jobs[id]
        if (!job || job.status === 'running') continue
        jobs[id] = edited(job, job.target, normalizeJobSettings({ ...job.settings, ...patch }))
      }
      return { jobs }
    })
  },

  applyToAll(sourceId) {
    const source = get().jobs[sourceId]
    if (!source) return { applied: 0, requeued: 0, targetSkipped: 0 }
    let applied = 0
    let requeuedCount = 0
    let targetSkipped = 0
    set((state) => {
      const jobs = { ...state.jobs }
      for (const id of state.order) {
        const job = jobs[id]
        if (!job || id === sourceId || job.status === 'running') continue
        const targetOk = isTargetAllowed(job.input, source.target)
        if (!targetOk) targetSkipped += 1
        const next = edited(job, targetOk ? source.target : job.target, source.settings)
        if (isFinished(job.status) && next.status === 'queued') requeuedCount += 1
        jobs[id] = next
        applied += 1
      }
      return { jobs }
    })
    return { applied, requeued: requeuedCount, targetSkipped }
  },

  reset(ids) {
    set((state) => {
      const jobs = { ...state.jobs }
      for (const id of ids) {
        const job = jobs[id]
        if (job) jobs[id] = requeued(job)
      }
      return { jobs }
    })
  },

  clearFinished() {
    const { order, jobs } = get()
    get().remove(order.filter((id) => jobs[id]?.status === 'done' || jobs[id]?.status === 'skipped'))
  },

  select(id, options = {}) {
    const { order, selected, anchor } = get()
    if (options.range && anchor && order.includes(anchor)) {
      const span = range(order, anchor, id)
      set({ selected: new Set(options.toggle ? [...selected, ...span] : span), focus: id })
      return
    }
    if (options.toggle) {
      const next = new Set(selected)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      set({ selected: next, anchor: id, focus: id })
      return
    }
    set({ selected: new Set([id]), anchor: id, focus: id })
  },

  setSelection(ids, anchor, focus) {
    set({ selected: new Set(ids), anchor, focus })
  },

  moveFocus(to, extend) {
    const { order, focus, anchor } = get()
    if (order.length === 0) return null
    const current = focus ? order.indexOf(focus) : -1
    const index = to === 'first' ? 0 : to === 'last' ? order.length - 1 : current < 0 ? (to > 0 ? 0 : order.length - 1) : current + to
    const id = order[Math.min(Math.max(index, 0), order.length - 1)] as string
    if (extend) {
      const start = anchor && order.includes(anchor) ? anchor : id
      set({ selected: new Set(range(order, start, id)), anchor: start, focus: id })
    } else {
      set({ selected: new Set([id]), anchor: id, focus: id })
    }
    return id
  },

  selectAll() {
    set((state) => ({ selected: new Set(state.order), anchor: state.anchor ?? state.order[0] ?? null, focus: state.focus ?? state.order[0] ?? null }))
  },

  clearSelection() {
    set({ selected: new Set(), anchor: null })
  },

  applyEvents(events, requeue) {
    set((state) => {
      const jobs = { ...state.jobs }
      let changed = false
      const update = (id: string, patch: (job: Job) => Job): void => {
        const current = jobs[id]
        if (!current) return
        jobs[id] = patch(current)
        changed = true
      }
      const now = Date.now()
      for (const event of events) {
        switch (event.type) {
          case 'progress':
            update(event.jobId, (job) => (job.status === 'running' ? { ...job, progress: event.progress, stage: event.stage } : job))
            break
          case 'done':
            update(event.jobId, (job) => ({
              ...job,
              status: event.skipped ? 'skipped' : 'done',
              progress: 1,
              stage: null,
              finishedAt: now,
              outputs: event.outputs,
              outputBytes: event.outputBytes,
              error: null
            }))
            break
          case 'failed':
            update(event.jobId, (job) => ({ ...job, status: 'failed', stage: null, finishedAt: now, error: event.error }))
            break
          case 'cancelled':
            update(event.jobId, (job) =>
              requeue.has(job.id)
                ? { ...job, status: 'queued', progress: null, stage: null, startedAt: null }
                : { ...job, status: 'cancelled', stage: null, finishedAt: now }
            )
            break
          case 'log':
            break
        }
      }
      return changed ? { jobs } : {}
    })
  },

  setRunning(running) {
    set({ running })
  }
}))

/** Selected job ids in queue order. */
export function selectedInOrder(state: Pick<QueueState, 'order' | 'selected'>): string[] {
  return state.order.filter((id) => state.selected.has(id))
}

/** The job the inspector shows: the keyboard focus if selected, else the first selected job. */
export function primarySelection(state: Pick<QueueState, 'order' | 'selected' | 'focus' | 'anchor'>): string | undefined {
  if (state.focus && state.selected.has(state.focus)) return state.focus
  if (state.anchor && state.selected.has(state.anchor)) return state.anchor
  return state.order.find((id) => state.selected.has(id))
}

export function getJob(id: string): Job | undefined {
  return useQueue.getState().jobs[id]
}

export function markRunning(id: string): void {
  useQueue.setState((state) => {
    const job = state.jobs[id]
    if (!job) return {}
    return { jobs: { ...state.jobs, [id]: { ...job, status: 'running', progress: 0, stage: 'Starting', startedAt: Date.now(), finishedAt: null, error: null } } }
  })
}

export function markFailed(id: string, error: string): void {
  useQueue.setState((state) => {
    const job = state.jobs[id]
    if (!job) return {}
    return { jobs: { ...state.jobs, [id]: { ...job, status: 'failed', stage: null, finishedAt: Date.now(), error } } }
  })
}
