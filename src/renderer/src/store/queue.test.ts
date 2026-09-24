import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_JOB_SETTINGS } from '@shared/formats'
import type { ScannedInput } from '@shared/types'
import type { Job } from '../lib/jobs'
import { primarySelection, selectedInOrder, useQueue } from './queue'

function input(name: string, overrides: Partial<ScannedInput> = {}): ScannedInput {
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
    problem: null,
    ...overrides
  }
}

const defaults = { target: 'CHD' as const, settings: DEFAULT_JOB_SETTINGS }
const names = (): string[] => {
  const { order, jobs } = useQueue.getState()
  return order.map((id) => jobs[id]?.input.name ?? '?')
}
const idOf = (name: string): string => {
  const { order, jobs } = useQueue.getState()
  return order.find((id) => jobs[id]?.input.name === name) as string
}
const setStatus = (id: string, status: Job['status']): void => {
  useQueue.setState((s) => ({ jobs: { ...s.jobs, [id]: { ...(s.jobs[id] as Job), status, outputs: status === 'done' ? ['/out/x'] : [] } } }))
}

beforeEach(() => {
  useQueue.setState({ order: [], jobs: {}, selected: new Set(), anchor: null, focus: null, running: false })
  useQueue.getState().add(['A.iso', 'B.iso', 'C.iso', 'D.iso'].map((name) => ({ input: input(name) })), defaults)
})

describe('adding jobs', () => {
  it('skips images already in the queue and selects the first new one', () => {
    const result = useQueue.getState().add([{ input: input('B.iso') }, { input: input('E.iso') }], defaults)
    expect(result).toEqual({ added: 1, duplicates: 1 })
    expect(names()).toEqual(['A.iso', 'B.iso', 'C.iso', 'D.iso', 'E.iso'])
    expect(selectedInOrder(useQueue.getState())).toEqual([idOf('E.iso')])
    expect(useQueue.getState().focus).toBe(idOf('E.iso'))
  })

  it('keeps the same image with different settings when importing a queue', () => {
    const result = useQueue.getState().add([{ input: input('A.iso'), target: 'ZSO' }, { input: input('A.iso') }], defaults, 'job')
    expect(result).toEqual({ added: 1, duplicates: 1 })
    expect(names()).toEqual(['A.iso', 'B.iso', 'C.iso', 'D.iso', 'A.iso'])
  })

  it('marks images with problems as failed', () => {
    useQueue.getState().add([{ input: input('Bad.cue', { kind: 'cue', problem: 'Missing track file: x.bin' }) }], defaults)
    expect(useQueue.getState().jobs[idOf('Bad.cue')]).toMatchObject({ status: 'failed', error: 'Missing track file: x.bin' })
  })

  it('starts compressed images as extractions and falls back to an allowed target', () => {
    const chd = { version: 5, logicalBytes: 0, hunkBytes: 4096, unitBytes: 2048, codecs: ['zstd'], tracks: [], hasParent: false }
    useQueue.getState().add(
      [
        { input: input('Game.gdi', { kind: 'gdi', media: 'gdrom' }) },
        { input: input('Game.chd', { kind: 'chd', media: 'dvd', chd: { ...chd, media: 'dvd' } }) },
        { input: input('Drive.chd', { kind: 'chd', chd: { ...chd, media: 'hdd' } }) }
      ],
      { ...defaults, target: 'ZSO' }
    )
    const { jobs } = useQueue.getState()
    expect(jobs[idOf('Game.gdi')]?.target).toBe('CHD')
    expect(jobs[idOf('Game.chd')]?.target).toBe('Extract')
    expect(jobs[idOf('Drive.chd')]?.target).toBe('Info')
  })
})

