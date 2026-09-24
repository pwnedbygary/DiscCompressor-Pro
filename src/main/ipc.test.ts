import { describe, expect, it, vi } from 'vitest'
import type { JobEvent } from '@shared/types'
import { JobEventBatcher, rendererSettingsPatch } from './ipc'

vi.mock('electron', () => ({ app: { isPackaged: true }, dialog: {}, ipcMain: {}, shell: {}, BrowserWindow: class {}, nativeTheme: {}, screen: {}, net: {}, protocol: {} }))

describe('rendererSettingsPatch', () => {
  it('lets the renderer clear tool paths but not point them at another program', () => {
    expect(rendererSettingsPatch({ chdmanPath: '/bin/sh', maxcsoPath: '', themeId: 'nord' })).toEqual({ maxcsoPath: '', themeId: 'nord' })
    expect(rendererSettingsPatch(null)).toEqual({})
  })
})

describe('JobEventBatcher', () => {
  it('keeps only the newest progress per job without moving it ahead of earlier events', () => {
    vi.useFakeTimers()
    const sent: JobEvent[][] = []
    const batcher = new JobEventBatcher((events) => sent.push(events))
    const log: JobEvent = { type: 'log', jobId: 'a', level: 'info', message: 'hello', time: 0 }
    batcher.push({ type: 'progress', jobId: 'a', progress: 0.1, stage: 'x' })
    batcher.push(log)
    batcher.push({ type: 'progress', jobId: 'a', progress: 0.2, stage: 'x' })
    batcher.push({ type: 'progress', jobId: 'b', progress: 0.5, stage: 'y' })
    vi.advanceTimersByTime(100)
    expect(sent).toEqual([
      [log, { type: 'progress', jobId: 'a', progress: 0.2, stage: 'x' }, { type: 'progress', jobId: 'b', progress: 0.5, stage: 'y' }]
    ])
    vi.useRealTimers()
  })
})
