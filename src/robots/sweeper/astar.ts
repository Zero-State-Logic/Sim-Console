/*
 * Grid A*: 8-connected, octile heuristic (admissible and consistent, so paths are
 * optimal), no corner cutting past blocked cells. All buffers are preallocated per
 * grid size and reset with a generation counter, so a search allocates nothing.
 * Plus supercover line-of-sight and greedy string-pulling path smoothing.
 *
 * Ties: in open space the octile heuristic is exact, so every cell of the whole
 * parallelogram of equally short 8-connected paths has the same f and plain A* expands
 * all of it. Keys are f - TIE * g, which pops the deepest of equal-f nodes first and
 * runs straight at the goal. That equals A* with the heuristic scaled by 1 / (1 - TIE),
 * so a path is at most TIE * cost longer than optimal (3e-5 cells across a 10 m room).
 * Costs and keys are float64 so float rounding cannot swamp the tie-break.
 */

const SQRT2 = Math.SQRT2
const TIE = 1e-7
const DX = [1, -1, 0, 0, 1, 1, -1, -1]
const DY = [0, 0, 1, -1, 1, -1, 1, -1]

export function octile(dx: number, dy: number): number {
  const ax = Math.abs(dx), ay = Math.abs(dy)
  return ax + ay + (SQRT2 - 2) * Math.min(ax, ay)
}

export class GridAStar {
  readonly n: number
  /** Nodes expanded by the last search (diagnostics, tests). */
  expansions = 0
  private g: Float64Array
  private parent: Int32Array
  private seen: Uint32Array
  private closed: Uint32Array
  private gen = 0
  private heapId: Int32Array
  private heapKey: Float64Array
  private heapSize = 0

  constructor(readonly w: number, readonly h: number) {
    this.n = w * h
    this.g = new Float64Array(this.n)
    this.parent = new Int32Array(this.n)
    this.seen = new Uint32Array(this.n)
    this.closed = new Uint32Array(this.n)
    this.heapId = new Int32Array(this.n * 2)
    this.heapKey = new Float64Array(this.n * 2)
  }

  /**
   * Cheapest path from cell `start` to cell `goal` over cells with blocked[i] === 0.
   * Writes cell indices start..goal into `out` and returns the count (0 = no path).
   */
  search(blocked: Uint8Array, start: number, goal: number, out: Int32Array): number {
    const { w, h } = this
    if (start < 0 || goal < 0 || start >= this.n || goal >= this.n || blocked[start] || blocked[goal]) return 0
    const gen = ++this.gen
    this.heapSize = 0
    this.expansions = 0
    const gx = goal % w, gy = (goal / w) | 0
    this.g[start] = 0
    this.parent[start] = -1
    this.seen[start] = gen
    this.push(start, octile(start % w - gx, ((start / w) | 0) - gy))
    while (this.heapSize > 0) {
      const cur = this.pop()
      if (this.closed[cur] === gen) continue
      this.closed[cur] = gen
      this.expansions++
      if (cur === goal) return this.unwind(goal, out)
      const cx = cur % w, cy = (cur / w) | 0
      const gc = this.g[cur]
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k], ny = cy + DY[k]
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const ni = ny * w + nx
        if (blocked[ni] || this.closed[ni] === gen) continue
        // diagonal moves need both orthogonal neighbours free (no corner cutting)
        if (k >= 4 && (blocked[cy * w + nx] || blocked[ny * w + cx])) continue
        const ng = gc + (k >= 4 ? SQRT2 : 1)
        if (this.seen[ni] === gen && ng >= this.g[ni]) continue
        this.seen[ni] = gen
        this.g[ni] = ng
        this.parent[ni] = cur
        this.push(ni, ng * (1 - TIE) + octile(nx - gx, ny - gy))
      }
    }
    return 0
  }

  /** Cost of the last path to `cell` (valid right after a successful search). */
  costTo(cell: number): number {
    return this.seen[cell] === this.gen ? this.g[cell] : Infinity
  }

  private unwind(goal: number, out: Int32Array): number {
    let len = 0
    for (let c = goal; c !== -1; c = this.parent[c]) len++
    if (len > out.length) return 0
    let i = len - 1
    for (let c = goal; c !== -1; c = this.parent[c]) out[i--] = c
    return len
  }

  private push(id: number, key: number): void {
    if (this.heapSize >= this.heapId.length) this.grow()
    let i = this.heapSize++
    const ids = this.heapId, keys = this.heapKey
    while (i > 0) {
      const p = (i - 1) >> 1
      if (keys[p] <= key) break
      ids[i] = ids[p]
      keys[i] = keys[p]
      i = p
    }
    ids[i] = id
    keys[i] = key
  }

  private pop(): number {
    const ids = this.heapId, keys = this.heapKey
    const top = ids[0]
    const n = --this.heapSize
    const lastId = ids[n], lastKey = keys[n]
    let i = 0
    for (;;) {
      let c = 2 * i + 1
      if (c >= n) break
      if (c + 1 < n && keys[c + 1] < keys[c]) c++
      if (keys[c] >= lastKey) break
      ids[i] = ids[c]
      keys[i] = keys[c]
      i = c
    }
    ids[i] = lastId
    keys[i] = lastKey
    return top
  }

  /** Lazy-deletion duplicates can exceed the initial capacity on adversarial grids. */
  private grow(): void {
    const ids = new Int32Array(this.heapId.length * 2)
    const keys = new Float64Array(this.heapKey.length * 2)
    ids.set(this.heapId)
    keys.set(this.heapKey)
    this.heapId = ids
    this.heapKey = keys
  }
}

