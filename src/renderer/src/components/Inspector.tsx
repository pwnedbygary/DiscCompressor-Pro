import { clsx } from 'clsx'
import { CopyCheck, Info, Lock, MousePointerClick, Save } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { TARGETS, TARGET_LABELS, type TargetAvailability, targetAvailability } from '@shared/formats'
import type { JobSettings, ScannedInput, Target } from '@shared/types'
import { saveAsDefaults } from '../actions'
import { primarySelection, selectedInOrder, useQueue } from '../store/queue'
import { toast } from '../store/toasts'
import { InputDetails } from './inspector/InputDetails'
import { ChdSection, CsoSection, ExtractSection } from './inspector/sections'
import { Button } from './ui/Button'
import { Field } from './ui/controls'

const TARGET_HINTS: Record<Target, string> = {
  CHD: 'MAME & emulators',
  CSO: 'PSP & PS2 (deflate)',
  CSOv2: 'Deflate + LZ4 blocks',
  ZSO: 'LZ4, fast to read',
  Extract: 'Decompress',
  Info: 'CHD details',
  Verify: 'Check CHD'
}

// Scanned inputs never change, so their target availability is computed once.
const availabilityCache = new WeakMap<ScannedInput, TargetAvailability[]>()
function availabilityOf(input: ScannedInput): TargetAvailability[] {
  let entry = availabilityCache.get(input)
  if (!entry) {
    entry = targetAvailability(input)
    availabilityCache.set(input, entry)
  }
  return entry
}

/** For each target: how many of the editable jobs allow it, and why the first one that does not refuses. */
function summarize(inputs: ScannedInput[]): string[] {
  return TARGETS.map((target, index) => {
    let count = 0
    let reason = ''
    for (const input of inputs) {
      const entry = availabilityOf(input)[index] as TargetAvailability
      if (entry.allowed) count += 1
      else reason ||= entry.reason ?? ''
    }
    return `${target}\u0000${count}\u0000${reason}`
  })
}

function TargetPicker({ editableIds, current }: { editableIds: string[]; current: Target }) {
  const summary = useQueue(
    useShallow((state) => summarize(editableIds.flatMap((id) => (state.jobs[id] ? [state.jobs[id].input] : []))))
  )

  const choose = (target: Target): void => {
    const { applied, skipped } = useQueue.getState().setTarget(editableIds, target)
    if (skipped > 0) toast('info', `${TARGET_LABELS[target]} applied to ${applied} of ${applied + skipped} jobs`, 'The others cannot be converted to this format.')
  }

  const button = (target: Target) => {
    const [, countText, reason] = (summary[TARGETS.indexOf(target)] as string).split('\u0000') as [string, string, string]
    const count = Number(countText)
    const partial = count > 0 && count < editableIds.length
    return (
      <button
        key={target}
        type="button"
        aria-pressed={current === target}
        disabled={count === 0}
        title={count === 0 ? reason || undefined : partial ? `Available for ${count} of ${editableIds.length} selected jobs` : TARGET_HINTS[target]}
        onClick={() => choose(target)}
        className={clsx(
          'relative flex h-12 flex-col items-start justify-center rounded-lg border px-2.5 text-left transition-colors disabled:opacity-35',
          current === target ? 'border-accent bg-accent/12 text-accent-ink' : 'border-line bg-elevated enabled:hover:border-line-strong'
        )}
      >
        <span className="text-[13px] leading-4 font-semibold">{TARGET_LABELS[target]}</span>
        <span className={clsx('w-full truncate text-2xs', current === target ? 'text-accent-ink/80' : 'text-muted')}>{TARGET_HINTS[target]}</span>
        {partial && <span className="absolute top-1 right-1.5 text-2xs font-medium text-warning-ink tabular-nums">{`${count}/${editableIds.length}`}</span>}
      </button>
    )
  }

  return (
    <div className="space-y-3">
      <Field label="Compress to">
        <div className="grid grid-cols-2 gap-1.5">{(['CHD', 'CSO', 'CSOv2', 'ZSO'] as const).map(button)}</div>
      </Field>
      <Field label="Or">
        <div className="grid grid-cols-3 gap-1.5">{(['Extract', 'Info', 'Verify'] as const).map(button)}</div>
      </Field>
    </div>
  )
}

