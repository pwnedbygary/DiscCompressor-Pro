import { clsx } from 'clsx'
import type { LucideIcon } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'danger' | 'success'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg shadow-sm enabled:hover:brightness-110 enabled:active:brightness-95',
  success: 'bg-success text-success-fg shadow-sm enabled:hover:brightness-110 enabled:active:brightness-95',
  danger: 'bg-danger text-danger-fg shadow-sm enabled:hover:brightness-110 enabled:active:brightness-95',
  secondary: 'border border-line bg-elevated text-fg shadow-xs enabled:hover:bg-hover enabled:active:bg-subtle'
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md'
  icon?: LucideIcon
  children?: ReactNode
}

// Disabled buttons keep pointer events so their title can explain why they are disabled.
export function Button({ variant = 'secondary', size = 'md', icon: Icon, className, children, type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-[background-color,filter,opacity] duration-150 disabled:opacity-45',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
        VARIANTS[variant],
        className
      )}
      {...props}
    >
      {Icon && <Icon className={size === 'sm' ? 'size-3.5' : 'size-4'} strokeWidth={2} aria-hidden />}
      {children}
    </button>
  )
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon
  label: string
  size?: 'sm' | 'md'
  tone?: 'default' | 'danger'
  /** Makes this a toggle button; its state is announced as pressed or not pressed. */
  pressed?: boolean
  /** Show a styled tooltip below the button instead of the native title. */
  tooltip?: boolean
  shortcut?: string
}

export function IconButton({
  icon: Icon,
  label,
  size = 'md',
  tone = 'default',
  pressed,
  tooltip = false,
  shortcut,
  className,
  type = 'button',
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      title={tooltip ? undefined : shortcut ? `${label} (${shortcut})` : label}
      className={clsx(
        'group/icon relative inline-flex shrink-0 items-center justify-center rounded-lg transition-colors duration-150 disabled:opacity-40',
        size === 'sm' ? 'size-7' : 'size-8',
        pressed ? 'bg-accent/15 text-accent-ink' : 'text-muted enabled:hover:bg-hover enabled:hover:text-fg',
        tone === 'danger' && 'enabled:hover:bg-danger/12 enabled:hover:text-danger-ink',
        className
      )}
      {...props}
    >
      <Icon className={size === 'sm' ? 'size-3.5' : 'size-[17px]'} strokeWidth={2} aria-hidden />
      {tooltip && (
        <span
          role="tooltip"
          className="pointer-events-none absolute top-full left-1/2 z-50 mt-2 -translate-x-1/2 rounded-md border border-line bg-elevated px-2 py-1 text-2xs font-medium whitespace-nowrap text-fg opacity-0 shadow-lg transition-opacity delay-0 duration-100 group-hover/icon:opacity-100 group-hover/icon:delay-500 group-focus-visible/icon:opacity-100"
        >
          {label}
          {shortcut && <span className="ml-1.5 text-muted">{shortcut}</span>}
        </span>
      )}
    </button>
  )
}
