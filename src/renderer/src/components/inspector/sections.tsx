import { clsx } from 'clsx'
import { Check } from 'lucide-react'
import {
  CD_CODECS,
  CD_FRAME_BYTES,
  CD_HUNK_OPTIONS,
  CHD_DEFAULT_HUNK,
  CSO_BLOCK_OPTIONS,
  CSO_FORMAT_FOR_TARGET,
  DVD_CODECS,
  DVD_HUNK_OPTIONS,
  MAX_CHD_CODECS,
  chdMediaFor,
  csoMethodImplies,
  csoMethodsFor,
  effectiveCsoMethods,
  endsWithDataTrack,
  extractCdFormat
} from '@shared/formats'
import type { CsoMode, JobSettings } from '@shared/types'
import { formatBytes, formatNumber } from '../../lib/format'
import { type Job, MEDIA_LABELS } from '../../lib/jobs'
import { useSettings } from '../../store/settings'
import { Checkbox, Field, Segmented, Select } from '../ui/controls'

interface SectionProps {
  job: Job
  disabled: boolean
  update: (patch: Partial<JobSettings>) => void
}

export function ThreadsField({ job, disabled, update }: SectionProps) {
  const cpuCount = useSettings((state) => state.system?.cpuCount ?? 8)
  const counts = Array.from({ length: Math.max(cpuCount, job.settings.threads) }, (_, i) => i + 1)
  return (
    <Field label="Threads" hint="Auto lets the tool use every core.">
      <Select aria-label="Threads" value={job.settings.threads} disabled={disabled} onChange={(event) => update({ threads: Number(event.target.value) })}>
        <option value={0}>Auto ({cpuCount} cores)</option>
        {counts.map((count) => (
          <option key={count} value={count}>
            {count}
          </option>
        ))}
      </Select>
    </Field>
  )
}

function CodecPicker({ job, disabled, update }: SectionProps) {
  const dvd = chdMediaFor(job.input, job.settings) === 'dvd'
  const codecs = dvd ? DVD_CODECS : CD_CODECS
  const selected = dvd ? job.settings.chdCodecsDvd : job.settings.chdCodecsCd
  const key = dvd ? 'chdCodecsDvd' : 'chdCodecsCd'

  const toggle = (id: string): void => {
    const next = selected.includes(id) ? selected.filter((codec) => codec !== id) : [...selected, id]
    if (next.length === 0 || next.length > MAX_CHD_CODECS) return
    update({ [key]: codecs.map((codec) => codec.id).filter((codec) => next.includes(codec)) })
  }

  return (
    <Field
      label={
        <span className="flex justify-between">
          <span>Codecs</span>
          <span className="font-normal tabular-nums normal-case">
            {selected.length}/{MAX_CHD_CODECS}
          </span>
        </span>
      }
      hint="chdman tries every selected codec on each hunk and keeps the smallest result."
    >
      <div className="grid grid-cols-2 gap-1.5">
        {codecs.map((codec) => {
          const on = selected.includes(codec.id)
          const blocked = !on && selected.length >= MAX_CHD_CODECS
          const last = on && selected.length === 1
          return (
            <button
              key={codec.id}
              type="button"
              aria-pressed={on}
              aria-disabled={last || undefined}
              disabled={disabled || blocked}
              title={blocked ? `A CHD can use at most ${MAX_CHD_CODECS} codecs` : last ? 'A CHD needs at least one codec' : undefined}
              onClick={() => toggle(codec.id)}
              className={clsx(
                'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors disabled:opacity-40',
                on ? 'border-accent/60 bg-accent/10' : 'border-line bg-elevated hover:border-line-strong'
              )}
            >
              <span className={clsx('grid size-4 shrink-0 place-items-center rounded', on ? 'bg-accent text-accent-fg' : 'border border-line-strong')}>
                {on && <Check className="size-3" strokeWidth={3} aria-hidden />}
              </span>
              <span className="min-w-0">
                <span className="block font-mono text-xs font-medium">{codec.id}</span>
                <span className="block truncate text-2xs text-muted">{codec.name}</span>
              </span>
            </button>
          )
        })}
      </div>
    </Field>
  )
}