describe('reordering', () => {
  it('moves a block of jobs to an insertion index', () => {
    useQueue.getState().move([idOf('A.iso'), idOf('B.iso')], 4)
    expect(names()).toEqual(['C.iso', 'D.iso', 'A.iso', 'B.iso'])
    useQueue.getState().move([idOf('B.iso')], 0)
    expect(names()).toEqual(['B.iso', 'C.iso', 'D.iso', 'A.iso'])
  })

  it('nudges selected jobs past unselected neighbours only', () => {
    useQueue.getState().nudge([idOf('B.iso'), idOf('D.iso')], -1)
    expect(names()).toEqual(['B.iso', 'A.iso', 'D.iso', 'C.iso'])
    useQueue.getState().nudge([idOf('B.iso'), idOf('A.iso')], -1)
    expect(names()).toEqual(['B.iso', 'A.iso', 'D.iso', 'C.iso'])
  })

  it('places duplicates after their originals and selects them', () => {
    useQueue.getState().duplicate([idOf('C.iso'), idOf('A.iso')])
    expect(names()).toEqual(['A.iso', 'A.iso', 'B.iso', 'C.iso', 'C.iso', 'D.iso'])
    const { order, selected, focus } = useQueue.getState()
    expect([...selected].sort()).toEqual([order[1], order[4]].sort())
    expect(focus).toBe(order[1])
  })
})

describe('selection', () => {
  it('supports replace, toggle and range selection', () => {
    const q = useQueue.getState()
    q.select(idOf('B.iso'))
    q.select(idOf('D.iso'), { range: true })
    expect(selectedInOrder(useQueue.getState())).toEqual([idOf('B.iso'), idOf('C.iso'), idOf('D.iso')])
    q.select(idOf('C.iso'), { toggle: true })
    expect(selectedInOrder(useQueue.getState())).toEqual([idOf('B.iso'), idOf('D.iso')])
  })

  it('moves the keyboard focus and extends the selection from the anchor', () => {
    const q = useQueue.getState()
    expect(q.moveFocus(1, false)).toBe(idOf('B.iso'))
    expect(q.moveFocus(1, true)).toBe(idOf('C.iso'))
    expect(selectedInOrder(useQueue.getState())).toEqual([idOf('B.iso'), idOf('C.iso')])
    q.moveFocus('last', true)
    expect(selectedInOrder(useQueue.getState())).toEqual([idOf('B.iso'), idOf('C.iso'), idOf('D.iso')])
    expect(q.moveFocus('first', false)).toBe(idOf('A.iso'))
    expect(q.moveFocus(-1, false)).toBe(idOf('A.iso'))
    expect(selectedInOrder(useQueue.getState())).toEqual([idOf('A.iso')])
  })

  it('shows the focused job in the inspector, or the first selected one', () => {
    const q = useQueue.getState()
    q.setSelection([idOf('B.iso'), idOf('C.iso')], idOf('B.iso'), idOf('C.iso'))
    expect(primarySelection(useQueue.getState())).toBe(idOf('C.iso'))
    q.select(idOf('C.iso'), { toggle: true })
    expect(primarySelection(useQueue.getState())).toBe(idOf('B.iso'))
    q.clearSelection()
    expect(primarySelection(useQueue.getState())).toBeUndefined()
  })

  it('forgets removed jobs', () => {
    const b = idOf('B.iso')
    useQueue.getState().select(b)
    useQueue.getState().remove([b])
    expect(useQueue.getState()).toMatchObject({ anchor: null, focus: null })
    expect(useQueue.getState().selected.size).toBe(0)
  })
})

