import { clsx } from 'clsx'
import { Check, Monitor, Palette } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { SYSTEM_THEME_ID, THEMES, type Theme } from '@shared/themes'
import { errorMessage } from '../lib/errors'
import { useAppSettings, useSettings } from '../store/settings'
import { toast } from '../store/toasts'

const ITEMS = [
  { id: SYSTEM_THEME_ID, name: 'Match system', theme: null as Theme | null },
  ...THEMES.map((theme) => ({ id: theme.id, name: theme.name, theme }))
]

function Swatch({ theme }: { theme: Theme }) {
  return (
    <span className="relative grid size-6 shrink-0 place-items-center overflow-hidden rounded-md ring-1 ring-black/10" style={{ background: theme.colors.bg }}>
      <span className="absolute inset-x-0 bottom-0 h-2" style={{ background: theme.colors.surface }} />
      <span className="relative size-2.5 rounded-full" style={{ background: theme.colors.accent }} />
    </span>
  )
}

/** A menu button (WAI-ARIA menu pattern): arrow keys, Home/End and type-ahead move between the themes. */
export function ThemeMenu() {
  const { themeId } = useAppSettings()
  const update = useSettings((state) => state.update)
  const button = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  /** Which item to focus when the menu opens: the checked one, or the last one after ArrowUp on the button. */
  const focusOnOpen = useRef<'checked' | 'last'>('checked')
  const [open, setOpen] = useState(false)

  const items = (): HTMLElement[] => [...(popover.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]

  useEffect(() => {
    const element = popover.current
    if (!element) return
    const onToggle = (event: Event): void => {
      const opened = (event as ToggleEvent).newState === 'open'
      setOpen(opened)
      if (!opened) return
      const list = items()
      const target = focusOnOpen.current === 'last' ? list.at(-1) : (list.find((item) => item.getAttribute('aria-checked') === 'true') ?? list[0])
      focusOnOpen.current = 'checked'
      target?.focus()
    }
    element.addEventListener('toggle', onToggle)
    return () => element.removeEventListener('toggle', onToggle)
  }, [])

  const close = (): void => {
    popover.current?.hidePopover()
    button.current?.focus()
  }

  const choose = (id: string): void => {
    update({ themeId: id }).catch((error: unknown) => toast('error', 'Could not change the theme', errorMessage(error)))
    close()
  }

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    focusOnOpen.current = event.key === 'ArrowUp' ? 'last' : 'checked'
    popover.current?.showPopover()
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const list = items()
    const index = list.indexOf(document.activeElement as HTMLElement)
    const focusAt = (i: number): void => list[(i + list.length) % list.length]?.focus()
    switch (event.key) {
      case 'ArrowDown':
        focusAt(index + 1)
        break
      case 'ArrowUp':
        focusAt(index < 0 ? -1 : index - 1)
        break
      case 'Home':
        focusAt(0)
        break
      case 'End':
        focusAt(-1)
        break
      case 'Escape':
        close()
        break
      case 'Tab':
        // Focus moves on to the next control; the menu closes behind it.
        popover.current?.hidePopover()
        return
      default: {
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || !/\S/.test(event.key)) return
        const letter = event.key.toLowerCase()
        const after = [...list.slice(index + 1), ...list.slice(0, index + 1)]
        after.find((item) => item.textContent?.trim().toLowerCase().startsWith(letter))?.focus()
      }
    }
    event.preventDefault()
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        popoverTarget="theme-popover"
        aria-haspopup="menu"
        aria-controls="theme-menu"
        aria-expanded={open}
        aria-label="Theme"
        title="Theme"
        onKeyDown={onButtonKeyDown}
        className="inline-flex size-8 items-center justify-center rounded-lg text-muted transition-colors [anchor-name:--theme-button] hover:bg-hover hover:text-fg"
      >
        <Palette className="size-[17px]" strokeWidth={2} aria-hidden />
      </button>
      <div
        ref={popover}
        id="theme-popover"
        popover="auto"
        className="w-60 [position-anchor:--theme-button] [position-area:bottom_span-left] [position-try-fallbacks:flip-block]"
      >
        <div
          id="theme-menu"
          role="menu"
          aria-labelledby="theme-menu-title"
          onKeyDown={onMenuKeyDown}
          className="mt-2 max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-elevated p-1.5 shadow-2xl"
        >
          <div id="theme-menu-title" className="px-2 pt-1 pb-1.5 text-2xs font-semibold tracking-wide text-muted uppercase">
            Theme
          </div>
          {ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={themeId === item.id}
              tabIndex={-1}
              onClick={() => choose(item.id)}
              className={clsx(
                'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:-outline-offset-2',
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
          ))}
        </div>
      </div>
    </>
  )
}