export function ChdSection(props: SectionProps) {
  const { job, disabled, update } = props
  const media = chdMediaFor(job.input, job.settings)
  const dvd = media === 'dvd'
  const choosable = job.input.kind === 'iso' || job.input.kind === 'cso' || job.input.kind === 'zso' || job.input.kind === 'dax'
  const recompress = job.input.kind === 'chd'
  const hunk = dvd ? job.settings.chdHunkDvd : job.settings.chdHunkCd
  const baseOptions = dvd ? DVD_HUNK_OPTIONS : CD_HUNK_OPTIONS
  const options = baseOptions.includes(hunk) ? baseOptions : [...baseOptions, hunk].sort((a, b) => a - b)
  const defaultLabel = recompress
    ? `Keep current (${formatNumber(job.input.chd?.hunkBytes ?? 0)} bytes)`
    : `Default (${formatNumber(dvd ? CHD_DEFAULT_HUNK.dvd : CHD_DEFAULT_HUNK.cd)} bytes)`

  return (
    <>
      <Field
        label="Media type"
        hint={
          choosable
            ? 'DVD for DVD-based discs such as PS2 DVDs and PSP UMDs; CD for images of CD-based discs.'
            : `Set by the ${recompress ? 'source CHD' : job.input.kind === 'gdi' ? 'GDI sheet' : job.input.kind === 'cdi' ? 'CDI image' : 'cue sheet'}.`
        }
      >
        {choosable ? (
          <Segmented
            label="Media type"
            value={job.settings.chdMedia}
            disabled={disabled}
            onChange={(chdMedia) => update({ chdMedia })}
            options={[
              { value: 'dvd', label: 'DVD (createdvd)' },
              { value: 'cd', label: 'CD (createcd)' }
            ]}
          />
        ) : (
          <div className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px]">{MEDIA_LABELS[media]}</div>
        )}
      </Field>
      <CodecPicker {...props} />
      <Field label="Hunk size" hint={dvd ? 'Must be a multiple of the 2,048-byte sector size.' : 'Must be a multiple of the 2,448-byte CD frame (sector + subcode).'}>
        <Select
          aria-label="Hunk size"
          value={hunk}
          disabled={disabled}
          onChange={(event) => update(dvd ? { chdHunkDvd: Number(event.target.value) } : { chdHunkCd: Number(event.target.value) })}
        >
          {options.map((bytes) => (
            <option key={bytes} value={bytes}>
              {bytes === 0 ? defaultLabel : `${formatNumber(bytes)} bytes${dvd ? '' : ` (${bytes / CD_FRAME_BYTES} frame${bytes === CD_FRAME_BYTES ? '' : 's'})`}`}
            </option>
          ))}
        </Select>
      </Field>
      <ThreadsField {...props} />
    </>
  )
}

const EFFORT_HINTS: Record<CsoMode, string> = {
  fast: 'Only basic zlib/LZ4 compression — quickest, slightly larger files.',
  default: "maxcso's standard trials for this format.",
  max: 'Every applicable method, including Zopfli — smallest files, much slower.',
  custom: 'Choose exactly which methods maxcso tries.'
}

