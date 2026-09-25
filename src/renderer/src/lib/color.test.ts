import { describe, expect, it } from 'vitest'
import { THEMES, findTheme } from '@shared/themes'
import css from '../styles/index.css?raw'
import { blend, contrast, ensureContrast, readableOn } from './color'
import { textBackgrounds, themeVariables } from './theme'

describe('contrast', () => {
  it('matches the WCAG reference values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
  })

  it('picks black or white text for a background', () => {
    expect(readableOn('#ffff00')).toBe('#000000')
    expect(readableOn('#1a1b26')).toBe('#ffffff')
  })

  it('only changes colours that fall short', () => {
    expect(ensureContrast('#ffffff', ['#000000'], 4.5)).toBe('#ffffff')
    const fixed = ensureContrast('#5e0b0b', ['#1e0f1d'], 4.5)
    expect(contrast(fixed, '#1e0f1d')).toBeGreaterThanOrEqual(4.5)
  })

  it('blends a colour over a background like an alpha layer', () => {
    expect(blend('#ffffff', '#000000', 0.5)).toBe('#808080')
    expect(blend('#3584e4', '#ffffff', 0)).toBe('#ffffff')
    expect(blend('#3584e4', '#ffffff', 1)).toBe('#3584e4')
  })
})

describe('themeVariables', () => {
  it('gives every theme readable text, on plain and tinted backgrounds, and readable button labels', () => {
    for (const theme of THEMES) {
      const vars = themeVariables(theme)
      const inks: [string, string | null][] = [
        ['--c-fg', null],
        ['--c-muted', null],
        ['--c-accent-ink', null],
        ['--c-success-ink', theme.colors.success],
        ['--c-danger-ink', theme.colors.danger],
        ['--c-warning-ink', theme.colors.warning],
        ['--c-info-ink', theme.colors.info]
      ]
      for (const [token, ownTint] of inks) {
        for (const background of textBackgrounds(theme, ownTint ? [ownTint] : [])) {
          expect(contrast(vars[token] as string, background), `${theme.id} ${token} on ${background}`).toBeGreaterThanOrEqual(4.5)
        }
      }
      expect(contrast(vars['--c-accent-fg'] as string, vars['--c-accent'] as string), `${theme.id} accent button`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(vars['--c-success-fg'] as string, vars['--c-success'] as string), `${theme.id} success button`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(vars['--c-danger-fg'] as string, vars['--c-danger'] as string), `${theme.id} danger button`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps text readable on hovered rows and buttons, drawn the way the CSS draws them', () => {
    for (const theme of THEMES) {
      const vars = themeVariables(theme)
      // --c-hover and --c-subtle in index.css: the text colour at 7% and 4% over a surface.
      const hovered = [theme.colors.bg, theme.colors.surface, theme.colors.elevated].flatMap((surface) =>
        [0.07, 0.04].map((alpha) => blend(vars['--c-fg'] as string, surface, alpha))
      )
      for (const token of ['--c-fg', '--c-muted', '--c-accent-ink', '--c-success-ink', '--c-danger-ink', '--c-warning-ink', '--c-info-ink']) {
        for (const background of hovered) {
          expect(contrast(vars[token] as string, background), `${theme.id} ${token} on ${background}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('keeps console text and the match underline readable on the search highlight', () => {
    for (const theme of THEMES) {
      const vars = themeVariables(theme)
      const highlight = vars['--c-highlight'] as string
      expect(highlight).toBe(blend(theme.colors.accent, theme.colors.surface, 0.15))
      for (const token of ['--c-fg', '--c-muted', '--c-success-ink', '--c-warning-ink', '--c-danger-ink']) {
        expect(contrast(vars[token] as string, highlight), `${theme.id} ${token} on the highlight`).toBeGreaterThanOrEqual(4.5)
      }
      // Graphical indicators need 3:1 (WCAG 1.4.11).
      expect(contrast(vars['--c-accent-ink'] as string, highlight), `${theme.id} underline`).toBeGreaterThanOrEqual(3)
    }
  })

  it("matches the first-paint colours in index.css, which are Adwaita's", () => {
    const fallback = Object.fromEntries([...css.matchAll(/^\s*(--c-[\w-]+):\s*(#[0-9a-f]{6});/gim)].map((match): [string, string] => [match[1] ?? '', match[2] ?? '']))
    const adwaita = findTheme('adwaita')
    expect(adwaita).toBeDefined()
    for (const [name, value] of Object.entries(themeVariables(adwaita as NonNullable<typeof adwaita>))) expect(fallback[name], name).toBe(value)
  })
})
