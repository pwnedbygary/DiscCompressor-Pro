import { type Theme, resolveTheme } from '@shared/themes'
import { blend, contrast, ensureContrast, readableOn } from './color'

const TEXT_CONTRAST = 4.5
/** The strongest tint text is drawn on: selected rows, badges and pressed buttons use 8–15%. */
const TINT = 0.15
/** The strongest hover overlay (--c-hover in index.css): the text colour at 7%. */
const HOVER = 0.07

let darkQuery: MediaQueryList | null = null

function prefersDarkQuery(): MediaQueryList {
  darkQuery ??= window.matchMedia('(prefers-color-scheme: dark)')
  return darkQuery
}

export function prefersDark(): boolean {
  return prefersDarkQuery().matches
}

/**
 * The backgrounds text can appear on: the plain surfaces, the surfaces under
 * the hover overlay, and each surface with `tints` drawn over it.
 */
export function textBackgrounds(theme: Theme, tints: string[] = []): string[] {
  const { colors } = theme
  const surfaces = [colors.bg, colors.surface, colors.elevated]
  const hovered = surfaces.map((surface) => blend(colors.text, surface, HOVER))
  return [...surfaces, ...hovered, ...[colors.accent, ...tints].flatMap((tint) => surfaces.map((surface) => blend(tint, surface, TINT)))]
}

/**
 * CSS variables for a theme. The palette is used as-is for backgrounds; text
 * colours and labels on coloured buttons are adjusted where needed to reach
 * WCAG AA contrast (4.5:1) on every surface they appear on, including accent
 * tints (selected rows) and, for status colours, their own tint (badges).
 */
export function themeVariables(theme: Theme): Record<string, string> {
  const { colors } = theme
  const ink = (color: string, ownTint = false): string => ensureContrast(color, textBackgrounds(theme, ownTint ? [color] : []), TEXT_CONTRAST)
  return {
    '--c-bg': colors.bg,
    '--c-surface': colors.surface,
    '--c-elevated': colors.elevated,
    '--c-line': colors.border,
    '--c-accent': colors.accent,
    '--c-success': colors.success,
    '--c-danger': colors.danger,
    '--c-warning': colors.warning,
    '--c-info': colors.info,
    '--c-fg': ink(colors.text),
    '--c-muted': ink(colors.muted),
    '--c-accent-ink': ink(colors.accent),
    // Opaque, so that a hovered row cannot lower the contrast of the text drawn on it.
    '--c-highlight': blend(colors.accent, colors.surface, TINT),
    '--c-success-ink': ink(colors.success, true),
    '--c-danger-ink': ink(colors.danger, true),
    '--c-warning-ink': ink(colors.warning, true),
    '--c-info-ink': ink(colors.info, true),
    '--c-accent-fg': contrast(colors.accentText, colors.accent) >= TEXT_CONTRAST ? colors.accentText : readableOn(colors.accent),
    '--c-success-fg': readableOn(colors.success),
    '--c-danger-fg': readableOn(colors.danger)
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries(themeVariables(theme))) root.style.setProperty(name, value)
  root.style.colorScheme = theme.dark ? 'dark' : 'light'
}

/**
 * Apply the current theme and keep following the OS light/dark preference
 * while it is "system". Returns a function that re-applies the theme.
 */
export function watchTheme(getThemeId: () => string): () => void {
  const query = prefersDarkQuery()
  const update = (): void => applyTheme(resolveTheme(getThemeId(), query.matches))
  update()
  query.addEventListener('change', update)
  return update
}
