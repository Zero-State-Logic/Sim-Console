/*
 * Radial gauge geometry. Angles are degrees, counter-clockwise from +x (math
 * convention); SVG y points down, so points use cy - r·sin(a). The gauge sweeps 240°
 * clockwise from lower-left (210°) to lower-right (-30°), like the reference dials.
 */

export const GAUGE_START_DEG = 210
export const GAUGE_SWEEP_DEG = 240

export function gaugeFraction(v: number, min: number, max: number): number {
  const span = max - min
  if (!Number.isFinite(v) || !Number.isFinite(span) || span === 0) return 0
  return Math.min(Math.max((v - min) / span, 0), 1)
}

export function arcPoint(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)]
}

const f2 = (n: number): string => (Math.round(n * 100) / 100).toString()

/** SVG path of an arc swept clockwise by `sweepDeg` from `startDeg`. Empty for no sweep. */
export function arcPath(cx: number, cy: number, r: number, startDeg: number, sweepDeg: number): string {
  if (!(sweepDeg > 0)) return ''
  const sweep = Math.min(sweepDeg, 359.99)
  const [sx, sy] = arcPoint(cx, cy, r, startDeg)
  const [ex, ey] = arcPoint(cx, cy, r, startDeg - sweep)
  const large = sweep > 180 ? 1 : 0
  return `M ${f2(sx)} ${f2(sy)} A ${f2(r)} ${f2(r)} 0 ${large} 1 ${f2(ex)} ${f2(ey)}`
}

/** Value arc for fraction f of the gauge sweep. */
export function gaugeArc(cx: number, cy: number, r: number, f: number): string {
  return arcPath(cx, cy, r, GAUGE_START_DEG, GAUGE_SWEEP_DEG * Math.min(Math.max(f, 0), 1))
}

/** Tick marks as [x1, y1, x2, y2] from radius r0 to r1, `count` intervals. */
export function gaugeTicks(cx: number, cy: number, r0: number, r1: number, count: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = []
  for (let i = 0; i <= count; i++) {
    const deg = GAUGE_START_DEG - (GAUGE_SWEEP_DEG * i) / count
    const [x1, y1] = arcPoint(cx, cy, r0, deg)
    const [x2, y2] = arcPoint(cx, cy, r1, deg)
    out.push([x1, y1, x2, y2])
  }
  return out
}

/** Decimal places that suit a gauge range: wide ranges read as integers. */
export function gaugeDigits(min: number, max: number): number {
  const span = Math.abs(max - min)
  if (span <= 2) return 2
  if (span <= 20) return 1
  return 0
}

export function formatGaugeValue(v: number, digits: number): string {
  if (!Number.isFinite(v)) return '—'
  const s = v.toFixed(digits)
  // avoid "-0" / "-0.0" flicker around zero
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s
}
