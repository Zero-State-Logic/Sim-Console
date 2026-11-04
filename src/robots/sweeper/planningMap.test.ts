import { describe, expect, it } from 'vitest'
import { L_HIT, L_MISS, OccupancyGrid, makeGridGeom } from './occupancy'
import { POCKET_LIMIT, PlanningMap } from './planningMap'
import { Rng } from './rng'

/** Brute force: blocked iff an occupied cell lies within r cells (Euclidean), or on the border. */
function bruteBlocked(grid: OccupancyGrid, r: number): Uint8Array {
  const { w, h } = grid.geom
  const out = new Uint8Array(w * h)
  const occ: number[] = []
  for (let i = 0; i < w * h; i++) if (grid.isOccupied(i)) occ.push(i)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const border = x === 0 || y === 0 || x === w - 1 || y === h - 1
      const near = occ.some((j) => ((j % w) - x) ** 2 + (Math.floor(j / w) - y) ** 2 <= r * r)
      out[y * w + x] = border || near ? 1 : 0
    }
  }
  return out
}

function scatter(grid: OccupancyGrid, rng: Rng, n: number, delta: number): void {
  for (let k = 0; k < n; k++) {
    const x = Math.floor(rng.range(0, grid.geom.w)), y = Math.floor(rng.range(0, grid.geom.h))
    for (let j = 0; j < 4; j++) grid.addLogOdds(x, y, delta)
  }
}

describe('incremental inflation', () => {
  it('matches brute-force Euclidean inflation after a full build', () => {
    const grid = new OccupancyGrid(makeGridGeom(2))
    scatter(grid, new Rng(5), 25, L_HIT)
    const map = new PlanningMap(grid)
    map.radius = 0.17
    map.refresh()
    expect(Array.from(map.blocked)).toEqual(Array.from(bruteBlocked(grid, 0.17 / 0.05)))
  })

  it('stays exact as cells turn occupied and free again between refreshes', () => {
    // Arrange
    const grid = new OccupancyGrid(makeGridGeom(2))
    const rng = new Rng(9)
    const map = new PlanningMap(grid)
    map.radius = 0.12
    map.refresh()
    // Act / Assert over several rounds of map edits
    for (let round = 0; round < 6; round++) {
      scatter(grid, rng, 12, L_HIT)
      scatter(grid, rng, 30, L_MISS * 3)
      grid.markContact(rng.range(-0.8, 0.8), rng.range(-0.8, 0.8))
      const before = map.version
      map.refresh()
      expect(map.version).toBeGreaterThan(before)
      expect(Array.from(map.blocked)).toEqual(Array.from(bruteBlocked(grid, 0.12 / 0.05)))
    }
  })

  it('rebuilds when the radius changes or the map is cleared', () => {
    const grid = new OccupancyGrid(makeGridGeom(2))
    scatter(grid, new Rng(3), 10, L_HIT)
    const map = new PlanningMap(grid)
    map.radius = 0.1
    map.refresh()
    map.radius = 0.25
    map.refresh()
    expect(Array.from(map.blocked)).toEqual(Array.from(bruteBlocked(grid, 0.25 / 0.05)))
    grid.clear()
    map.refresh()
    expect(Array.from(map.blocked)).toEqual(Array.from(bruteBlocked(grid, 0.25 / 0.05)))
  })
})

describe('reachability guard', () => {
  /** A closed ring of occupied cells around (0.6, 0.6) in a 2 m room. */
  function walledPocket(): { grid: OccupancyGrid; map: PlanningMap } {
    const grid = new OccupancyGrid(makeGridGeom(2))
    const c = grid.cellX(0.6), r = 5
    for (let a = 0; a < 360; a += 2) {
      const x = Math.round(c + r * Math.cos((a * Math.PI) / 180))
      const y = Math.round(c + r * Math.sin((a * Math.PI) / 180))
      for (let j = 0; j < 3; j++) grid.addLogOdds(x, y, L_HIT)
    }
    const map = new PlanningMap(grid)
    map.radius = 0.03
    map.refresh()
    return { grid, map }
  }

  it('detects a goal in a walled-in pocket, but not one in the open or with the robot inside', () => {
    const { map } = walledPocket()
    expect(map.goalEnclosed(-0.6, -0.6, 0.6, 0.6)).toBe(true)
    expect(map.goalEnclosed(-0.6, -0.6, 0.6, -0.6)).toBe(false)
    expect(map.goalEnclosed(0.55, 0.6, 0.65, 0.6)).toBe(false)
  })

  it('leaves large regions to A* instead of flooding them', () => {
    const grid = new OccupancyGrid(makeGridGeom(10))
    const map = new PlanningMap(grid)
    map.refresh()
    // start and goal in one huge open room: the bounded fill gives up, it does not prove anything
    expect(map.goalEnclosed(-4, -4, 4, 4)).toBe(false)
    expect(POCKET_LIMIT).toBeLessThan(grid.geom.w * grid.geom.h / 4)
  })

  it('snaps a goal in an unreachable pocket to the nearest reachable cell outside it', () => {
    const { map } = walledPocket()
    const out = new Float64Array(1024)
    const n = map.plan(-0.6, -0.6, 0.6, 0.6, out)
    expect(n).toBeGreaterThan(1)
    const ex = out[2 * n - 2], ey = out[2 * n - 1]
    expect(map.goalEnclosed(-0.6, -0.6, ex, ey)).toBe(false)
    expect(Math.hypot(ex - 0.6, ey - 0.6)).toBeGreaterThan(0.25)
    expect(Math.hypot(ex - 0.6, ey - 0.6)).toBeLessThan(0.5)
  })
})
