/* ============================================================
   CREEP GEOMETRY — triangle helpers for the quadruped crawl. A
   leg may only lift once the body is over the triangle of the
   other three planted feet; the safest point of a triangle is its
   incentre (equally far from all three edges). Pure 2D math.
   ============================================================ */

/** Incentre of triangle ABC into out[o..o+1] (side-length-weighted vertices). False if degenerate. */
export function incentre(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, out: Float64Array, o: number): boolean {
  const a = Math.hypot(cx - bx, cy - by)
  const b = Math.hypot(ax - cx, ay - cy)
  const c = Math.hypot(bx - ax, by - ay)
  const p = a + b + c
  const area2 = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax))
  if (p < 1e-12 || area2 < 1e-12 * p * p) return false
  out[o] = (a * ax + b * bx + c * cx) / p
  out[o + 1] = (a * ay + b * by + c * cy) / p
  return true
}

/** Signed distance from P to the nearest edge line of triangle ABC: positive inside, negative outside. */
export function triangleMargin(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): number {
  const orient = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) >= 0 ? 1 : -1
  const edge = (x0: number, y0: number, x1: number, y1: number): number => {
    const ex = x1 - x0
    const ey = y1 - y0
    const len = Math.hypot(ex, ey)
    return len > 0 ? (orient * (ex * (py - y0) - ey * (px - x0))) / len : -Infinity
  }
  return Math.min(edge(ax, ay, bx, by), edge(bx, by, cx, cy), edge(cx, cy, ax, ay))
}

/**
 * The point closest to the origin (the un-swayed body) on the way to the incentre of
 * triangle ABC whose margin inside the triangle is at least `margin` (the incentre
 * itself when the triangle is too small for that). Margin is concave over a convex
 * polygon, so along the segment it stays ≥ the linear blend of its end values. Sways
 * only as far as stability needs, which keeps the body motion within servo reach.
 * Writes out[o..o+1]; false if the triangle is degenerate.
 */
export function creepPoint(
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number, margin: number, out: Float64Array, o: number,
): boolean {
  if (!incentre(ax, ay, bx, by, cx, cy, out, o)) return false
  const r = triangleMargin(ax, ay, bx, by, cx, cy, out[o], out[o + 1])
  const m0 = triangleMargin(ax, ay, bx, by, cx, cy, 0, 0)
  const t = m0 >= margin ? 0 : r > m0 ? Math.min(1, (margin - m0) / (r - m0)) : 1
  out[o] *= t
  out[o + 1] *= t
  return true
}

/** Smooth 0 → 1 with zero slope at both ends. */
export function smoothstep(u: number): number {
  const t = u <= 0 ? 0 : u >= 1 ? 1 : u
  return t * t * (3 - 2 * t)
}
