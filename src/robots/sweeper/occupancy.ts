import { CELL_SIZE, GRID_MARGIN } from './constants'

/*
 * Log-odds occupancy grid built only from LiDAR rays: Bresenham carves free space
 * along each ray and marks the end cell occupied when the ray returned. Cell (ix, iy)
 * covers [x0 + ix*cell, x0 + (ix+1)*cell) x [y0 + iy*cell, ...). Row-major, ix fastest.
 */

/** Log-odds increments (p = 0.7 hit, p = 0.4 miss) and clamp, ROS-style. */
export const L_HIT = 0.85
export const L_MISS = -0.4
export const L_MIN = -4
export const L_MAX = 4
/** Classification thresholds: p > 0.65 occupied, p < 0.35 free, else unknown. */
export const L_OCC = 0.62
export const L_FREE = -0.62

export interface GridGeom {
  w: number
  h: number
  cell: number
  x0: number
  y0: number
}

/** Square grid covering the room plus a margin outside the walls, centered on the origin. */
export function makeGridGeom(size: number, cell = CELL_SIZE, margin = GRID_MARGIN): GridGeom {
  const n = Math.ceil((size + 2 * margin) / cell - 1e-6)
  return { w: n, h: n, cell, x0: (-n * cell) / 2, y0: (-n * cell) / 2 }
}

/** Visit every cell of the integer line (x0,y0)-(x1,y1), both endpoints included. */
export function bresenham(x0: number, y0: number, x1: number, y1: number, visit: (x: number, y: number) => void): void {
  const dx = Math.abs(x1 - x0)
  const dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  let x = x0
  let y = y0
  for (;;) {
    visit(x, y)
    if (x === x1 && y === y1) return
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; x += sx }
    if (e2 <= dx) { err += dx; y += sy }
  }
}

/** Capacity of the flip journal; past it the consumer rebuilds from scratch. */
export const FLIP_CAPACITY = 8192

export class OccupancyGrid {
  readonly lo: Float32Array
  /**
   * Bumper layer: cells where the footprint touched something. Kept apart from the
   * log-odds so LiDAR rays passing over a low obstacle cannot carve it free again.
   */
  readonly contact: Uint8Array
  contactCount = 0
  /** Bumped on every change, so views can skip redundant texture uploads. */
  version = 0
  /** Bumped by clear(): consumers of the flip journal must rebuild. */
  epoch = 0
  /**
   * Journal of cells whose occupied / not-occupied classification flipped since the
   * planner last drained it, so inflation is updated per flip instead of per refresh.
   */
  readonly flips = new Int32Array(FLIP_CAPACITY)
  flipCount = 0
  flipOverflow = false

  constructor(readonly geom: GridGeom) {
    this.lo = new Float32Array(geom.w * geom.h)
    this.contact = new Uint8Array(geom.w * geom.h)
  }

  private noteFlip(i: number): void {
    if (this.flipCount < FLIP_CAPACITY) this.flips[this.flipCount++] = i
    else this.flipOverflow = true
  }

  drainFlips(): void {
    this.flipCount = 0
    this.flipOverflow = false
  }

  cellX(x: number): number {
    return Math.floor((x - this.geom.x0) / this.geom.cell)
  }

  cellY(y: number): number {
    return Math.floor((y - this.geom.y0) / this.geom.cell)
  }

  inBounds(ix: number, iy: number): boolean {
    return ix >= 0 && iy >= 0 && ix < this.geom.w && iy < this.geom.h
  }

  /** Add a log-odds delta to one cell, clamped. Out-of-bounds cells are ignored. */
  addLogOdds(ix: number, iy: number, delta: number): void {
    if (!this.inBounds(ix, iy)) return
    const i = iy * this.geom.w + ix
    const old = this.lo[i]
    const v = old + delta
    const next = v < L_MIN ? L_MIN : v > L_MAX ? L_MAX : v
    this.lo[i] = next
    if ((old > L_OCC) !== (next > L_OCC) && this.contact[i] === 0) this.noteFlip(i)
  }

  /** One LiDAR ray from (ox, oy) to (ex, ey): free along the way, occupied at the end if it hit. */
  integrateRay(ox: number, oy: number, ex: number, ey: number, hit: boolean): void {
    let x = this.cellX(ox)
    let y = this.cellY(oy)
    const x1 = this.cellX(ex)
    const y1 = this.cellY(ey)
    const dx = Math.abs(x1 - x)
    const dy = -Math.abs(y1 - y)
    const sx = x < x1 ? 1 : -1
    const sy = y < y1 ? 1 : -1
    let err = dx + dy
    while (x !== x1 || y !== y1) {
      this.addLogOdds(x, y, L_MISS)
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x += sx }
      if (e2 <= dx) { err += dx; y += sy }
    }
    this.addLogOdds(x1, y1, hit ? L_HIT : L_MISS)
    this.version++
  }

  /** Record a bumper contact at a world point (and the cells either side of it). */
  markContact(x: number, y: number): void {
    const ix = this.cellX(x)
    const iy = this.cellY(y)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > 1 || !this.inBounds(ix + dx, iy + dy)) continue
        const i = (iy + dy) * this.geom.w + ix + dx
        if (this.contact[i]) continue
        this.contactCount++
        if (!(this.lo[i] > L_OCC)) this.noteFlip(i)
        this.contact[i] = 1
      }
    }
    this.version++
  }

  isOccupied(i: number): boolean {
    return this.lo[i] > L_OCC || this.contact[i] === 1
  }

  isFree(i: number): boolean {
    return this.lo[i] < L_FREE && this.contact[i] === 0
  }

  clear(): void {
    this.lo.fill(0)
    this.contact.fill(0)
    this.contactCount = 0
    this.drainFlips()
    this.epoch++
    this.version++
  }

  /** Fraction (0..1) of the cells inside the room interior that are known (free or occupied). */
  knownFraction(half: number): number {
    const { w, cell, x0, y0 } = this.geom
    // interior = cells whose center lies inside [-half, half]^2
    const ix0 = Math.max(0, Math.ceil((-half - x0) / cell - 0.5))
    const ix1 = Math.min(w - 1, Math.floor((half - x0) / cell - 0.5))
    const iy0 = Math.max(0, Math.ceil((-half - y0) / cell - 0.5))
    const iy1 = Math.min(this.geom.h - 1, Math.floor((half - y0) / cell - 0.5))
    if (ix1 < ix0 || iy1 < iy0) return 0
    const { lo, contact } = this
    let known = 0
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let i = iy * w + ix0, end = iy * w + ix1; i <= end; i++) {
        const v = lo[i]
        if (v > L_OCC || v < L_FREE || contact[i] === 1) known++
      }
    }
    return known / ((ix1 - ix0 + 1) * (iy1 - iy0 + 1))
  }
}
