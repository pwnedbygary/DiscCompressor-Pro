import { clsx } from 'clsx'
import {
  ArrowRight,
  Ban,
  CircleAlert,
  CircleCheck,
  Clock3,
  Copy,
  FolderOpen,
  GripVertical,
  LoaderCircle,
  RotateCcw,
  SkipForward,
  Square,
  X
} from 'lucide-react'
import { type DragEvent, type MouseEvent, memo } from 'react'
import { TARGET_LABELS, isCompressionTarget } from '@shared/formats'
import { openOutput } from '../actions'
import { estimateRemaining, formatBytes, formatDuration, formatPercent, formatReduction } from '../lib/format'
import { INPUT_LABELS, type JobStatus, describeOutput } from '../lib/jobs'
import { cancelJob, removeJobs } from '../store/scheduler'
import { selectedInOrder, useQueue } from '../store/queue'
import { IconButton } from './ui/Button'
import { ProgressBar } from './ui/controls'

export const ROW_HEIGHT = 64
export const ROW_GAP = 6
export const JOB_DRAG_TYPE = 'application/x-dcp-jobs'

const STATUS: Record<JobStatus, { icon: typeof Clock3; className: string; label: string }> = {
  queued: { icon: Clock3, className: 'bg-subtle text-muted', label: 'Queued' },
  running: { icon: LoaderCircle, className: 'bg-accent/15 text-accent-ink', label: 'Running' },
  done: { icon: CircleCheck, className: 'bg-success/15 text-success-ink', label: 'Done' },
  skipped: { icon: SkipForward, className: 'bg-warning/15 text-warning-ink', label: 'Skipped' },
  failed: { icon: CircleAlert, className: 'bg-danger/15 text-danger-ink', label: 'Failed' },
  cancelled: { icon: Ban, className: 'bg-subtle text-muted', label: 'Cancelled' }
}

const isButton = (event: MouseEvent): boolean => !!(event.target as HTMLElement).closest('button')

interface JobRowProps {
  id: string
  /** 1-based place in the queue; the list is virtualized, so assistive technology cannot count the rows. */
  position: number
  total: number
  onDragStartRow: (event: DragEvent<HTMLDivElement>, id: string) => void
}

