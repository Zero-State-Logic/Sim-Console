import { describe, expect, it } from 'vitest'
import { GridAStar, lineOfSight, nearestFree, octile, smoothPath } from './astar'

/** Parse an ASCII grid: '#' blocked, 'S' start, 'G' goal (row 0 = top line = highest y). */
function parse(rows: string[]) {
  const h = rows.length, w = rows[0].length
  const blocked = new Uint8Array(w * h)
  let start = -1, goal = -1
  rows.forEach((row, r) => {
    const y = h - 1 - r
    for (let x = 0; x < w; x++) {
      const ch = row[x]
      if (ch === '#') blocked[y * w + x] = 1
      if (ch === 'S') start = y * w + x
      if (ch === 'G') goal = y * w + x
    }
  })
  return { w, h, blocked, start, goal }
}

/** Reference Dijkstra with the same move rules (8-connected, no corner cutting). */
function dijkstra(blocked: Uint8Array, w: number, h: number, s: number, g: number): number {
  const dist = new Float64Array(w * h).fill(Infinity)
  const done = new Uint8Array(w * h)
  dist[s] = 0
  for (;;) {
    let u = -1
    for (let i = 0; i < w * h; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i
    if (u < 0) return Infinity
    if (u === g) return dist[u]
    done[u] = 1
    const ux = u % w, uy = Math.floor(u / w)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const x = ux + dx, y = uy + dy
        if (x < 0 || y < 0 || x >= w || y >= h || blocked[y * w + x]) continue
        if (dx && dy && (blocked[uy * w + x] || blocked[y * w + ux])) continue
        dist[y * w + x] = Math.min(dist[y * w + x], dist[u] + (dx && dy ? Math.SQRT2 : 1))
      }
    }
  }
}

function pathCost(cells: Int32Array, n: number, w: number): number {
  let c = 0
  for (let i = 1; i < n; i++) {
    const dx = Math.abs((cells[i] % w) - (cells[i - 1] % w))
    const dy = Math.abs(Math.floor(cells[i] / w) - Math.floor(cells[i - 1] / w))
    c += dx && dy ? Math.SQRT2 : 1
  }
  return c
}

const ROOM = [
  '............',
  '.S...#......',
  '.....#..##..',
  '.....#...#..',
  '..####...#..',
  '.........#G.',
  '............',
]

describe('grid A*', () => {
  it('finds the octile-optimal path on an open grid', () => {
    const w = 15, h = 9
    const blocked = new Uint8Array(w * h)
    const out = new Int32Array(w * h)
    const astar = new GridAStar(w, h)
    const n = astar.search(blocked, 0, 8 * w + 14, out)
    expect(pathCost(out, n, w)).toBeCloseTo(octile(14, 8), 5)
  })

  it('finds an optimal path around walls on a small known grid', () => {
    // Arrange
    const g = parse(ROOM)
    const out = new Int32Array(g.w * g.h)
    // Act
    const n = new GridAStar(g.w, g.h).search(g.blocked, g.start, g.goal, out)
    // Assert
    expect(n).toBeGreaterThan(0)
    expect(out[0]).toBe(g.start)
    expect(out[n - 1]).toBe(g.goal)
    expect(pathCost(out, n, g.w)).toBeCloseTo(dijkstra(g.blocked, g.w, g.h, g.start, g.goal), 5)
    for (let i = 0; i < n; i++) expect(g.blocked[out[i]]).toBe(0)
  })

  it('never cuts a blocked corner on a diagonal step', () => {
    const g = parse(['.G', '#.', 'S.'])
    const out = new Int32Array(g.w * g.h)
    const n = new GridAStar(g.w, g.h).search(g.blocked, g.start, g.goal, out)
    for (let i = 1; i < n; i++) {
      const ax = out[i - 1] % g.w, ay = Math.floor(out[i - 1] / g.w)
      const bx = out[i] % g.w, by = Math.floor(out[i] / g.w)
      if (ax !== bx && ay !== by) {
        expect(g.blocked[ay * g.w + bx]).toBe(0)
        expect(g.blocked[by * g.w + ax]).toBe(0)
      }
    }
  })

  it('returns 0 when the goal is walled off', () => {
    const g = parse(['S..#...', '...#.G.', '...#...'])
    const out = new Int32Array(g.w * g.h)
    expect(new GridAStar(g.w, g.h).search(g.blocked, g.start, g.goal, out)).toBe(0)
  })

  it('returns 0 for a blocked start or goal and reuses its buffers across searches', () => {
    const g = parse(ROOM)
    const astar = new GridAStar(g.w, g.h)
    const out = new Int32Array(g.w * g.h)
    expect(astar.search(g.blocked, 5 + 5 * g.w, g.goal, out)).toBe(0)
    const a = astar.search(g.blocked, g.start, g.goal, out)
    const b = astar.search(g.blocked, g.start, g.goal, out)
    expect(a).toBe(b)
    expect(astar.costTo(g.goal)).toBeCloseTo(pathCost(out, b, g.w), 5)
  })
})

