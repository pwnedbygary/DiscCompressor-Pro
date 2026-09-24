import { describe, expect, it } from 'vitest'
import { THEMES } from '@shared/themes'
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
})
