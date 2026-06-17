/**
 * Tiny color helpers used by the runtime theme applier.
 *
 * Why we need this: shadcn-style components consume `hsl(var(--primary))`
 * with the variable holding only the HSL triplet ("23 55% 51%"). When the
 * user picks an arbitrary accent hex, we have to compute that triplet in
 * JS — CSS can't extract HSL components from an existing color value.
 *
 * Intentionally dependency-free: a 25-line hexToHsl beats pulling chroma.js
 * for one conversion. Accepts #rgb / #rrggbb (with or without `#`) and
 * returns h ∈ [0,360), s ∈ [0,100], l ∈ [0,100].
 */

export interface Hsl {
  h: number
  s: number
  l: number
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/**
 * Parse a hex color into 0..1 RGB components. Returns null if the input
 * is malformed so callers can fall back to a default rather than blow up.
 */
function parseHex(input: string): { r: number; g: number; b: number } | null {
  const v = input.trim().replace(/^#/, '')
  if (v.length === 3) {
    const r = parseInt(v[0] + v[0], 16)
    const g = parseInt(v[1] + v[1], 16)
    const b = parseInt(v[2] + v[2], 16)
    if ([r, g, b].some(Number.isNaN)) return null
    return { r: r / 255, g: g / 255, b: b / 255 }
  }
  if (v.length === 6) {
    const r = parseInt(v.slice(0, 2), 16)
    const g = parseInt(v.slice(2, 4), 16)
    const b = parseInt(v.slice(4, 6), 16)
    if ([r, g, b].some(Number.isNaN)) return null
    return { r: r / 255, g: g / 255, b: b / 255 }
  }
  return null
}

/**
 * Convert a hex color to HSL components (degrees / percent / percent).
 * Returns null on malformed input.
 */
export function hexToHsl(hex: string): Hsl | null {
  const rgb = parseHex(hex)
  if (!rgb) return null
  const r = clamp01(rgb.r)
  const g = clamp01(rgb.g)
  const b = clamp01(rgb.b)

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2

  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0)
        break
      case g:
        h = (b - r) / d + 2
        break
      case b:
        h = (r - g) / d + 4
        break
    }
    h *= 60
  }

  return {
    h: Math.round(h),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  }
}

/**
 * Format an Hsl as the `H S% L%` triplet shadcn variables expect.
 * Returns null if the input couldn't be converted.
 */
export function hexToHslTriplet(hex: string): string | null {
  const hsl = hexToHsl(hex)
  if (!hsl) return null
  return `${hsl.h} ${hsl.s}% ${hsl.l}%`
}
