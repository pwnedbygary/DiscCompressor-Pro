import { X } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import { IconButton } from './Button'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  icon?: ReactNode
  footer?: ReactNode
  children: ReactNode
}

/** A modal built on the native <dialog> element, which handles focus trapping, Escape and the top layer. */
export function Dialog({ open, onClose, title, description, icon, footer, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[min(86vh,760px)] w-[640px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-2xl border border-line bg-bg shadow-2xl">
        <header className="flex items-start gap-3 border-b border-line px-6 py-4">
          {icon && <div className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent-ink">{icon}</div>}
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} className="-mr-2" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface/60 px-6 py-3">{footer}</footer>}
      </div>
    </dialog>
  )
}
