/*
 * Color helpers. Modules give colors as CSS values or token vars ('var(--l1)'); canvas
 * drawing (uPlot) needs concrete colors, so vars are resolved against the document.
 */

/** 'var(--l1)' or 'var(--l1, #fff)' → '--l1'; anything else → null. */
export function parseCssVar(color: string): string | null {
  const m = /^\s*var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)\s*$/.exec(color)
  return m ? m[1] : null
}

/** Fallback inside var(--x, fallback), if any. */
export function cssVarFallback(color: string): string | null {
  const m = /^\s*var\(\s*--[\w-]+\s*,\s*([^)]+)\)\s*$/.exec(color)
  return m ? m[1].trim() : null
}

/** Hex (#rgb / #rrggbb / #rrggbbaa) or rgb()/rgba() with a new alpha. Other forms pass through. */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.min(Math.max(alpha, 0), 1)
  const c = color.trim()
  let m = /^#([0-9a-f]{3})$/i.exec(c)
  if (m) {
    const [r, g, b] = m[1].split('').map((h) => parseInt(h + h, 16))
    return `rgba(${r},${g},${b},${a})`
  }
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(c)
  if (m) {
    const n = parseInt(m[1], 16)
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c)
  if (rgb) return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${a})`
  return c
}

/** Fixed order of the per-leg tokens, used when a module gives no item colors. */
export const CATEGORICAL_VARS = ['--l1', '--l2', '--l3', '--l4', '--l5', '--l6', '--l7', '--l8'] as const

export function categoricalColor(i: number): string {
  return `var(${CATEGORICAL_VARS[((i % 8) + 8) % 8]})`
}
