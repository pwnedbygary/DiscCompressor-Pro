import { clsx } from 'clsx'
import { Check, ChevronDown } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, type SelectHTMLAttributes, useId, useRef } from 'react'

export function Switch({
  checked,
  onChange,
  label,
  disabled = false
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-45',
        checked ? 'bg-accent' : 'bg-line-strong'
      )}
    >
      <span
        className={clsx(
          'inline-block size-4 rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform duration-200',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
  title?: string
}

/** A radio group drawn as segmented buttons, with the standard arrow-key behaviour. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
  disabled = false,
  className
}: {
  value: T
  options: SegmentOption<T>[]
  onChange: (value: T) => void
  label: string
  size?: 'sm' | 'md'
  disabled?: boolean
  className?: string
}) {
  const group = useRef<HTMLDivElement>(null)
  const enabled = options.filter((option) => !option.disabled && !disabled)

  const onKeyDown = (event: KeyboardEvent): void => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (step === 0 || enabled.length === 0) return
    event.preventDefault()
    const index = enabled.findIndex((option) => option.value === value)
    const next = enabled[(index + step + enabled.length) % enabled.length] as SegmentOption<T>
    onChange(next.value)
    group.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus()
  }

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={clsx('flex rounded-lg border border-line bg-surface p-0.5', disabled && 'opacity-60', className)}
    >
      {options.map((option) => {
        const selected = option.value === value
        const unavailable = disabled || option.disabled
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-value={option.value}
            aria-checked={selected}
            disabled={unavailable}
            tabIndex={selected ? 0 : -1}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={clsx(
              'flex-1 rounded-md px-2 font-medium whitespace-nowrap transition-colors duration-150 disabled:opacity-40',
              size === 'sm' ? 'h-6 text-2xs' : 'h-7 text-xs',
              selected ? 'bg-elevated text-fg shadow-sm ring-1 ring-line' : 'text-muted enabled:hover:text-fg'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={clsx('relative', className)}>
      <select
        className="h-8 w-full appearance-none rounded-lg border border-line bg-elevated pr-8 pl-2.5 text-[13px] text-fg shadow-xs transition-colors outline-none hover:border-line-strong focus-visible:border-accent disabled:opacity-45"
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
    </div>
  )
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled = false
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
}) {
  const id = useId()
  return (
    <label htmlFor={id} className={clsx('flex items-start gap-2.5 py-1', disabled && 'opacity-45')}>
      <span className="relative mt-px grid size-4 shrink-0 place-items-center">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="peer size-4 appearance-none rounded border border-line-strong bg-elevated transition-colors checked:border-accent checked:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
        <Check className="pointer-events-none absolute size-3 text-accent-fg opacity-0 peer-checked:opacity-100" strokeWidth={3} aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] leading-4">{label}</span>
        {description && <span className="mt-0.5 block text-2xs text-muted">{description}</span>}
      </span>
    </label>
  )
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-2xs font-semibold tracking-wide text-muted uppercase">{label}</div>
      {children}
      {hint && <p className="text-2xs leading-4 text-muted">{hint}</p>}
    </div>
  )
}

export function ProgressBar({ value }: { value: number | null }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(value * 100)}
      className="relative h-1.5 overflow-hidden rounded-full bg-line/70"
    >
      {value === null ? (
        <div className="absolute inset-y-0 w-2/5 animate-indeterminate rounded-full bg-accent" />
      ) : (
        <div className="progress-stripes h-full animate-shimmer rounded-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${Math.max(value * 100, 1.5)}%` }} />
      )}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-surface px-1.5 font-mono text-2xs text-muted shadow-[inset_0_-1px_0] shadow-line">{children}</kbd>
}