export const JobRow = memo(function JobRow({ id, position, total, onDragStartRow }: JobRowProps) {
  const job = useQueue((state) => state.jobs[id])
  const selected = useQueue((state) => state.selected.has(id))
  const focused = useQueue((state) => state.focus === id)
  if (!job) return null

  const status = STATUS[job.status]
  const StatusIcon = status.icon
  const remaining = job.status === 'running' ? estimateRemaining(job.startedAt, job.progress) : null
  const saved =
    job.status === 'done' && isCompressionTarget(job.target) && job.outputBytes !== null && job.input.size > 0
      ? 1 - job.outputBytes / job.input.size
      : null

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || isButton(event)) return
    const { select } = useQueue.getState()
    if (event.shiftKey) select(id, { range: true, toggle: event.ctrlKey || event.metaKey })
    else if (event.ctrlKey || event.metaKey) select(id, { toggle: true })
    // Keep a multi-selection on mouse down so it can be dragged; a plain click narrows it below.
    else if (!selected) select(id)
  }

  const onClick = (event: MouseEvent): void => {
    if (event.shiftKey || event.ctrlKey || event.metaKey || isButton(event)) return
    const state = useQueue.getState()
    if (selectedInOrder(state).length > 1) state.select(id)
  }

  return (
    <div
      role="option"
      id={`job-${id}`}
      aria-selected={selected}
      aria-posinset={position}
      aria-setsize={total}
      data-focused={focused}
      draggable
      onDragStart={(event) => onDragStartRow(event, id)}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onDoubleClick={(event) => !isButton(event) && job.outputs[0] && void openOutput(job.outputs[0])}
      style={{ height: ROW_HEIGHT }}
      className={clsx(
        'group relative flex items-center gap-3 rounded-xl border pr-2 pl-1.5 transition-[background-color,border-color,box-shadow] duration-150',
        'outline-offset-2 outline-accent group-focus-visible/list:data-[focused=true]:outline-2',
        selected
          ? 'border-accent/60 bg-accent/[0.08] shadow-[0_0_0_1px] shadow-accent/40'
          : 'border-line bg-elevated hover:border-line-strong'
      )}
    >
      <GripVertical className="size-4 shrink-0 cursor-grab text-muted/0 transition-colors group-hover:text-muted/70" aria-hidden />
      <div className={clsx('grid size-9 shrink-0 place-items-center rounded-full', status.className)} title={status.label}>
        <StatusIcon className={clsx('size-[18px]', job.status === 'running' && 'animate-spin')} strokeWidth={2} aria-hidden />
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium" title={job.input.path}>
          {job.input.name}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <span className="shrink-0 font-medium">{INPUT_LABELS[job.input.kind]}</span>
          <span className="shrink-0 tabular-nums">{formatBytes(job.input.size)}</span>
          <ArrowRight className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{describeOutput(job.input, job.target, job.settings)}</span>
        </div>
      </div>

      <span className="hidden shrink-0 rounded-md bg-accent/12 px-2 py-0.5 text-2xs font-semibold text-accent-ink @xl:inline">{TARGET_LABELS[job.target]}</span>

      <div className="w-40 shrink-0 text-xs @3xl:w-64">
        {job.status === 'running' && (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-muted">{job.stage ?? 'Working'}</span>
              <span className="shrink-0 font-medium tabular-nums">
                {job.progress === null ? '' : formatPercent(job.progress)}
                {remaining !== null && <span className="font-normal text-muted"> · {formatDuration(remaining)} left</span>}
              </span>
            </div>
            <ProgressBar value={job.progress} />
          </div>
        )}
        {job.status === 'queued' && <span className="text-muted">Waiting</span>}
        {job.status === 'done' && (
          <span className="flex items-baseline gap-1.5">
            {job.outputBytes !== null && job.outputs.length > 0 ? (
              <span className="font-medium tabular-nums">{formatBytes(job.outputBytes)}</span>
            ) : (
              <span className="font-medium text-success-ink">Completed</span>
            )}
            {saved !== null && saved >= 0.001 && <span className="text-success-ink tabular-nums">−{formatReduction(saved)}</span>}
            {job.startedAt && job.finishedAt && <span className="hidden text-muted tabular-nums @3xl:inline">in {formatDuration(job.finishedAt - job.startedAt)}</span>}
          </span>
        )}
        {job.status === 'skipped' && (
          <span className="text-warning-ink" title="Run the job again to write a numbered copy">
            Output already exists
          </span>
        )}
        {job.status === 'cancelled' && <span className="text-muted">Cancelled</span>}
        {job.status === 'failed' && (
          <span className="line-clamp-2 text-danger-ink" title={job.error ?? undefined}>
            {job.error ?? 'Failed'}
          </span>
        )}
      </div>

      <div className="flex w-[88px] shrink-0 items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-data-[focused=true]:opacity-100">
        {job.outputs[0] && <IconButton icon={FolderOpen} label="Show in folder" size="sm" tabIndex={-1} onClick={() => void openOutput(job.outputs[0] as string)} />}
        {job.status === 'running' ? (
          <IconButton icon={Square} label="Cancel this job" size="sm" tone="danger" tabIndex={-1} onClick={() => cancelJob(id)} />
        ) : job.status !== 'queued' && !job.input.problem ? (
          <IconButton icon={RotateCcw} label="Run again" size="sm" tabIndex={-1} onClick={() => useQueue.getState().reset([id])} />
        ) : (
          <IconButton icon={Copy} label="Duplicate" size="sm" tabIndex={-1} onClick={() => useQueue.getState().duplicate([id])} />
        )}
        <IconButton icon={X} label="Remove from queue" size="sm" tone="danger" tabIndex={-1} onClick={() => removeJobs([id])} />
      </div>
    </div>
  )
})
