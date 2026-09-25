import type { ScannedInput } from '@shared/types'
import { api } from './lib/api'
import { errorMessage } from './lib/errors'
import { fileName } from './lib/format'
import { parseQueueFile, serializeQueue } from './lib/queueFile'
import { log } from './store/log'
import { type Dedupe, type NewJob, useQueue } from './store/queue'
import { useSettings } from './store/settings'
import { toast } from './store/toasts'
import { useUi } from './store/ui'

type Skipped = { path: string; reason: string }[]

const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/

/** Compare paths the way the file system would: separators unified, case-insensitive on Windows. */
function pathKey(path: string): string {
  const unified = path.replace(/[\\/]+/g, '/').replace(/(.)\/$/, '$1')
  return api.platform === 'win32' ? unified.toLowerCase() : unified
}

function enqueue(entries: NewJob[], skipped: Skipped, dedupe: Dedupe = 'path'): void {
  const settings = useSettings.getState().settings
  if (!settings) return
  const { added, duplicates } = useQueue.getState().add(entries, { target: settings.defaultTarget, settings: settings.jobDefaults }, dedupe)
  const problems = entries.filter((entry) => entry.input.problem).length

  for (const entry of skipped) log('warn', `Skipped ${fileName(entry.path)}: ${entry.reason}`)
  if (added > 0) log('info', `Added ${added} image${added === 1 ? '' : 's'} to the queue`)

  const notes = [
    duplicates > 0 && `${duplicates} already queued`,
    skipped.length > 0 && `${skipped.length} skipped`,
    problems > 0 && `${problems} with problems`
  ].filter(Boolean)
  if (added > 0) toast(problems > 0 ? 'warning' : 'success', `Added ${added} image${added === 1 ? '' : 's'}`, notes.join(' · ') || undefined)
  else if (entries.length > 0 || skipped.length > 0) toast('info', 'Nothing new to add', notes.join(' · ') || undefined)
}

export async function addPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  try {
    const result = await useUi.getState().trackScan(api.scan(paths))
    if (result.inputs.length === 0 && result.skipped.length > 0) {
      for (const entry of result.skipped) log('warn', `Skipped ${fileName(entry.path)}: ${entry.reason}`)
      toast('warning', 'No disc images found', result.skipped.length === 1 ? result.skipped[0]?.reason : `${result.skipped.length} items skipped`)
      return
    }
    enqueue(
      result.inputs.map((input) => ({ input })),
      result.skipped
    )
  } catch (error) {
    toast('error', 'Could not add files', errorMessage(error))
  }
}

export async function pickAndAdd(mode: 'files' | 'folder'): Promise<void> {
  try {
    await addPaths(await api.pickInputs(mode))
  } catch (error) {
    toast('error', 'Could not open the file picker', errorMessage(error))
  }
}

export async function exportQueue(): Promise<void> {
  const { order, jobs } = useQueue.getState()
  const list = order.flatMap((id) => (jobs[id] ? [jobs[id]] : []))
  if (list.length === 0) {
    toast('info', 'The queue is empty')
    return
  }
  try {
    const saved = await api.saveText({
      title: 'Export queue',
      defaultName: `disccompressor-queue-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'Queue files', extensions: ['json'] }],
      content: serializeQueue(list)
    })
    if (saved) toast('success', `Exported ${list.length} job${list.length === 1 ? '' : 's'}`)
  } catch (error) {
    toast('error', 'Could not export the queue', errorMessage(error))
  }
}

export async function importQueue(): Promise<void> {
  try {
    const text = await api.openText({ title: 'Import queue', filters: [{ name: 'Queue files', extensions: ['json'] }] })
    if (text === null) return
    const entries = parseQueueFile(text)
    if (entries.length === 0) {
      toast('warning', 'The queue file has no jobs')
      return
    }
    const skipped: Skipped = entries.filter((entry) => !ABSOLUTE_PATH.test(entry.path)).map((entry) => ({ path: entry.path, reason: 'Not an absolute path' }))
    const usable = entries.filter((entry) => ABSOLUTE_PATH.test(entry.path))
    const result = await useUi.getState().trackScan(api.scan([...new Set(usable.map((entry) => entry.path))]))
    const byPath = new Map<string, ScannedInput>(result.inputs.map((input) => [pathKey(input.path), input]))
    const found: NewJob[] = []
    for (const entry of usable) {
      const input = byPath.get(pathKey(entry.path))
      if (input) found.push({ input, target: entry.target, settings: entry.settings })
      else if (!result.skipped.some((s) => pathKey(s.path) === pathKey(entry.path))) skipped.push({ path: entry.path, reason: 'Not found' })
    }
    enqueue(found, [...skipped, ...result.skipped], 'job')
  } catch (error) {
    toast('error', 'Could not import the queue', errorMessage(error))
  }
}

export async function saveAsDefaults(jobId: string): Promise<void> {
  const job = useQueue.getState().jobs[jobId]
  if (!job) return
  try {
    await useSettings.getState().update({ defaultTarget: job.target, jobDefaults: job.settings })
    toast('success', 'Saved as defaults', 'New jobs will start with these settings.')
  } catch (error) {
    toast('error', 'Could not save the defaults', errorMessage(error))
  }
}

export async function openOutput(path: string): Promise<void> {
  try {
    await api.showInFolder(path)
  } catch (error) {
    toast('error', 'Could not open the folder', errorMessage(error))
  }
}

export async function openOutputFolder(): Promise<void> {
  try {
    if (!(await api.openOutputFolder())) toast('info', 'The output folder does not exist yet', 'It is created when the first job starts.')
  } catch (error) {
    toast('error', 'Could not open the output folder', errorMessage(error))
  }
}
