import { describe, expect, it } from 'vitest'
import { CoverageMap, laneRows, laneSpacing, nextLane, planLanes, type Lane } from './coverage'
import { makeGridGeom, type GridGeom } from './occupancy'

/** Blocked mask of an empty room: cells whose center is within `r` of a wall. */
function roomMask(geom: GridGeom, half: number, r: number): Uint8Array {
  const m = new Uint8Array(geom.w * geom.h)
  for (let iy = 0; iy < geom.h; iy++) {
    for (let ix = 0; ix < geom.w; ix++) {
      const x = geom.x0 + (ix + 0.5) * geom.cell, y = geom.y0 + (iy + 0.5) * geom.cell
      if (half - Math.abs(x) <= r || half - Math.abs(y) <= r) m[iy * geom.w + ix] = 1
    }
  }
  return m
}

/** Drive the brush along a lane in 1 cm steps. */
function sweep(cov: CoverageMap, l: Lane, width: number): void {
  const len = Math.abs(l.xe - l.xs)
  const dir = l.xe >= l.xs ? 0 : Math.PI
  for (let s = 0; s <= len; s += 0.01) cov.paint(l.xs + Math.cos(dir) * s, l.y, dir, width, 0.08)
}

describe('coverage map', () => {
  it('counts the free floor cells of an empty room', () => {
    const geom = makeGridGeom(2, 0.05, 0.1)
    const cov = new CoverageMap(geom)
    cov.rebuildFree(1, [])
    expect(cov.freeCount).toBe(40 * 40)
  })

  it('excludes obstacle cells and keeps covered cells that stay free', () => {
    // Arrange
    const geom = makeGridGeom(2, 0.05, 0.1)
    const cov = new CoverageMap(geom)
    cov.rebuildFree(1, [])
    cov.paint(-0.5, -0.5, 0, 0.2, 0.2)
    const covered = cov.coveredCount
    // Act
    cov.rebuildFree(1, [{ kind: 'box', id: 1, x: 0.5, y: 0.5, w: 0.5, h: 0.5, a: 0, hgt: 0.3 }])
    // Assert
    expect(cov.freeCount).toBe(1600 - 100)
    expect(cov.coveredCount).toBe(covered)
  })

  it('paints exactly the cells under an oriented brush rectangle once', () => {
    const geom = makeGridGeom(2, 0.05, 0.1)
    const cov = new CoverageMap(geom)
    cov.rebuildFree(1, [])
    expect(cov.paint(0, 0, 0, 0.2, 0.1)).toBe(4 * 2)
    expect(cov.paint(0, 0, 0, 0.2, 0.1)).toBe(0)
    expect(cov.paint(0.5, 0.5, Math.PI / 2, 0.3, 0.1)).toBe(6 * 2)
    expect(cov.percent()).toBeCloseTo((20 / 1600) * 100, 9)
    cov.clear()
    expect(cov.percent()).toBe(0)
  })
})

describe('boustrophedon lanes', () => {
  it('overlaps lanes slightly so the spacing stays under the brush width', () => {
    expect(laneSpacing(0.26)).toBeCloseTo(0.26 * 0.92, 12)
    expect(laneSpacing(0.01)).toBe(0.05)
  })

  it('spaces rows evenly between the inflated walls', () => {
    const rows = laneRows(3, 0.3, 0.25, 0.05)
    expect(rows[0]).toBeCloseTo(-2.625, 9)
    for (let i = 1; i < rows.length - 1; i++) expect(rows[i] - rows[i - 1]).toBeCloseTo(0.25, 9)
    expect(rows[rows.length - 1]).toBeLessThanOrEqual(2.625 + 1e-9)
  })

  it('alternates sweep direction row by row', () => {
    const geom = makeGridGeom(4, 0.05, 0.1)
    const lanes = planLanes(roomMask(geom, 2, 0.3), geom, 2, laneRows(2, 0.3, 0.25, 0.05))
    expect(lanes.length).toBeGreaterThan(5)
    lanes.forEach((l) => expect(l.xe > l.xs).toBe(l.row % 2 === 0))
  })

  it('covers a simple room when the brush follows every lane', () => {
    // Arrange
    const size = 3, half = 1.5, r = 0.3, brush = 0.26
    const geom = makeGridGeom(size, 0.05, 0.1)
    const lanes = planLanes(roomMask(geom, half, r), geom, half, laneRows(half, r, laneSpacing(brush), 0.05))
    const cov = new CoverageMap(geom)
    cov.rebuildFree(half, [])
    // Act
    lanes.forEach((l) => sweep(cov, l, brush))
    // Assert: every cell of the band the lanes can reach is cleaned
    const reach = half - r - 0.03
    let missed = 0
    for (let iy = 0; iy < geom.h; iy++) {
      for (let ix = 0; ix < geom.w; ix++) {
        const x = geom.x0 + (ix + 0.5) * geom.cell, y = geom.y0 + (iy + 0.5) * geom.cell
        if (Math.abs(x) < reach && Math.abs(y) < reach && !cov.covered[iy * geom.w + ix]) missed++
      }
    }
    expect(missed).toBe(0)
    expect(cov.percent()).toBeGreaterThan(60)
  })

  it('splits a row around a blocked block and orders the parts in sweep direction', () => {
    const geom = makeGridGeom(4, 0.05, 0.1)
    const mask = roomMask(geom, 2, 0.3)
    for (let iy = 0; iy < geom.h; iy++) for (let ix = 38; ix < 46; ix++) mask[iy * geom.w + ix] = 1
    const lanes = planLanes(mask, geom, 2, [-1, -0.75])
    expect(lanes.length).toBe(4)
    expect(lanes[0].xs).toBeLessThan(lanes[1].xs)
    expect(lanes[2].xs).toBeGreaterThan(lanes[3].xs)
    expect(lanes[0].xe).toBeLessThan(0)
  })

  it('picks the next lane after a progress cursor', () => {
    const lanes: Lane[] = [
      { row: 0, y: 0, xs: -1, xe: -0.2 },
      { row: 0, y: 0, xs: 0.3, xe: 1 },
      { row: 1, y: 0.25, xs: 1, xe: -1 },
    ]
    expect(nextLane(lanes, -1, -Infinity)).toBe(0)
    expect(nextLane(lanes, 0, -0.2)).toBe(1)
    expect(nextLane(lanes, 0, 1)).toBe(2)
    expect(nextLane(lanes, 1, -1)).toBe(-1)
  })
})
