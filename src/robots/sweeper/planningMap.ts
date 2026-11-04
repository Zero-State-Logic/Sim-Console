import { GridAStar, lineOfSight, nearestFree, smoothPath } from './astar'
import type { OccupancyGrid } from './occupancy'

/*
 * The planner's view of the LiDAR map: occupied cells inflated by the robot radius plus
 * a margin, unknown cells treated as free so the robot explores, and the outer ring of
 * the grid blocked (map bounds). World-coordinate wrappers around A*, smoothing and
 * line-of-sight live here.
 *
 * Inflation is incremental: every occupied cell stamps a disc of cells within the
 * radius (dx^2 + dy^2 <= r^2, the exact Euclidean criterion), counted per cell. The grid
 * journals the cells whose classification flipped, so a refresh only re-stamps those
 * instead of re-inflating the whole map; a new radius or a cleared map rebuilds.
 * Before A* runs, a bounded flood fill from the goal detects goals in closed pockets
 * (a target behind furniture against a wall) and snaps them out, so an unreachable
 * target never costs a whole-grid search.
 */

/** Max waypoints of one planned path (world points). */
export const MAX_PATH_POINTS = 512

/** Largest region (cells, 7.5 m^2 at 5 cm) the pocket check explores before handing over to A*. */
export const POCKET_LIMIT = 3000

const DX = [1, -1, 0, 0, 1, 1, -1, -1]
const DY = [0, 0, 1, -1, 1, -1, 1, -1]

export class PlanningMap {
  readonly blocked: Uint8Array
  /** Inflation radius, meters. */
  radius = 0.25
  /** Bumped whenever `blocked` changes. */
  version = 0
  readonly w: number
  readonly h: number
  readonly cell: number
  /** Occupied cells whose disc covers each cell. */
  private readonly count: Uint16Array
  /** The classification this map last inflated (1 = occupied). */
  private readonly occ: Uint8Array
  private disc = new Int32Array(0)
  private builtRadius = -1
  private builtEpoch = -1
  private readonly astar: GridAStar
  private readonly cells: Int32Array
  private readonly smooth: Int32Array
  /** Generation-stamped visit marks of the pocket flood fill (no clearing per call). */
  private readonly mark: Uint32Array
  private markGen = 0
  private readonly queue: Int32Array
  private pocketSize = 0
  /** Scratch mask: blocked cells plus the pocket being snapped out of. */
  private readonly mask: Uint8Array

  constructor(readonly grid: OccupancyGrid) {
    const { w, h, cell } = grid.geom
    this.w = w
    this.h = h
    this.cell = cell
    const n = w * h
    this.blocked = new Uint8Array(n)
    this.count = new Uint16Array(n)
    this.occ = new Uint8Array(n)
    this.astar = new GridAStar(w, h)
    this.cells = new Int32Array(n)
    this.smooth = new Int32Array(n)
    this.mark = new Uint32Array(n)
    this.queue = new Int32Array(POCKET_LIMIT)
    this.mask = new Uint8Array(n)
  }

  /** Bring the blocked mask up to date with the occupancy grid. */
  refresh(): void {
    const r = this.radius / this.cell
    if (r !== this.builtRadius || this.grid.epoch !== this.builtEpoch || this.grid.flipOverflow) this.rebuild(r)
    else this.applyFlips()
    this.grid.drainFlips()
  }

  private rebuild(r: number): void {
    const { w, h } = this
    const rc = Math.floor(r)
    const offs: number[] = []
    for (let dy = -rc; dy <= rc; dy++) for (let dx = -rc; dx <= rc; dx++) if (dx * dx + dy * dy <= r * r) offs.push(dx, dy)
    this.disc = Int32Array.from(offs)
    this.count.fill(0)
    this.occ.fill(0)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.blocked[y * w + x] = this.border(x, y) ? 1 : 0
    for (let i = 0; i < w * h; i++) {
      if (!this.grid.isOccupied(i)) continue
      this.occ[i] = 1
      this.stamp(i, 1)
    }
    this.builtRadius = r
    this.builtEpoch = this.grid.epoch
    this.version++
  }

  private applyFlips(): void {
    const { flips, flipCount } = this.grid
    let changed = false
    for (let k = 0; k < flipCount; k++) {
      const i = flips[k]
      const now = this.grid.isOccupied(i) ? 1 : 0
      // a cell can flip and flip back between refreshes: only real changes are stamped
      if (now === this.occ[i]) continue
      this.occ[i] = now
      this.stamp(i, now ? 1 : -1)
      changed = true
    }
    if (changed) this.version++
  }

  private stamp(i: number, d: number): void {
    const { w, h, disc } = this
    const cx = i % w, cy = (i / w) | 0
    for (let k = 0; k < disc.length; k += 2) {
      const x = cx + disc[k], y = cy + disc[k + 1]
      if (x < 0 || y < 0 || x >= w || y >= h) continue
      const j = y * w + x
      this.count[j] += d
      this.blocked[j] = this.count[j] > 0 || this.border(x, y) ? 1 : 0
    }
  }

  private border(x: number, y: number): boolean {
    return x === 0 || y === 0 || x === this.w - 1 || y === this.h - 1
  }

