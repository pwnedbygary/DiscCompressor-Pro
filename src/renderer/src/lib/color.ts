interface Rgb {
  r: number
  g: number
  b: number
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 }
// Pure black guarantees at least 4.58:1 on any background paired with white.
const BLACK: Rgb = { r: 0, g: 0, b: 0 }

function parseHex(hex: string): Rgb {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? [...value].map((c) => c + c).join('') : value
  const number = Number.parseInt(full, 16)
  return { r: (number >> 16) & 0xff, g: (number >> 8) & 0xff, b: number & 0xff }
}

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

// WCAG 2.x relative luminance and contrast ratio.
function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const s = value / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function ratio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

export function contrast(a: string, b: string): number {
  return ratio(parseHex(a), parseHex(b))
}

/** `color` drawn at `opacity` over `background`, blended the way browsers composite (in sRGB). */
export function blend(color: string, background: string, opacity: number): string {
  const top = parseHex(color)
  const bottom = parseHex(background)
  const channel = (a: number, b: number): number => Math.round(b + (a - b) * opacity)
  return toHex({ r: channel(top.r, bottom.r), g: channel(top.g, bottom.g), b: channel(top.b, bottom.b) })
}

/** Black or white, whichever is easier to read on `background`. */
export function readableOn(background: string): string {
  const bg = parseHex(background)
  return toHex(ratio(WHITE, bg) >= ratio(BLACK, bg) ? WHITE : BLACK)
}

/**
 * Nudge `color` toward white (on dark backgrounds) or black (on light ones)
 * until it reaches `minimum` contrast against every background.
 */
export function ensureContrast(color: string, backgrounds: string[], minimum: number): string {
  const base = parseHex(color)
  const bgs = backgrounds.map(parseHex)
  const passes = (c: Rgb): boolean => bgs.every((bg) => ratio(c, bg) >= minimum)
  if (passes(base)) return color
  const darkest = bgs.reduce((a, b) => (luminance(a) < luminance(b) ? a : b))
  const target = ratio(WHITE, darkest) >= ratio(BLACK, darkest) ? WHITE : BLACK
  const mix = (from: number, to: number, t: number): number => Math.round(from + (to - from) * t)
  for (let step = 1; step <= 20; step += 1) {
    const t = step / 20
    const mixed = { r: mix(base.r, target.r, t), g: mix(base.g, target.g, t), b: mix(base.b, target.b, t) }
    if (passes(mixed)) return toHex(mixed)
  }
  return toHex(target)
}
