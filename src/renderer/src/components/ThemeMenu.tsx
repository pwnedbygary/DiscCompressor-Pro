import { clsx } from 'clsx'
import { Check, Monitor, Palette } from 'lucide-react'
import { useRef } from 'react'
import { SYSTEM_THEME_ID, THEMES, type Theme } from '@shared/themes'
import { errorMessage } from '../lib/errors'
import { useAppSettings, useSettings } from '../store/settings'
import { toast } from '../store/toasts'

function Swatch({ theme }: { theme: Theme }) {
  return (
    <span className="relative grid size-6 shrink-0 place-items-center overflow-hidden rounded-md ring-1 ring-black/10" style={{ background: theme.colors.bg }}>
      <span className="absolute inset-x-0 bottom-0 h-2" style={{ background: theme.colors.surface }} />
      <span className="relative size-2.5 rounded-full" style={{ background: theme.colors.accent }} />
    </span>
  )
}

export function ThemeMenu() {
  const { themeId } = useAppSettings()
  const update = useSettings((state) => state.update)
  const popover = useRef<HTMLDivElement>(null)

  const choose = (id: string): void => {
    update({ themeId: id }).catch((error: unknown) => toast('error', 'Could not change the theme', errorMessage(error)))
    popover.current?.hidePopover()
  }

  return (
    <>
      <button
        type="button"
        popoverTarget="theme-menu"
        aria-haspopup="menu"
        aria-label="Theme"
        title="Theme"
        className="inline-flex size-8 items-center justify-center rounded-lg text-muted transition-colors [anchor-name:--theme-button] hover:bg-hover hover:text-fg"
      >
        <Palette className="size-[17px]" strokeWidth={2} aria-hidden />
      </button>
      <div
        ref={popover}
        id="theme-menu"
        popover="auto"
        className="w-60 [position-anchor:--theme-button] [position-area:bottom_span-left] [position-try-fallbacks:flip-block]"
      >
        <div role="menu" aria-labelledby="theme-menu-title" className="mt-2 max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-elevated p-1.5 shadow-2xl">
          <div id="theme-menu-title" className="px-2 pt-1 pb-1.5 text-2xs font-semibold tracking-wide text-muted uppercase">
            Theme
          </div>
          {[{ id: SYSTEM_THEME_ID, name: 'Match system', theme: null as Theme | null }, ...THEMES.map((theme) => ({ id: theme.id, name: theme.name, theme }))].map(
            (item) => (
              <button
                key={item.id}
                type="button"
                role="menuitemradio"
                aria-checked={themeId === item.id}
                onClick={() => choose(item.id)}
                className={clsx(
                  'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-hover',
                  themeId === item.id && 'font-medium'
                )}
              >
                {item.theme ? (
                  <Swatch theme={item.theme} />
                ) : (
                  <span className="grid size-6 place-items-center rounded-md bg-surface ring-1 ring-line">
                    <Monitor className="size-3.5 text-muted" aria-hidden />
                  </span>
                )}
                <span className="flex-1 truncate">{item.name}</span>
                {themeId === item.id && <Check className="size-4 text-accent-ink" aria-hidden />}
              </button>
            )
          )}
        </div>
      </div>
    </>
  )
}
