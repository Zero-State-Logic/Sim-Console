import type { Obstacle } from './geom2d'

/*
 * Analytic 2D ray casts for the LD06 model: the room interior (square walls), oriented
 * boxes (slab method in the box frame) and circles (quadratic). Directions are unit
 * vectors; results are distances along the ray, Infinity when nothing is hit.
 */

/** Distance from an inside point to the square room wall [-half, half]^2. */
export function rayRoom(ox: number, oy: number, dx: number, dy: number, half: number): number {
  let t = Infinity
  if (dx > 1e-12) t = Math.min(t, (half - ox) / dx)
  else if (dx < -1e-12) t = Math.min(t, (-half - ox) / dx)
  if (dy > 1e-12) t = Math.min(t, (half - oy) / dy)
  else if (dy < -1e-12) t = Math.min(t, (-half - oy) / dy)
  return t < 0 ? 0 : t
}

/** Oriented box given by center, half extents and cos/sin of its yaw. 0 when the origin is inside. */
export function rayObb(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, hx: number, hy: number, c: number, s: number): number {
  const px = ox - cx, py = oy - cy
  const lox = c * px + s * py
  const loy = -s * px + c * py
  const ldx = c * dx + s * dy
  const ldy = -s * dx + c * dy
  let tmin = -Infinity
  let tmax = Infinity
  if (Math.abs(ldx) < 1e-12) {
    if (Math.abs(lox) > hx) return Infinity
  } else {
    const t1 = (-hx - lox) / ldx
    const t2 = (hx - lox) / ldx
    tmin = Math.max(tmin, Math.min(t1, t2))
    tmax = Math.min(tmax, Math.max(t1, t2))
  }
  if (Math.abs(ldy) < 1e-12) {
    if (Math.abs(loy) > hy) return Infinity
  } else {
    const t1 = (-hy - loy) / ldy
    const t2 = (hy - loy) / ldy
    tmin = Math.max(tmin, Math.min(t1, t2))
    tmax = Math.min(tmax, Math.max(t1, t2))
  }
  if (tmax < tmin || tmax < 0) return Infinity
  return tmin < 0 ? 0 : tmin
}

/** Circle. 0 when the origin is inside. */
export function rayCircle(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, r: number): number {
  const px = ox - cx, py = oy - cy
  const b = px * dx + py * dy
  const cc = px * px + py * py - r * r
  if (cc <= 0) return 0
  const disc = b * b - cc
  if (disc < 0) return Infinity
  const t = -b - Math.sqrt(disc)
  return t >= 0 ? t : Infinity
}

/*
 * Packed scene: obstacle data precomputed once per arena edit so a ray never
 * evaluates cos/sin. Box record: kind 0, cx, cy, hx, hy, cos, sin. Circle: kind 1, cx, cy, r.
 * The LD06 scans a single horizontal plane, so obstacles lower than that plane are left
 * out: the LiDAR looks over them and only the bumper can find them.
 */
const STRIDE = 7

export class RayScene {
  half = 3
  count = 0
  /** Obstacles skipped because they sit below the scan plane (last set()). */
  hidden = 0
  private data = new Float64Array(STRIDE * 64)

  set(half: number, obstacles: readonly Obstacle[], scanHeight = 0): void {
    this.half = half
    if (this.data.length < obstacles.length * STRIDE) this.data = new Float64Array(obstacles.length * STRIDE * 2)
    const d = this.data
    let n = 0
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i]
      if (o.hgt < scanHeight) continue
      const k = n++ * STRIDE
      d[k + 1] = o.x
      d[k + 2] = o.y
      if (o.kind === 'box') {
        d[k] = 0
        d[k + 3] = o.w / 2
        d[k + 4] = o.h / 2
        d[k + 5] = Math.cos(o.a)
        d[k + 6] = Math.sin(o.a)
      } else {
        d[k] = 1
        d[k + 3] = o.r
      }
    }
    this.count = n
    this.hidden = obstacles.length - n
  }

  /** Nearest hit distance along a unit ray from an origin inside the room. */
  cast(ox: number, oy: number, dx: number, dy: number): number {
    let t = rayRoom(ox, oy, dx, dy, this.half)
    const d = this.data
    for (let i = 0; i < this.count; i++) {
      const k = i * STRIDE
      const h = d[k] === 0
        ? rayObb(ox, oy, dx, dy, d[k + 1], d[k + 2], d[k + 3], d[k + 4], d[k + 5], d[k + 6])
        : rayCircle(ox, oy, dx, dy, d[k + 1], d[k + 2], d[k + 3])
      if (h < t) t = h
    }
    return t
  }
}