export function CsoSection(props: SectionProps) {
  const { job, disabled, update } = props
  const format = CSO_FORMAT_FOR_TARGET[job.target] ?? 'cso1'
  const methods = csoMethodsFor(format)
  const active = effectiveCsoMethods(format, job.settings.csoMode, job.settings.csoMethods)

  const toggleMethod = (id: (typeof methods)[number]['id']): void => {
    const current = new Set(active)
    if (current.has(id)) current.delete(id)
    else current.add(id)
    if (![...current].some((method) => methods.some((m) => m.id === method))) return
    const others = job.settings.csoMethods.filter((method) => !methods.some((m) => m.id === method))
    update({ csoMode: 'custom', csoMethods: [...others, ...current] })
  }

  return (
    <>
      <Field label="Compression effort" hint={EFFORT_HINTS[job.settings.csoMode]}>
        <Segmented
          label="Compression effort"
          value={job.settings.csoMode}
          disabled={disabled}
          onChange={(csoMode) => update({ csoMode })}
          options={[
            { value: 'fast', label: 'Fast' },
            { value: 'default', label: 'Balanced' },
            { value: 'max', label: 'Maximum' },
            { value: 'custom', label: 'Custom' }
          ]}
        />
      </Field>
      {job.settings.csoMode === 'custom' && (
        <Field label="Methods">
          <div className="rounded-lg border border-line bg-elevated px-3 py-1.5">
            {methods.map((method) => {
              const requiredBy = methods.find((other) => csoMethodImplies(other.id) === method.id && active.includes(other.id))
              return (
                <Checkbox
                  key={method.id}
                  checked={active.includes(method.id)}
                  disabled={disabled || !!requiredBy || (active.length === 1 && active.includes(method.id))}
                  onChange={() => toggleMethod(method.id)}
                  label={method.name}
                  description={requiredBy ? `${method.description}; needed by ${requiredBy.name}` : method.description}
                />
              )
            })}
          </div>
        </Field>
      )}
      <Field label="Block size" hint="Most PSP software and hardware only reads 2,048-byte blocks; larger blocks compress a little better.">
        <Select aria-label="Block size" value={job.settings.csoBlockSize} disabled={disabled} onChange={(event) => update({ csoBlockSize: Number(event.target.value) })}>
          {CSO_BLOCK_OPTIONS.map((bytes) => (
            <option key={bytes} value={bytes}>
              {bytes === 0 ? 'Auto (2 KB below 2 GB, 16 KB above)' : `${formatBytes(bytes)}${bytes === 2048 ? ' — most compatible' : ''}`}
            </option>
          ))}
        </Select>
      </Field>
      <ThreadsField {...props} />
    </>
  )
}

export function ExtractSection(props: SectionProps) {
  const { job, disabled, update } = props
  const { input } = job
  if (input.kind === 'cdi') {
    const sessions = (input.cdi?.sessions ?? 1) > 1
    return (
      <Field label="Output" hint={sessions ? 'One BIN file per track, with the sessions marked in the cue sheet.' : 'One BIN file per track.'}>
        <div className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px]">BIN/CUE</div>
      </Field>
    )
  }
  if (input.kind !== 'chd') {
    return (
      <>
        <Field label="Output">
          <div className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px]">ISO image</div>
        </Field>
        <ThreadsField {...props} />
      </>
    )
  }
  if (input.chd?.media === 'gdrom') {
    return (
      <Field label="Output" hint="GDI is the classic Dreamcast layout; BIN/CUE follows the Redump layout with one file per track.">
        <Segmented
          label="Output"
          value={job.settings.extractGd}
          disabled={disabled}
          onChange={(extractGd) => update({ extractGd })}
          options={[
            { value: 'gdi', label: 'GDI' },
            { value: 'cue', label: 'BIN/CUE' }
          ]}
        />
      </Field>
    )
  }
  if (input.chd?.media === 'dvd') {
    return (
      <Field label="Output">
        <div className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px]">ISO image</div>
      </Field>
    )
  }
  const format = extractCdFormat(input, job.settings)
  const isoHint = input.isoLayout ? 'ISO keeps only the 2,048-byte user data of each sector.' : `ISO is unavailable: ${input.isoBlocker ?? 'unsupported disc layout'}.`
  const hint =
    format === 'cdi'
      ? 'A DiscJuggler image, as Dreamcast CD-Rs are usually shared; a Dreamcast CD-R gets its second session back.'
      : endsWithDataTrack(input)
        ? `A Dreamcast CD-R gets one BIN file per track, with its sessions marked in the cue sheet. ${isoHint}`
        : isoHint
  return (
    <Field label="Output" hint={hint}>
      <Segmented
        label="Output"
        value={format}
        disabled={disabled}
        onChange={(extractCd) => update({ extractCd })}
        options={[
          { value: 'cue', label: 'BIN/CUE' },
          { value: 'iso', label: 'ISO', disabled: !input.isoLayout, title: input.isoBlocker ?? undefined },
          { value: 'cdi', label: 'CDI' }
        ]}
      />
    </Field>
  )
}
