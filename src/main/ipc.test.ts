import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/api'
import type { JobEvent } from '@shared/types'
import { JobEventBatcher, registerIpc, rendererSettingsPatch } from './ipc'
import type { JobRunner } from './jobs/runner'
import type { SettingsStore } from './settings'
import type { ToolRegistry } from './tools'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(() => Promise.resolve('')) }
}))

vi.mock('electron', () => ({
  app: { isPackaged: true },
  dialog: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => electron.handlers.set(channel, handler),
    on: (channel: string, listener: (...args: unknown[]) => void) => electron.listeners.set(channel, listener)
  },
  shell: electron.shell,
  BrowserWindow: class {},
  nativeTheme: {},
  screen: {},
  net: {},
  protocol: {}
}))

/** An event from the main frame of the app's window, showing the app's page. */
const trustedEvent = (sender = 1, url = 'app://renderer/index.html'): unknown => ({ sender: { id: sender }, senderFrame: { frameTreeNodeId: 7, url } })

function connect(options: { ready?: boolean; settings?: Partial<ReturnType<SettingsStore['get']>>; runner?: Partial<JobRunner> } = {}) {
  const sent: [string, unknown][] = []
  const window = {
    isDestroyed: () => false,
    webContents: { id: 1, mainFrame: { frameTreeNodeId: 7 }, send: (channel: string, payload: unknown) => sent.push([channel, payload]) }
  }
  const ipc = registerIpc({
    window: () => window as unknown as BrowserWindow,
    settings: { get: () => options.settings ?? {} } as unknown as SettingsStore,
    tools: {} as ToolRegistry,
    runner: (options.runner ?? {}) as JobRunner,
    isRendererReady: () => options.ready ?? true,
    onRendererReady: () => undefined,
    onBusyChange: () => undefined
  })
  const reply = (value: unknown, from = { sender: 1, url: 'app://renderer/index.html' }): void => {
    electron.listeners.get(IPC.filesInUseReply)?.(trustedEvent(from.sender, from.url), value)
  }
  const invoke = (channel: string, ...args: unknown[]): unknown => electron.handlers.get(channel)?.(trustedEvent(), ...args)
  return { ipc, sent, reply, invoke }
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

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
  })

  it('drops unsent events when cleared', () => {
    vi.useFakeTimers()
    const sent: JobEvent[][] = []
    const batcher = new JobEventBatcher((events) => sent.push(events))
    batcher.push({ type: 'cancelled', jobId: 'a' })
    batcher.clear()
    vi.advanceTimersByTime(100)
    batcher.flush()
    expect(sent).toEqual([])
  })
})

describe('asking the page which files other jobs need', () => {
  const query = { jobId: 'a', finishing: ['a'], files: ['/in/A.iso', '/in/B.iso'] }

  it('sends the question and takes only the matching answer from the app page', async () => {
    const { ipc, sent, reply } = connect()
    const answer = ipc.filesInUse(query)
    expect(sent).toEqual([[IPC.filesInUse, { requestId: 1, ...query }]])
    reply({ requestId: 2, files: [] })
    reply({ requestId: 1, files: [] }, { sender: 2, url: 'app://renderer/index.html' })
    reply({ requestId: 1, files: [] }, { sender: 1, url: 'https://example.com/' })
    reply({ requestId: 1, files: ['/in/A.iso', 42] })
    expect(await answer).toEqual(['/in/A.iso'])
  })

  it('sends queued job events first, so that the page answers knowing about jobs that just finished', () => {
    const { ipc, sent } = connect()
    ipc.events.push({ type: 'done', jobId: 'b', outputs: [], outputBytes: 0, skipped: false })
    void ipc.filesInUse(query)
    expect(sent.map(([channel]) => channel)).toEqual([IPC.jobEvents, IPC.filesInUse])
    ipc.resetRenderer()
  })

  it('has no answer when the page is not ready, does not reply in time or goes away', async () => {
    expect(await connect({ ready: false }).ipc.filesInUse(query)).toBeNull()

    vi.useFakeTimers()
    const late = connect().ipc.filesInUse(query)
    vi.advanceTimersByTime(10_000)
    expect(await late).toBeNull()
    vi.useRealTimers()

    const { ipc, reply } = connect()
    const reset = ipc.filesInUse(query)
    ipc.resetRenderer()
    reply({ requestId: 1, files: ['/in/A.iso'] })
    expect(await reset).toBeNull()
  })
})
