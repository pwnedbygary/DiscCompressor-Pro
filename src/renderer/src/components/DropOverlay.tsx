import { Download } from 'lucide-react'

export function DropOverlay() {
  return (
    <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-bg/70 p-6 backdrop-blur-sm">
      <div className="grid h-full w-full place-items-center rounded-3xl border-2 border-dashed border-accent bg-accent/5">
        <div className="flex flex-col items-center text-center">
          <div className="mb-4 grid size-16 place-items-center rounded-2xl bg-accent text-accent-fg shadow-lg">
            <Download className="size-8" aria-hidden />
          </div>
          <div className="text-lg font-semibold">Drop to add to the queue</div>
          <div className="mt-1 text-[13px] text-muted">Files and folders are both fine</div>
        </div>
      </div>
    </div>
  )
}
