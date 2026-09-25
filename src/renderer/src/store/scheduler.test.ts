import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_JOB_SETTINGS } from '@shared/formats'
import type { AppSettings, JobEvent, ScannedInput } from '@shared/types'
import { useLog } from './log'
import { markFailed, useQueue } from './queue'
import { filesInUse, handleJobEvents, removeJobs, startQueue, stopQueue, watchActivity, watchScheduler } from './scheduler'
import { useSettings } from './settings'
import { useToasts } from './toasts'

const env = vi.hoisted(() => {
  const env = {
    focused: true,
    notifications: [] as string[],
    api: {
      runJob: vi.fn((_request: { id: string; rerun?: boolean }) => Promise.resolve()),
      cancelJob: vi.fn((_id: string) => Promise.resolve()),
      setBusy: vi.fn((_busy: boolean) => undefined),
      setTaskbarProgress: vi.fn()
    }
  }
  vi.stubGlobal('window', { api: env.api })
  vi.stubGlobal('document', { hasFocus: () => env.focused })
  vi.stubGlobal(
    'Notification',
    class {
      constructor(_title: string, options: { body: string }) {
        env.notifications.push(options.body)
      }
    }
  )
  return env
})
const { api } = env

function input(name: string): ScannedInput {
  return {
    path: `/in/${name}`,
    name,
    kind: 'iso',
    size: 2048,
    files: [`/in/${name}`],
    media: null,
    tracks: [],
    isoLayout: null,
    isoBlocker: null,
    chd: null,
    ciso: null,
    cdi: null,
    problem: null
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const idOf = (name: string): string => {
  const { order, jobs } = useQueue.getState()
  return order.find((id) => jobs[id]?.input.name === name) as string
}
const status = (name: string): string | undefined => useQueue.getState().jobs[idOf(name)]?.status
const launched = (): string[] => api.runJob.mock.calls.map(([request]) => useQueue.getState().jobs[request.id]?.input.name ?? '?')
const done = (name: string): JobEvent => ({ type: 'done', jobId: idOf(name), outputs: [`/out/${name}`], outputBytes: 1024, skipped: false })
const messages = (): string[] => useLog.getState().entries.map((entry) => entry.message)
const setSettings = (patch: Partial<AppSettings>): void => {
  useSettings.setState((state) => ({ settings: { ...(state.settings as AppSettings), ...patch } }))
}

let unsubscribe: () => void = () => undefined

beforeEach(() => {
  vi.clearAllMocks()
  env.focused = true
  env.notifications.length = 0
  useLog.setState({ entries: [] })
  useToasts.setState({ toasts: [] })
  useSettings.setState({ settings: { maxConcurrentJobs: 1, notifyOnFinish: true } as AppSettings })
  useQueue.setState({ order: [], jobs: {}, selected: new Set(), anchor: null, focus: null, running: false })
  useQueue.getState().add(['A.iso', 'B.iso', 'C.iso'].map((name) => ({ input: input(name) })), { target: 'CHD', settings: DEFAULT_JOB_SETTINGS })
  const unsubscribers = [watchScheduler(), watchActivity()]
  unsubscribe = () => {
    for (const stop of unsubscribers) stop()
  }
})

afterEach(() => unsubscribe())

describe('running the queue', () => {
  it('fills free slots as jobs finish and reports the result', async () => {
    setSettings({ maxConcurrentJobs: 2 })
    startQueue()
    expect(launched()).toEqual(['A.iso', 'B.iso'])
    expect(api.setBusy).toHaveBeenLastCalledWith(true)

    handleJobEvents([done('A.iso')])
    await flush()
    expect(launched()).toEqual(['A.iso', 'B.iso', 'C.iso'])

    handleJobEvents([done('B.iso'), { type: 'failed', jobId: idOf('C.iso'), error: 'boom' }])
    await flush()
    expect(useQueue.getState().running).toBe(false)
    expect(messages()).toContain('Queue finished: 2 finished, 1 failed')
    expect(useToasts.getState().toasts.map((toast) => toast.title)).toEqual(['Queue finished'])
    expect(api.setBusy).toHaveBeenLastCalledWith(false)
    expect(env.notifications).toEqual([])
  })

  it('starts more jobs when the limit is raised mid-run', async () => {
    startQueue()
    expect(launched()).toEqual(['A.iso'])
    setSettings({ maxConcurrentJobs: 3 })
    await flush()
    expect(launched()).toEqual(['A.iso', 'B.iso', 'C.iso'])
    handleJobEvents(['A.iso', 'B.iso', 'C.iso'].map(done))
    await flush()
    expect(messages()).toContain('Queue finished: 3 finished')
  })

  it('notifies when the queue finishes in the background', async () => {
    env.focused = false
    removeJobs([idOf('B.iso'), idOf('C.iso')])
    startQueue()
    handleJobEvents([done('A.iso')])
    await flush()
    expect(env.notifications).toEqual(['Queue finished: 1 finished'])
  })

  it('marks a job failed when it cannot be started and moves on', async () => {
    api.runJob.mockRejectedValueOnce(new Error("Error invoking remote method 'jobs:run': Error: chdman was not found"))
    startQueue()
    await flush()
    expect(useQueue.getState().jobs[idOf('A.iso')]).toMatchObject({ status: 'failed', error: 'chdman was not found' })
    expect(launched()).toEqual(['A.iso', 'B.iso'])
    handleJobEvents([done('B.iso')])
    await flush()
    expect(launched()).toEqual(['A.iso', 'B.iso', 'C.iso'])
    handleJobEvents([done('C.iso')])
    await flush()
    expect(messages()).toContain('Queue finished: 2 finished, 1 failed')
  })

  it('tells the main process which jobs the user asked to run again', () => {
    setSettings({ maxConcurrentJobs: 2 })
    removeJobs([idOf('B.iso'), idOf('C.iso')])
    useQueue.getState().duplicate([idOf('A.iso')])
    startQueue()
    expect(api.runJob.mock.calls.map(([request]) => request.rerun)).toEqual([false, true])
    handleJobEvents(useQueue.getState().order.map((id): JobEvent => ({ type: 'done', jobId: id, outputs: [], outputBytes: 0, skipped: false })))
  })

  it('does nothing when no job is queued', () => {
    removeJobs(useQueue.getState().order)
    startQueue()
    expect(useQueue.getState().running).toBe(false)
    expect(useToasts.getState().toasts.map((toast) => toast.title)).toEqual(['Nothing to process'])
  })
})

describe('telling the main process which originals other jobs still need', () => {
  const A = '/in/A.iso'
  /** What the main process is told when `id` finishes (and is the only job finishing). */
  const neededWhenDone = (id: string, finishing = [id], files = [A]): string[] => filesInUse({ requestId: 1, jobId: id, finishing, files })
  const finish = async (id: string): Promise<void> => {
    handleJobEvents([{ type: 'done', jobId: id, outputs: [], outputBytes: 0, skipped: false }])
    await flush()
  }
  const copyOfA = (): [string, string] => {
    removeJobs([idOf('B.iso'), idOf('C.iso')])
    useQueue.getState().duplicate([idOf('A.iso')])
    return useQueue.getState().order as [string, string]
  }

  it('keeps an image for a copy of the job added while it runs', async () => {
    removeJobs([idOf('B.iso'), idOf('C.iso')])
    startQueue()
    useQueue.getState().duplicate([idOf('A.iso')])
    const [first, copy] = useQueue.getState().order as [string, string]
    expect(neededWhenDone(first)).toEqual([A])
    await finish(first)
    expect(useQueue.getState().jobs[copy]?.status).toBe('running')
    expect(neededWhenDone(copy)).toEqual([])
  })

  it('leaves an image converted by two jobs at once to the one that finishes last', async () => {
    setSettings({ maxConcurrentJobs: 2 })
    const [first, copy] = copyOfA()
    startQueue()
    expect(launched()).toEqual(['A.iso', 'A.iso'])
    expect(neededWhenDone(first)).toEqual([A])
    await finish(first)
    expect(neededWhenDone(copy)).toEqual([])
  })

  it('keeps an image while a queued job still needs it', async () => {
    const [first, copy] = copyOfA()
    startQueue()
    expect(launched()).toEqual(['A.iso'])
    expect(neededWhenDone(first)).toEqual([A])
    await finish(first)
    expect(neededWhenDone(copy)).toEqual([])
  })

  it('keeps an image for a job that "Stop queue" cancelled, which runs again later', async () => {
    setSettings({ maxConcurrentJobs: 2 })
    const [first, copy] = copyOfA()
    startQueue()
    stopQueue()
    // The first job had already converted the image; the copy is being cancelled and returns to the queue.
    expect(neededWhenDone(first, [first, copy])).toEqual([A])
    handleJobEvents([{ type: 'cancelled', jobId: copy }])
    await flush()
    expect(useQueue.getState().jobs[copy]?.status).toBe('queued')
    expect(neededWhenDone(first)).toEqual([A])
    await finish(first)
  })

  it('ignores jobs that have finished their work and only answers for the files asked about', () => {
    setSettings({ maxConcurrentJobs: 2 })
    const [first, copy] = copyOfA()
    startQueue()
    expect(neededWhenDone(first, [first, copy])).toEqual([])
    expect(neededWhenDone(first, [first], ['/in/other.iso', '/IN/a.ISO'])).toEqual(['/IN/a.ISO'])
  })

  it('does not count finished or failed jobs, which only run again when asked to', () => {
    const [first, copy] = copyOfA()
    markFailed(copy, 'boom')
    expect(neededWhenDone(first)).toEqual([])
  })
})

describe('stopping the queue', () => {
  it('returns stopped jobs to the queue without a summary', async () => {
    setSettings({ maxConcurrentJobs: 2 })
    startQueue()
    stopQueue()
    expect(api.cancelJob.mock.calls.map(([id]) => id)).toEqual([idOf('A.iso'), idOf('B.iso')])
    expect(useQueue.getState().running).toBe(false)

    handleJobEvents([{ type: 'cancelled', jobId: idOf('A.iso') }])
    await flush()
    expect(messages()).not.toContain('Queue stopped')
    handleJobEvents([{ type: 'cancelled', jobId: idOf('B.iso') }])
    await flush()
    expect([status('A.iso'), status('B.iso'), status('C.iso')]).toEqual(['queued', 'queued', 'queued'])
    expect(messages()).toEqual(['Queue started', 'Stopping the queue…', 'Queue stopped'])
    expect(useToasts.getState().toasts).toEqual([])
    expect(api.setBusy).toHaveBeenLastCalledWith(false)
  })

  it('can be restarted before the stopped jobs have exited', async () => {
    startQueue()
    stopQueue()
    startQueue()
    expect(launched()).toEqual(['A.iso'])
    handleJobEvents([{ type: 'cancelled', jobId: idOf('A.iso') }])
    await flush()
    expect(launched()).toEqual(['A.iso', 'A.iso'])
    expect(status('A.iso')).toBe('running')
    handleJobEvents([done('A.iso')])
    await flush()
    handleJobEvents([done('B.iso')])
    await flush()
    handleJobEvents([done('C.iso')])
    await flush()
    expect(messages()).toContain('Queue finished: 3 finished')
  })

  it('cancels a removed running job', () => {
    startQueue()
    removeJobs([idOf('A.iso')])
    expect(api.cancelJob).toHaveBeenCalledTimes(1)
    expect(useQueue.getState().order).toHaveLength(2)
  })
})