export function Inspector() {
  const ids = useQueue(useShallow(selectedInOrder))
  const primaryId = useQueue(primarySelection)
  const job = useQueue((state) => (primaryId ? state.jobs[primaryId] : undefined))
  const editableIds = useQueue(useShallow((state) => ids.filter((id) => state.jobs[id] && state.jobs[id].status !== 'running')))

  if (!job) {
    return (
      <aside className="flex w-[340px] shrink-0 flex-col items-center justify-center gap-3 border-l border-line bg-surface p-8 text-center">
        <div className="grid size-12 place-items-center rounded-2xl bg-subtle text-muted">
          <MousePointerClick className="size-6" aria-hidden />
        </div>
        <div className="text-[13px] font-medium">No job selected</div>
        <p className="text-xs text-muted">Select a job to choose its output format and compression settings. Select several to change them together.</p>
      </aside>
    )
  }

  const primaryRunning = job.status === 'running'
  const locked = editableIds.length === 0
  const update = (patch: Partial<JobSettings>): void => useQueue.getState().updateSettings(editableIds, patch)
  const subtitle =
    ids.length === 1 ? job.input.name : locked ? `${ids.length} jobs selected` : `${ids.length} jobs selected — changes apply to ${editableIds.length === ids.length ? 'all of them' : `the ${editableIds.length} not running`}`

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface">
      <div className="border-b border-line px-4 py-3">
        <div className="text-[13px] font-semibold">Job settings</div>
        <div className="mt-0.5 truncate text-xs text-muted" title={job.input.path}>
          {subtitle}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {primaryRunning && (
          <div className="flex items-start gap-2 rounded-lg border border-accent/30 bg-accent/8 px-3 py-2 text-xs">
            <Lock className="mt-0.5 size-3.5 shrink-0 text-accent-ink" aria-hidden />
            {locked
              ? 'This job is running. Its settings are locked until it finishes.'
              : 'This job is running and keeps its settings; changes apply to the other selected jobs.'}
          </div>
        )}
        <TargetPicker editableIds={editableIds} current={job.target} />

        {(job.target === 'CHD' || job.target === 'CSO' || job.target === 'CSOv2' || job.target === 'ZSO' || job.target === 'Extract') && (
          <div className="space-y-4 border-t border-line pt-4">
            {job.target === 'CHD' && <ChdSection job={job} disabled={locked} update={update} />}
            {(job.target === 'CSO' || job.target === 'CSOv2' || job.target === 'ZSO') && <CsoSection job={job} disabled={locked} update={update} />}
            {job.target === 'Extract' && <ExtractSection job={job} disabled={locked} update={update} />}
          </div>
        )}
        {(job.target === 'Info' || job.target === 'Verify') && (
          <div className="flex gap-2 rounded-lg border border-line bg-elevated px-3 py-2.5 text-xs text-muted">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {job.target === 'Info'
              ? 'Prints the CHD header, codecs, hunk size and metadata to the console. Nothing is written.'
              : "Recomputes the CHD's SHA-1 checksums and reports any corruption. Nothing is written."}
          </div>
        )}

        <InputDetails job={job} />
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-line p-3">
        <Button
          icon={CopyCheck}
          size="sm"
          onClick={() => {
            const { applied, requeued, targetSkipped } = useQueue.getState().applyToAll(job.id)
            const notes = [
              requeued > 0 && `${requeued} finished job${requeued === 1 ? '' : 's'} queued again`,
              targetSkipped > 0 && `${targetSkipped} kept their format because ${TARGET_LABELS[job.target]} does not apply to them`
            ].filter(Boolean)
            toast('success', `Applied to ${applied} job${applied === 1 ? '' : 's'}`, notes.join(' · ') || undefined)
          }}
          title="Copy this job's format and settings to every other job"
        >
          Apply to all
        </Button>
        <Button icon={Save} size="sm" onClick={() => void saveAsDefaults(job.id)} title="Use this format and these settings for new jobs">
          Save as default
        </Button>
      </div>
    </aside>
  )
}