describe('line of sight and smoothing', () => {
  it('sees along a free row and is blocked by a wall cell', () => {
    const g = parse(ROOM)
    expect(lineOfSight(g.blocked, g.w, g.h, 0, 0, 11, 0)).toBe(true)
    expect(lineOfSight(g.blocked, g.w, g.h, 1, 5, 8, 5)).toBe(false)
  })

  it('treats a diagonal through a blocked corner as blocked', () => {
    // free (0,0) and (1,1) touch only at a corner shared with blocked (1,0)
    const blocked = new Uint8Array([0, 1, 0, 0])
    expect(lineOfSight(blocked, 2, 2, 0, 0, 1, 1)).toBe(false)
  })

  it('keeps the endpoints, removes waypoints and never crosses an obstacle', () => {
    // Arrange
    const g = parse(ROOM)
    const cells = new Int32Array(g.w * g.h)
    const n = new GridAStar(g.w, g.h).search(g.blocked, g.start, g.goal, cells)
    const out = new Int32Array(n)
    // Act
    const m = smoothPath(g.blocked, g.w, g.h, cells, n, out)
    // Assert
    expect(m).toBeLessThan(n)
    expect(out[0]).toBe(g.start)
    expect(out[m - 1]).toBe(g.goal)
    for (let i = 1; i < m; i++) {
      expect(lineOfSight(g.blocked, g.w, g.h, out[i - 1] % g.w, Math.floor(out[i - 1] / g.w), out[i] % g.w, Math.floor(out[i] / g.w))).toBe(true)
    }
  })

  it('never crosses obstacles on random cluttered grids', () => {
    let seed = 99
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const w = 40, h = 30
    const astar = new GridAStar(w, h)
    const cells = new Int32Array(w * h)
    const out = new Int32Array(w * h)
    for (let trial = 0; trial < 25; trial++) {
      const blocked = new Uint8Array(w * h)
      for (let i = 0; i < w * h; i++) blocked[i] = rand() < 0.22 ? 1 : 0
      blocked[0] = 0
      blocked[w * h - 1] = 0
      const n = astar.search(blocked, 0, w * h - 1, cells)
      if (!n) continue
      const m = smoothPath(blocked, w, h, cells, n, out)
      for (let i = 1; i < m; i++) {
        expect(lineOfSight(blocked, w, h, out[i - 1] % w, Math.floor(out[i - 1] / w), out[i] % w, Math.floor(out[i] / w))).toBe(true)
      }
    }
  })

  it('finds the nearest free cell around a blocked one', () => {
    const g = parse(ROOM)
    const i = nearestFree(g.blocked, g.w, g.h, 5, 5, 3)
    expect(g.blocked[i]).toBe(0)
    expect(Math.hypot((i % g.w) - 5, Math.floor(i / g.w) - 5)).toBe(1)
    expect(nearestFree(new Uint8Array(4).fill(1), 2, 2, 0, 0, 3)).toBe(-1)
  })
})
