import type { ControlDef, SelectDef, SelectOption } from '../../core/types'

/* Pure helpers behind the generic control renderer. */

export interface ControlGroup {
  group: string
  defs: ControlDef[]
}

/** Visible controls grouped into panels, both in schema order. */
export function groupControls(schema: readonly ControlDef[]): ControlGroup[] {
  const out: ControlGroup[] = []
  const index = new Map<string, ControlGroup>()
  for (const d of schema) {
    if (d.hidden) continue
    let g = index.get(d.group)
    if (!g) {
      g = { group: d.group, defs: [] }
      index.set(d.group, g)
      out.push(g)
    }
    g.defs.push(d)
  }
  return out
}

export function sliderFraction(v: number, min: number, max: number): number {
  const span = max - min
  if (!Number.isFinite(v) || span === 0 || !Number.isFinite(span)) return 0
  return Math.min(Math.max((v - min) / span, 0), 1)
}

/** Default decimals from the step when the schema gives none (0.05 → 2, 1 → 0). */
export function digitsForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0 || step >= 1) return 0
  return Math.min(Math.ceil(-Math.log10(step) - 1e-9), 6)
}

export function formatControlValue(v: number, digits: number): string {
  if (!Number.isFinite(v)) return '—'
  const s = v.toFixed(Math.max(0, Math.min(digits, 6)))
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s
}

/** The value a press-and-hold control falls back to on release, or null if it latches. */
export function releaseValue(def: SelectDef): string | null {
  if (def.key !== 'dir' || def.display !== 'grid3') return null
  return def.options.some((o) => o.value === 'stop') ? 'stop' : null
}

/** Nine pad cells in row-major order; missing options become null placeholders. */
export function gridCells(options: readonly SelectOption[]): (SelectOption | null)[] {
  const cells: (SelectOption | null)[] = options.slice(0, 9)
  while (cells.length < 9) cells.push(null)
  return cells
}

/** Default glyphs for the shared direction values when a module gives no icon. */
export const DIR_GLYPHS: Readonly<Record<string, string>> = {
  fl: '↖',
  f: '↑',
  fr: '↗',
  l: '←',
  stop: '■',
  r: '→',
  bl: '↙',
  b: '↓',
  br: '↘',
  ccw: '⟲',
  none: '·',
  cw: '⟳',
}

/** Short, unique-enough DOM id for a control. */
export function controlId(key: string): string {
  return `ctl-${key.replace(/[^\w-]/g, '_')}`
}
