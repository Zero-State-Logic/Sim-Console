/* ============================================================
   STATICS — support polygon, stability margin and the vertical
   load each stance foot carries. Pure math on flat arrays, no
   allocation per call (module scratch, max 8 legs).
   ============================================================ */

const MAX_PTS = 8
const order = new Int32Array(MAX_PTS)
const active = new Uint8Array(MAX_PTS)
const dxs = new Float64Array(MAX_PTS)
const dys = new Float64Array(MAX_PTS)

function cross(ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox)
}

/**
 * Convex hull (Andrew's monotone chain) of the points whose mask is non-zero.
 * Writes point indices in CCW order to `hull` and returns the vertex count.
 * Collinear points are dropped.
 */
export function convexHull(px: Float64Array, py: Float64Array, mask: Uint8Array, n: number, hull: Int32Array): number {
  let m = 0
  for (let i = 0; i < n; i++) if (mask[i]) order[m++] = i
  // insertion sort by x, then y (m ≤ 8)
  for (let i = 1; i < m; i++) {
    const v = order[i]
    let j = i - 1
    while (j >= 0 && (px[order[j]] > px[v] || (px[order[j]] === px[v] && py[order[j]] > py[v]))) {
      order[j + 1] = order[j]
      j--
    }
    order[j + 1] = v
  }
  if (m < 3) {
    for (let i = 0; i < m; i++) hull[i] = order[i]
    return m === 2 && px[order[0]] === px[order[1]] && py[order[0]] === py[order[1]] ? 1 : m
  }
  let k = 0
  for (let i = 0; i < m; i++) {
    const p = order[i]
    while (k >= 2 && cross(px[hull[k - 2]], py[hull[k - 2]], px[hull[k - 1]], py[hull[k - 1]], px[p], py[p]) <= 0) k--
    hull[k++] = p
  }
  const lower = k + 1
  for (let i = m - 2; i >= 0; i--) {
    const p = order[i]
    while (k >= lower && cross(px[hull[k - 2]], py[hull[k - 2]], px[hull[k - 1]], py[hull[k - 1]], px[p], py[p]) <= 0) k--
    hull[k++] = p
  }
  return k - 1
}

/** Distance from (cx, cy) to segment a–b. */
export function segmentDistance(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const ex = bx - ax
  const ey = by - ay
  const len2 = ex * ex + ey * ey
  const t = len2 > 0 ? Math.min(Math.max(((cx - ax) * ex + (cy - ay) * ey) / len2, 0), 1) : 0
  return Math.hypot(ax + t * ex - cx, ay + t * ey - cy)
}

/**
 * Signed stability margin: distance from the CoM ground projection to the nearest
 * edge of the support polygon, positive inside, negative outside. With fewer than
 * three support points the polygon has no interior, so the margin is ≤ 0. With no
 * support it is −Infinity.
 */
export function stabilityMargin(px: Float64Array, py: Float64Array, hull: Int32Array, h: number, cx: number, cy: number): number {
  if (h === 0) return -Infinity
  if (h === 1) return -Math.hypot(px[hull[0]] - cx, py[hull[0]] - cy)
  let inside = h >= 3
  let dist = Infinity
  for (let i = 0; i < h; i++) {
    const a = hull[i]
    const b = hull[(i + 1) % h]
    if (h >= 3 && cross(px[a], py[a], px[b], py[b], cx, cy) < 0) inside = false
    dist = Math.min(dist, segmentDistance(px[a], py[a], px[b], py[b], cx, cy))
    if (h === 2) break
  }
  return inside ? dist : -dist
}

export interface LoadResult {
  /** True when the forces satisfy ΣF = W and both moment equations about the CoM. */
  balanced: boolean
  /** Number of feet carrying load. */
  loaded: number
}

const result: LoadResult = { balanced: false, loaded: 0 }

