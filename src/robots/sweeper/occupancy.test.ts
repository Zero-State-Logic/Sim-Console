import { describe, expect, it } from 'vitest'
import { bresenham, FLIP_CAPACITY, L_HIT, L_MAX, L_MIN, L_MISS, makeGridGeom, OccupancyGrid } from './occupancy'

function line(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = []
  bresenham(x0, y0, x1, y1, (x, y) => out.push([x, y]))
  return out
}

describe('bresenham', () => {
  it('visits every cell of a horizontal line including both ends', () => {
    expect(line(2, 3, 6, 3)).toEqual([[2, 3], [3, 3], [4, 3], [5, 3], [6, 3]])
  })

  it('walks a pure diagonal one cell per step', () => {
    expect(line(0, 0, 3, -3)).toEqual([[0, 0], [1, -1], [2, -2], [3, -3]])
  })

  it('produces an 8-connected line of max(|dx|,|dy|)+1 cells for a steep line', () => {
    // Arrange / Act
    const cells = line(1, 1, 4, 11)
    // Assert
    expect(cells.length).toBe(11)
    expect(cells[0]).toEqual([1, 1])
    expect(cells[cells.length - 1]).toEqual([4, 11])
    for (let i = 1; i < cells.length; i++) {
      expect(Math.max(Math.abs(cells[i][0] - cells[i - 1][0]), Math.abs(cells[i][1] - cells[i - 1][1]))).toBe(1)
    }
  })

  it('visits a single cell for a zero-length line', () => {
    expect(line(5, 5, 5, 5)).toEqual([[5, 5]])
  })
})

describe('log-odds occupancy grid', () => {
  const geom = { w: 20, h: 20, cell: 0.1, x0: 0, y0: 0 }

  it('carves free cells along a ray and marks the end cell occupied', () => {
    // Arrange
    const g = new OccupancyGrid(geom)
    // Act
    g.integrateRay(0.05, 0.05, 0.95, 0.05, true)
    // Assert
    for (let ix = 0; ix < 9; ix++) expect(g.lo[ix]).toBeCloseTo(L_MISS, 6)
    expect(g.lo[9]).toBeCloseTo(L_HIT, 6)
    expect(g.lo[10]).toBe(0)
  })

  it('marks the end cell free when the ray did not return', () => {
    const g = new OccupancyGrid(geom)
    g.integrateRay(0.05, 0.05, 0.55, 0.05, false)
    expect(g.lo[5]).toBeCloseTo(L_MISS, 6)
  })

  it('clamps log-odds at both bounds after many updates', () => {
    const g = new OccupancyGrid(geom)
    for (let i = 0; i < 50; i++) g.integrateRay(0.05, 0.05, 0.35, 0.05, true)
    expect(g.lo[3]).toBe(L_MAX)
    expect(g.lo[1]).toBe(L_MIN)
  })

  it('needs repeated evidence before calling a cell free, one hit to call it occupied', () => {
    // Arrange
    const g = new OccupancyGrid(geom)
    // Act
    g.integrateRay(0.05, 0.05, 0.35, 0.05, true)
    // Assert: one miss (p = 0.4) is still unknown, one hit (p = 0.7) is occupied
    expect(g.isFree(1)).toBe(false)
    expect(g.isOccupied(3)).toBe(true)
    g.integrateRay(0.05, 0.05, 0.35, 0.05, true)
    expect(g.isFree(1)).toBe(true)
  })

  it('ignores ray cells that fall outside the grid', () => {
    const g = new OccupancyGrid(geom)
    g.integrateRay(1.85, 0.05, 3.5, 0.05, true)
    expect(g.lo[19]).toBeCloseTo(L_MISS, 6)
  })

  it('reports the known fraction of the room interior and resets with clear()', () => {
    const g = new OccupancyGrid({ w: 10, h: 10, cell: 0.1, x0: -0.5, y0: -0.5 })
    for (let i = 0; i < 10; i++) g.lo[i] = 2
    expect(g.knownFraction(0.5)).toBeCloseTo(0.1, 9)
    g.clear()
    expect(g.knownFraction(0.5)).toBe(0)
  })

  it('sizes a centered grid to the room plus margin', () => {
    const geom6 = makeGridGeom(6, 0.05, 0.15)
    expect(geom6.w).toBe(126)
    expect(geom6.x0).toBeCloseTo(-3.15, 9)
    expect(new OccupancyGrid(geom6).cellX(0.01)).toBe(63)
    expect(new OccupancyGrid(geom6).cellX(-0.01)).toBe(62)
  })
})

describe('flip journal', () => {
  it('records a cell once when it turns occupied and again when it turns free', () => {
    const grid = new OccupancyGrid(makeGridGeom(2))
    grid.addLogOdds(3, 3, L_HIT)
    grid.addLogOdds(3, 3, L_HIT)
    expect(grid.flipCount).toBe(1)
    for (let k = 0; k < 6; k++) grid.addLogOdds(3, 3, L_MISS)
    expect(grid.flipCount).toBe(2)
    expect(grid.flips[1]).toBe(3 * grid.geom.w + 3)
    grid.drainFlips()
    expect(grid.flipCount).toBe(0)
  })

  it('flags an overflow instead of losing flips silently, and clear() starts a new epoch', () => {
    const grid = new OccupancyGrid(makeGridGeom(10))
    for (let i = 0; i <= FLIP_CAPACITY; i++) grid.addLogOdds(i % grid.geom.w, Math.floor(i / grid.geom.w), L_HIT)
    expect(grid.flipOverflow).toBe(true)
    const e = grid.epoch
    grid.clear()
    expect(grid.epoch).toBe(e + 1)
    expect(grid.flipOverflow).toBe(false)
  })
})
