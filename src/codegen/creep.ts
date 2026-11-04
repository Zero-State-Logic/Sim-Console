/* ============================================================
   QUADRUPED CREEP FOR THE ON-BOARD GAIT — the reference math the
   generated C++ and Python copy. A 4-leg crawl has only three feet
   down while one swings, so the body must sit inside that support
   triangle before the foot lifts (McGhee). Same method as the sim
   (src/robots/walker/creep.ts + gaitEngine): sway the body to the
   triangle's creep point, and hold the lift-off until it is there.
   Pure 2D math in the gait frame (REP-103 x, y; meters).
   ============================================================ */

/** Tuning shared by every generated build (all editable in the firmware). */
export const CREEP = {
  /** The body aims this far inside the support triangle, m. */
  margin: 0.025,
  /** A foot lifts only once the body is at least this far inside the other three feet, m. */
  gate: 0.008,
  /** Sway low-pass time constant, s. */
  tauS: 0.03,
  /** Top body sway speed, m/s (hobby-servo joint rates). */
  maxSpeed: 0.35,
  /** The body reaches the next triangle after this fraction of the four-feet phase. */
  arrive: 0.85,
  /** Below this step-height fraction a "swing" barely leaves the ground: no gate. */
  minLift: 0.05,
} as const

/** Triangle as [ax, ay, bx, by, cx, cy]. */
export type Tri = [number, number, number, number, number, number]

/** Signed distance from P to the nearest edge line of the triangle: + inside, - outside. */
export function triMargin(t: Tri, px: number, py: number): number {
  const orient = (t[2] - t[0]) * (t[5] - t[1]) - (t[3] - t[1]) * (t[4] - t[0]) >= 0 ? 1 : -1
  let best = Infinity
  for (let e = 0; e < 3; e++) {
    const x0 = t[e * 2]
    const y0 = t[e * 2 + 1]
    const n = ((e + 1) % 3) * 2
    const ex = t[n] - x0
    const ey = t[n + 1] - y0
    const len = Math.hypot(ex, ey)
    const d = len > 1e-9 ? (orient * (ex * (py - y0) - ey * (px - x0))) / len : -Infinity
    if (d < best) best = d
  }
  return best
}

/**
 * Creep point: on the way from the un-swayed body (origin) to the incentre, the first
 * point CREEP.margin inside the triangle (the incentre itself if the triangle is
 * smaller). Margin is concave over the triangle, so the blend is safe. Null if degenerate.
 */
export function creepPoint(t: Tri, margin: number = CREEP.margin): [number, number] | null {
  const a = Math.hypot(t[4] - t[2], t[5] - t[3])
  const b = Math.hypot(t[0] - t[4], t[1] - t[5])
  const c = Math.hypot(t[2] - t[0], t[3] - t[1])
  const p = a + b + c
  const area2 = Math.abs((t[2] - t[0]) * (t[5] - t[1]) - (t[3] - t[1]) * (t[4] - t[0]))
  if (p < 1e-9 || area2 < 1e-6 * p * p) return null
  const ix = (a * t[0] + b * t[2] + c * t[4]) / p
  const iy = (a * t[1] + b * t[3] + c * t[5]) / p
  const r = triMargin(t, ix, iy)
  const m0 = triMargin(t, 0, 0)
  const k = m0 >= margin ? 0 : r > m0 ? Math.min(1, (margin - m0) / (r - m0)) : 1
  return [ix * k, iy * k]
}

/** The triangle of the three feet other than `skip` (4-leg robots). */
export function supportTri(fx: readonly number[], fy: readonly number[], skip: number): Tri {
  const t: number[] = []
  for (let k = 0; k < 4; k++) if (k !== skip) t.push(fx[k], fy[k])
  return t as Tri
}

/** 0 → 1 with zero slope at both ends. */
export function smoothstep(u: number): number {
  const v = u <= 0 ? 0 : u >= 1 ? 1 : u
  return v * v * (3 - 2 * v)
}