function solveLine(n: number, weight: number, out: Float64Array): boolean {
  // principal axis of the active points: the moment about it cannot be balanced
  let mx = 0
  let my = 0
  let c = 0
  for (let i = 0; i < n; i++) if (active[i]) { mx += dxs[i]; my += dys[i]; c++ }
  mx /= c
  my /= c
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    if (!active[i]) continue
    const ex = dxs[i] - mx
    const ey = dys[i] - my
    sxx += ex * ex
    syy += ey * ey
    sxy += ex * ey
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const ux = Math.cos(ang)
  const uy = Math.sin(ang)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) if (active[i]) { const s = dxs[i] * ux + dys[i] * uy; s1 += s; s2 += s * s }
  const det = c * s2 - s1 * s1
  if (det < 1e-12) {
    for (let i = 0; i < n; i++) out[i] = active[i] ? weight / c : 0
  } else {
    // [c s1; s1 s2] y = [W 0]
    const y0 = (weight * s2) / det
    const y1 = (-weight * s1) / det
    for (let i = 0; i < n; i++) out[i] = active[i] ? y0 + y1 * (dxs[i] * ux + dys[i] * uy) : 0
  }
  // distance of the CoM (the origin here) from the line: the unbalanced moment arm
  return Math.abs(uy * mx - ux * my) < 1e-6
}

function solvePlane(n: number, weight: number, out: Float64Array): boolean {
  // M = Σ [1 dx dy]ᵀ[1 dx dy], b = [W 0 0]; f_i = y0 + y1 dx_i + y2 dy_i (minimum-norm)
  let c = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0
  for (let i = 0; i < n; i++) {
    if (!active[i]) continue
    const x = dxs[i]
    const y = dys[i]
    c++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y
  }
  const det = c * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy)
  if (c < 3) return false
  // collinear (or coincident) points: covariance determinant ≈ 0 relative to its trace²
  const vx = sxx - (sx * sx) / c
  const vy = syy - (sy * sy) / c
  const cov = vx * vy - (sxy - (sx * sy) / c) ** 2
  if (cov <= 1e-6 * (vx + vy) * (vx + vy) || vx + vy < 1e-12) return false
  // first column of M⁻¹ (cofactors / det), times W
  const y0 = (weight * (sxx * syy - sxy * sxy)) / det
  const y1 = (weight * -(sx * syy - sy * sxy)) / det
  const y2 = (weight * (sx * sxy - sy * sxx)) / det
  for (let i = 0; i < n; i++) out[i] = active[i] ? y0 + y1 * dxs[i] + y2 * dys[i] : 0
  return true
}

/**
 * Vertical foot forces for the feet in `contact`, from static equilibrium:
 * ΣF = weight and zero moment about the CoM (cx, cy), the minimum-norm solution
 * (as even as possible). Feet that would need to pull (F < 0) are dropped and the
 * rest re-solved, so every force is ≥ 0. When equilibrium is impossible (CoM
 * outside the support) the remaining feet carry the weight by the lever rule and
 * `balanced` is false. Writes newtons to out[0..n-1].
 */
export function distributeLoad(
  px: Float64Array,
  py: Float64Array,
  contact: Uint8Array,
  n: number,
  cx: number,
  cy: number,
  weight: number,
  out: Float64Array,
): LoadResult {
  let count = 0
  for (let i = 0; i < n; i++) {
    active[i] = contact[i] ? 1 : 0
    count += active[i]
    dxs[i] = px[i] - cx
    dys[i] = py[i] - cy
    out[i] = 0
  }
  for (let iter = 0; iter <= n; iter++) {
    if (count === 0) {
      result.balanced = false
      result.loaded = 0
      return result
    }
    let balanced: boolean
    if (count === 1) {
      let k = 0
      for (let i = 0; i < n; i++) if (active[i]) k = i
      out[k] = weight
      balanced = Math.hypot(dxs[k], dys[k]) < 1e-6
    } else {
      balanced = solvePlane(n, weight, out) || solveLine(n, weight, out)
    }
    let worst = -1
    let worstF = -1e-9
    for (let i = 0; i < n; i++) if (active[i] && out[i] < worstF) { worstF = out[i]; worst = i }
    if (worst < 0) {
      result.balanced = balanced
      result.loaded = count
      return result
    }
    active[worst] = 0
    out[worst] = 0
    count--
  }
  result.balanced = false
  result.loaded = count
  return result
}
