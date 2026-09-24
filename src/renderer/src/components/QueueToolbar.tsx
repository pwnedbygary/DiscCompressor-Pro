import { clsx } from 'clsx'
import { BrushCleaning, CheckCheck, Download, LoaderCircle, RotateCcw, Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isCompressionTarget } from '@shared/formats'
import { exportQueue, importQueue } from '../actions'
import { formatBytes } from '../lib/format'
import { removeJobs } from '../store/scheduler'
import { useQueue } from '../store/queue'
import { useUi } from '../store/ui'
import { IconButton } from './ui/Button'

interface Stats {
  total: number
  queued: number
  running: number
  done: number
  failed: number
  cancelled: number
  retryable: number
  saved: number
}

/** A destructive button that needs a second click within a few seconds. */
function ClearButton({ disabled, onConfirm }: { disabled: boolean; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(timer)
  }, [armed])
  if (armed) {
    return (
      <button
        type="button"
        onClick={() => {
          setArmed(false)
          onConfirm()
        }}
        className="ml-0.5 inline-flex h-7 items-center gap-1.5 rounded-lg bg-danger px-2.5 text-xs font-medium text-danger-fg shadow-sm"
      >
        <Trash2 className="size-3.5" aria-hidden /> Click again to clear
      </button>
    )
  }
  return <IconButton icon={Trash2} label="Clear the queue" size="sm" tone="danger" disabled={disabled} onClick={() => setArmed(true)} />
}

function Chip({ label, value, tone }: { label: string; value: number; tone: string }) {
  if (value === 0) return null
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span className={clsx('size-1.5 rounded-full', tone)} />
      <span className="font-medium text-fg tabular-nums">{value}</span> {label}
    </span>
  )
}

export function QueueToolbar() {
  const stats = useQueue(
    useShallow((state): Stats => {
      const s: Stats = { total: state.order.length, queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, retryable: 0, saved: 0 }
      for (const id of state.order) {
        const job = state.jobs[id]
        if (!job) continue
        if (job.status === 'queued') s.queued += 1
        else if (job.status === 'running') s.running += 1
        else if (job.status === 'done' || job.status === 'skipped') s.done += 1
        else if (job.status === 'failed' || job.status === 'cancelled') {
          if (job.status === 'failed') s.failed += 1
          else s.cancelled += 1
          if (!job.input.problem) s.retryable += 1
        }
        if (job.status === 'done' && isCompressionTarget(job.target) && job.outputBytes !== null && job.outputBytes < job.input.size) {
          s.saved += job.input.size - job.outputBytes
        }
      }
      return s
    })
  )
  const scanning = useUi((state) => state.scanning > 0)

  const retry = (): void => {
    const { order, jobs, reset } = useQueue.getState()
    reset(order.filter((id) => (jobs[id]?.status === 'failed' || jobs[id]?.status === 'cancelled') && !jobs[id].input.problem))
  }
  const clearAll = (): void => removeJobs(useQueue.getState().order)

  return (
    <div className="flex h-11 shrink-0 items-center gap-4 border-b border-line px-4">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-semibold">Queue</span>
        <span className="text-xs text-muted tabular-nums">
          {stats.total} {stats.total === 1 ? 'job' : 'jobs'}
        </span>
      </div>
      <div className="flex items-center gap-3.5">
        <Chip label="running" value={stats.running} tone="bg-accent animate-pulse" />
        <Chip label="queued" value={stats.queued} tone="bg-muted" />
        <Chip label="done" value={stats.done} tone="bg-success" />
        <Chip label="failed" value={stats.failed} tone="bg-danger" />
        <Chip label="cancelled" value={stats.cancelled} tone="bg-line-strong" />
      </div>
      {scanning && (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> Scanning…
        </span>
      )}
      {stats.saved > 0 && (
        <span className="rounded-full bg-success/12 px-2.5 py-0.5 text-xs font-medium text-success-ink tabular-nums">
          {formatBytes(stats.saved)} saved
        </span>
      )}
      <div className="flex-1" />
      <div className="flex items-center gap-0.5">
        <IconButton icon={CheckCheck} label="Select all" shortcut="Ctrl+A" size="sm" disabled={stats.total === 0} onClick={() => useQueue.getState().selectAll()} />
        <IconButton icon={RotateCcw} label="Retry failed and cancelled jobs" size="sm" disabled={stats.retryable === 0} onClick={retry} />
        <IconButton icon={BrushCleaning} label="Remove finished jobs" size="sm" disabled={stats.done === 0} onClick={() => useQueue.getState().clearFinished()} />
        <div className="mx-1 h-4 w-px bg-line" />
        <IconButton icon={Upload} label="Import queue…" size="sm" onClick={() => void importQueue()} />
        <IconButton icon={Download} label="Export queue…" size="sm" disabled={stats.total === 0} onClick={() => void exportQueue()} />
        <ClearButton disabled={stats.total === 0} onConfirm={clearAll} />
      </div>
    </div>
  )
}