describe('editing jobs', () => {
  it('applies a target only where the input allows it', () => {
    useQueue.getState().add([{ input: input('Disc.gdi', { kind: 'gdi', media: 'gdrom' }) }], defaults)
    const result = useQueue.getState().setTarget([idOf('A.iso'), idOf('Disc.gdi')], 'CSO')
    expect(result).toEqual({ applied: 1, skipped: 1 })
    expect(useQueue.getState().jobs[idOf('Disc.gdi')]?.target).toBe('CHD')
  })

  it('requeues finished jobs only when their output would change', () => {
    const id = idOf('A.iso')
    setStatus(id, 'done')
    const q = useQueue.getState()
    q.updateSettings([id], { threads: 4 })
    // An ISO becomes a DVD CHD by default, so CD codecs and CSO options do not affect it.
    q.updateSettings([id], { chdCodecsCd: ['cdzs'], csoBlockSize: 4096 })
    expect(useQueue.getState().jobs[id]).toMatchObject({ status: 'done', settings: { threads: 4, chdCodecsCd: ['cdzs'], csoBlockSize: 4096 } })
    q.updateSettings([id], { chdCodecsDvd: ['zstd'] })
    expect(useQueue.getState().jobs[id]).toMatchObject({ status: 'queued', outputs: [] })
  })

  it('marks jobs the user runs again, so that they write a new output instead of being skipped', () => {
    const q = useQueue.getState()
    expect(useQueue.getState().jobs[idOf('A.iso')]?.rerun).toBe(false)
    setStatus(idOf('A.iso'), 'done')
    q.reset([idOf('A.iso')])
    setStatus(idOf('B.iso'), 'skipped')
    q.updateSettings([idOf('B.iso')], { chdCodecsDvd: ['zstd'] })
    q.duplicate([idOf('C.iso')])
    const { order, jobs } = useQueue.getState()
    expect(order.map((id) => `${jobs[id]?.input.name}:${jobs[id]?.status}:${jobs[id]?.rerun}`)).toEqual([
      'A.iso:queued:true',
      'B.iso:queued:true',
      'C.iso:queued:false',
      'C.iso:queued:true',
      'D.iso:queued:false'
    ])
  })

  it('requeues a finished job when its format changes', () => {
    const id = idOf('B.iso')
    setStatus(id, 'failed')
    useQueue.getState().setTarget([id], 'CHD')
    expect(useQueue.getState().jobs[id]?.status).toBe('failed')
    useQueue.getState().setTarget([id], 'ZSO')
    expect(useQueue.getState().jobs[id]).toMatchObject({ status: 'queued', target: 'ZSO' })
  })

  it('never edits running jobs', () => {
    const id = idOf('B.iso')
    setStatus(id, 'running')
    useQueue.getState().setTarget([id], 'ZSO')
    useQueue.getState().updateSettings([id], { threads: 2 })
    expect(useQueue.getState().jobs[id]).toMatchObject({ target: 'CHD', settings: { threads: 0 } })
  })

  it('applies one job to the rest of the queue and reports what changed', () => {
    useQueue.getState().add([{ input: input('Disc.gdi', { kind: 'gdi', media: 'gdrom' }) }], defaults)
    const [a, b, c] = [idOf('A.iso'), idOf('B.iso'), idOf('C.iso')]
    setStatus(b, 'done')
    setStatus(c, 'running')
    useQueue.getState().setTarget([a], 'ZSO')
    useQueue.getState().updateSettings([a], { csoMode: 'max' })
    expect(useQueue.getState().applyToAll(a)).toEqual({ applied: 3, requeued: 1, targetSkipped: 1 })
    const { jobs } = useQueue.getState()
    expect(jobs[b]).toMatchObject({ status: 'queued', target: 'ZSO', settings: { csoMode: 'max' } })
    expect(jobs[c]).toMatchObject({ status: 'running', target: 'CHD' })
    expect(jobs[idOf('Disc.gdi')]).toMatchObject({ target: 'CHD', settings: { csoMode: 'max' } })
  })
})

describe('job events', () => {
  it('records results and returns stopped jobs to the queue', () => {
    const [a, b, c] = [idOf('A.iso'), idOf('B.iso'), idOf('C.iso')]
    for (const id of [a, b, c]) setStatus(id, 'running')
    useQueue.getState().applyEvents(
      [
        { type: 'progress', jobId: a, progress: 0.5, stage: 'Compressing' },
        { type: 'done', jobId: a, outputs: ['/out/A.chd'], outputBytes: 1024, skipped: false },
        { type: 'failed', jobId: b, error: 'boom' },
        { type: 'cancelled', jobId: c }
      ],
      new Set([c])
    )
    const { jobs } = useQueue.getState()
    expect(jobs[a]).toMatchObject({ status: 'done', progress: 1, outputBytes: 1024 })
    expect(jobs[b]).toMatchObject({ status: 'failed', error: 'boom' })
    expect(jobs[c]).toMatchObject({ status: 'queued', startedAt: null })
  })
})