/**
 * Supercover line of sight between cell centers: every cell the segment touches must be
 * free; when the segment passes exactly through a corner, both side cells are checked.
 */
export function lineOfSight(blocked: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const nx = Math.abs(x1 - x0), ny = Math.abs(y1 - y0)
  const sx = x1 > x0 ? 1 : -1, sy = y1 > y0 ? 1 : -1
  let x = x0, y = y0
  if (!cellFree(blocked, w, h, x, y)) return false
  for (let ix = 0, iy = 0; ix < nx || iy < ny;) {
    const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx
    if (decision === 0) {
      if (!cellFree(blocked, w, h, x + sx, y) || !cellFree(blocked, w, h, x, y + sy)) return false
      x += sx; y += sy; ix++; iy++
    } else if (decision < 0) {
      x += sx; ix++
    } else {
      y += sy; iy++
    }
    if (!cellFree(blocked, w, h, x, y)) return false
  }
  return true
}

function cellFree(blocked: Uint8Array, w: number, h: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < w && y < h && !blocked[y * w + x]
}

/** Greedy string pulling: keep only the waypoints needed to stay in line of sight. */
export function smoothPath(blocked: Uint8Array, w: number, h: number, cells: Int32Array, n: number, out: Int32Array): number {
  if (n <= 2) {
    for (let i = 0; i < n; i++) out[i] = cells[i]
    return n
  }
  let m = 0
  let anchor = 0
  out[m++] = cells[0]
  while (anchor < n - 1) {
    const ax = cells[anchor] % w, ay = (cells[anchor] / w) | 0
    let j = anchor + 1
    while (j + 1 < n && lineOfSight(blocked, w, h, ax, ay, cells[j + 1] % w, (cells[j + 1] / w) | 0)) j++
    out[m++] = cells[j]
    anchor = j
  }
  return m
}

/**
 * Nearest free cell to (ix, iy) within `maxR` cells (Euclidean), or -1. Near-ties
 * (within one cell) go to the cell closest to the optional reference (refX, refY), so a
 * goal in the middle of a round obstacle snaps to the side facing the robot instead of
 * an arbitrary, flickering side.
 */
export function nearestFree(blocked: Uint8Array, w: number, h: number, ix: number, iy: number, maxR: number, refX = ix, refY = iy): number {
  let bestD = Infinity
  for (let r = 0; r <= maxR; r++) {
    if (r * r > bestD) break
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const x = ix + dx, y = iy + dy
        if (x < 0 || y < 0 || x >= w || y >= h || blocked[y * w + x]) continue
        bestD = Math.min(bestD, dx * dx + dy * dy)
      }
    }
  }
  if (bestD === Infinity) return -1
  const lim = Math.sqrt(bestD) + 1
  const reach = Math.ceil(lim)
  let best = -1
  let bestRef = Infinity
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const x = ix + dx, y = iy + dy
      if (x < 0 || y < 0 || x >= w || y >= h || blocked[y * w + x] || dx * dx + dy * dy > lim * lim) continue
      const ref = (x - refX) ** 2 + (y - refY) ** 2
      if (ref < bestRef) { bestRef = ref; best = y * w + x }
    }
  }
  return best
}
