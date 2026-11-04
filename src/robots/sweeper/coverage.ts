import { pointInObstacle, type Obstacle } from './geom2d'
import type { GridGeom } from './occupancy'

/*
 * Coverage bookkeeping on ground truth (the brush cleans the real floor, not the map),
 * plus boustrophedon lane planning on the planner's blocked mask.
 * coverage % = covered free cells / all free cells, where a free cell is a cell whose
 * center is inside the room and not inside any obstacle.
 */

export class CoverageMap {
  readonly free: Uint8Array
  readonly covered: Uint8Array
  freeCount = 0
  coveredCount = 0
  version = 0

  constructor(readonly geom: GridGeom) {
    this.free = new Uint8Array(geom.w * geom.h)
    this.covered = new Uint8Array(geom.w * geom.h)
  }

  /** Recompute the ground-truth free mask after an arena edit (covered cells survive). */
  rebuildFree(half: number, obstacles: readonly Obstacle[]): void {
    const { w, h, cell, x0, y0 } = this.geom
    let free = 0
    let covered = 0
    for (let iy = 0; iy < h; iy++) {
      const cy = y0 + (iy + 0.5) * cell
      for (let ix = 0; ix < w; ix++) {
        const cx = x0 + (ix + 0.5) * cell
        const i = iy * w + ix
        let f = Math.abs(cx) < half && Math.abs(cy) < half
        for (let k = 0; f && k < obstacles.length; k++) if (pointInObstacle(cx, cy, obstacles[k])) f = false
        this.free[i] = f ? 1 : 0
        if (f) {
          free++
          if (this.covered[i]) covered++
        } else {
          this.covered[i] = 0
        }
      }
    }
    this.freeCount = free
    this.coveredCount = covered
    this.version++
  }

  /**
   * Mark free cells under the brush: a rectangle `width` across and `depth` along the
   * heading, centered at (x, y). Returns how many cells became covered.
   */
  paint(x: number, y: number, th: number, width: number, depth: number): number {
    const { w, h, cell, x0, y0 } = this.geom
    const c = Math.cos(th), s = Math.sin(th)
    const hd = depth / 2, hw = width / 2
    const ex = hd * Math.abs(c) + hw * Math.abs(s)
    const ey = hd * Math.abs(s) + hw * Math.abs(c)
    const ix0 = Math.max(0, Math.floor((x - ex - x0) / cell))
    const ix1 = Math.min(w - 1, Math.floor((x + ex - x0) / cell))
    const iy0 = Math.max(0, Math.floor((y - ey - y0) / cell))
    const iy1 = Math.min(h - 1, Math.floor((y + ey - y0) / cell))
    let added = 0
    for (let iy = iy0; iy <= iy1; iy++) {
      const dy = y0 + (iy + 0.5) * cell - y
      for (let ix = ix0; ix <= ix1; ix++) {
        const i = iy * w + ix
        if (!this.free[i] || this.covered[i]) continue
        const dx = x0 + (ix + 0.5) * cell - x
        if (Math.abs(c * dx + s * dy) > hd || Math.abs(-s * dx + c * dy) > hw) continue
        this.covered[i] = 1
        added++
      }
    }
    if (added) {
      this.coveredCount += added
      this.version++
    }
    return added
  }

  percent(): number {
    return this.freeCount ? (100 * this.coveredCount) / this.freeCount : 0
  }

  clear(): void {
    this.covered.fill(0)
    this.coveredCount = 0
    this.version++
  }
}

/** One boustrophedon lane: sweep from xs to xe along row y. */
export interface Lane {
  row: number
  y: number
  xs: number
  xe: number
}

/** Shortest free run worth sweeping, meters. */
const MIN_LANE = 0.1
/**
 * Lane spacing is the brush width less an 8 % overlap: with spacing exactly equal to the
 * brush, cells on the seam between two lanes depend on rounding and tracking error.
 */
export const LANE_OVERLAP = 0.08

export function laneSpacing(brush: number): number {
  return Math.max(0.05, brush * (1 - LANE_OVERLAP))
}

/**
 * Row y positions from the first to the last unblocked band, `spacing` apart. Rows sit
 * 1.5 cells inside the inflation boundary: a wall surface can land in either of two
 * cells, and a row right on the boundary flickers between blocked and free.
 */
export function laneRows(half: number, radius: number, spacing: number, cell: number): number[] {
  const lo = -half + radius + 1.5 * cell
  const hi = half - radius - 1.5 * cell
  if (hi < lo) return [0]
  const rows: number[] = []
  for (let y = lo; y <= hi + 1e-9; y += spacing) rows.push(y)
  if (hi - rows[rows.length - 1] > spacing * 0.3) rows.push(hi)
  return rows
}

/**
 * Boustrophedon lanes over the free (unblocked) space: rows along x, alternating
 * direction, each row split into the free runs between blocked cells, in sweep order.
 */
export function planLanes(blocked: Uint8Array, geom: GridGeom, half: number, rows: readonly number[]): Lane[] {
  const { w, cell, x0, y0 } = geom
  const lanes: Lane[] = []
  rows.forEach((y, row) => {
    const iy = Math.floor((y - y0) / cell)
    if (iy < 0 || iy >= geom.h) return
    const runs: [number, number][] = []
    let start = -1
    for (let ix = 0; ix <= w; ix++) {
      const cx = x0 + (ix + 0.5) * cell
      const open = ix < w && Math.abs(cx) < half && !blocked[iy * w + ix]
      if (open && start < 0) start = ix
      if (!open && start >= 0) {
        // ends pulled in one cell for the same reason as the row inset
        const xa = x0 + (start + 1.5) * cell
        const xb = x0 + (ix - 1.5) * cell
        if (xb - xa >= MIN_LANE) runs.push([xa, xb])
        start = -1
      }
    }
    const forward = row % 2 === 0
    const ordered = forward ? runs : runs.slice().reverse()
    for (const [xa, xb] of ordered) lanes.push({ row, y, xs: forward ? xa : xb, xe: forward ? xb : xa })
  })
  return lanes
}

/**
 * Index of the next lane after progress (row, x): the first lane in sweep order on a
 * later row, or on the same row starting beyond x in that row's direction. -1 = done.
 */
export function nextLane(lanes: readonly Lane[], row: number, x: number): number {
  for (let i = 0; i < lanes.length; i++) {
    const l = lanes[i]
    if (l.row > row) return i
    if (l.row === row) {
      const dir = l.xe >= l.xs ? 1 : -1
      if (dir * (l.xs - x) > 0.05) return i
    }
  }
  return -1
}
