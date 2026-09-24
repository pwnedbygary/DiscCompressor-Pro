import { clsx } from 'clsx'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { type ToastKind, useToasts } from '../store/toasts'

const ICONS: Record<ToastKind, { icon: typeof Info; className: string }> = {
  info: { icon: Info, className: 'text-info-ink' },
  success: { icon: CircleCheck, className: 'text-success-ink' },
  warning: { icon: TriangleAlert, className: 'text-warning-ink' },
  error: { icon: CircleAlert, className: 'text-danger-ink' }
}

export function Toasts() {
  const { toasts, dismiss } = useToasts()
  return (
    <div className="pointer-events-none fixed right-4 bottom-10 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((toast) => {
        const { icon: Icon, className } = ICONS[toast.kind]
        return (
          <div key={toast.id} role="status" className="pointer-events-auto flex animate-toast-in gap-2.5 rounded-xl border border-line bg-elevated p-3 shadow-xl">
            <Icon className={clsx('mt-0.5 size-4 shrink-0', className)} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{toast.title}</div>
              {toast.detail && <div className="mt-0.5 text-xs text-muted">{toast.detail}</div>}
            </div>
            <button type="button" onClick={() => dismiss(toast.id)} aria-label="Dismiss" className="-mt-0.5 -mr-0.5 self-start rounded p-0.5 text-muted hover:bg-hover hover:text-fg">
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        )
      })}
    </div>
  )
}