  /** Cell index of a world point, clamped into the grid. */
  cellOf(x: number, y: number): number {
    const ix = Math.min(this.w - 1, Math.max(0, this.grid.cellX(x)))
    const iy = Math.min(this.h - 1, Math.max(0, this.grid.cellY(y)))
    return iy * this.w + ix
  }

  centerX(i: number): number {
    return this.grid.geom.x0 + ((i % this.w) + 0.5) * this.cell
  }

  centerY(i: number): number {
    return this.grid.geom.y0 + (((i / this.w) | 0) + 0.5) * this.cell
  }

  isBlockedAt(x: number, y: number): boolean {
    return this.blocked[this.cellOf(x, y)] === 1
  }

  /** Line of sight between two world points through unblocked cells. */
  segmentFree(x0: number, y0: number, x1: number, y1: number): boolean {
    const a = this.cellOf(x0, y0), b = this.cellOf(x1, y1)
    const w = this.w
    return lineOfSight(this.blocked, w, this.h, a % w, (a / w) | 0, b % w, (b / w) | 0)
  }

  /**
   * Bounded flood fill from goal cell `g` with A*'s moves (8-connected, no corner
   * cutting). True when it runs out of cells within POCKET_LIMIT without meeting the
   * start `s`: the goal sits in a closed pocket. A large region is not explored (it is
   * left to A*), so the check costs at most the size of a pocket.
   */
  private enclosed(g: number, s: number): boolean {
    const { w, h, blocked, mark, queue } = this
    const gen = ++this.markGen
    let head = 0
    let tail = 0
    mark[g] = gen
    queue[tail++] = g
    while (head < tail) {
      const cur = queue[head++]
      if (cur === s) return false
      const cx = cur % w, cy = (cur / w) | 0
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k], ny = cy + DY[k]
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const ni = ny * w + nx
        if (mark[ni] === gen || blocked[ni]) continue
        if (k >= 4 && (blocked[cy * w + nx] || blocked[ny * w + cx])) continue
        mark[ni] = gen
        if (tail >= POCKET_LIMIT) return false
        queue[tail++] = ni
      }
    }
    this.pocketSize = tail
    return true
  }

  /** True when world goal (gx, gy) is inside a closed pocket that the start (sx, sy) is not in. */
  goalEnclosed(sx: number, sy: number, gx: number, gy: number): boolean {
    const g = this.cellOf(gx, gy)
    return this.blocked[g] === 0 && this.enclosed(g, this.cellOf(sx, sy))
  }

  /** Nearest free cell outside the pocket the last enclosed() call filled, or -1. */
  private outsidePocket(g: number, s: number, maxCells: number): number {
    const mask = this.mask
    mask.set(this.blocked)
    for (let k = 0; k < this.pocketSize; k++) mask[this.queue[k]] = 1
    const w = this.w
    return nearestFree(mask, w, this.h, g % w, (g / w) | 0, maxCells, s % w, (s / w) | 0)
  }

  /**
   * A* + smoothing from (sx, sy) to (gx, gy). A start inside the inflation is moved to the
   * nearest free cell; so is a blocked goal (snapped). A goal in a closed pocket is
   * snapped to the nearest cell outside it, within 1 m. Writes world points
   * [x0, y0, x1, ...] into `out`, starting at the robot position, and returns the point
   * count (0 = no path).
   */
  plan(sx: number, sy: number, gx: number, gy: number, out: Float64Array): number {
    const { w, h, blocked } = this
    let s = this.cellOf(sx, sy)
    if (blocked[s]) s = nearestFree(blocked, w, h, s % w, (s / w) | 0, Math.ceil(0.6 / this.cell))
    if (s < 0) return 0
    const reach = Math.ceil(1.0 / this.cell)
    let g = this.cellOf(gx, gy)
    let snapped = blocked[g] === 1
    if (snapped) g = nearestFree(blocked, w, h, g % w, (g / w) | 0, reach, s % w, (s / w) | 0)
    if (g < 0) return 0
    if (this.enclosed(g, s)) {
      g = this.outsidePocket(g, s, reach)
      snapped = true
      if (g < 0) return 0
    }
    const n = this.astar.search(blocked, s, g, this.cells)
    if (n === 0) return 0
    const m = smoothPath(blocked, w, h, this.cells, n, this.smooth)
    const cap = Math.min(MAX_PATH_POINTS, out.length >> 1)
    let k = 0
    out[k++] = sx
    out[k++] = sy
    const startMoved = this.cellOf(sx, sy) !== s
    for (let i = startMoved ? 0 : 1; i < m - 1 && (k >> 1) < cap - 1; i++) {
      out[k++] = this.centerX(this.smooth[i])
      out[k++] = this.centerY(this.smooth[i])
    }
    out[k++] = snapped ? this.centerX(g) : gx
    out[k++] = snapped ? this.centerY(g) : gy
    return k >> 1
  }
}

/** Polyline length of `n` packed world points. */
export function pathLength(pts: Float64Array, n: number, from = 0): number {
  let len = 0
  for (let i = Math.max(1, from + 1); i < n; i++) {
    len += Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1])
  }
  return len
}
