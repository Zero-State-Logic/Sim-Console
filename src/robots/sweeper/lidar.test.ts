import { describe, expect, it } from 'vitest'
import { FOOT_HX, FOOT_HY, LIDAR_MAX_RANGE, LIDAR_OFFSET_X } from './constants'
import { Ld06 } from './lidar'
import { RayScene } from './raycast'
import { Rng } from './rng'
import { applySafety, clearanceToward, exitDistance, FOOTPRINT_EXIT, minClearance, safetyScale } from './safety'

function emptyRoom(half = 3): RayScene {
  const s = new RayScene()
  s.set(half, [])
  return s
}

describe('LD06 model', () => {
  it('casts 450 samples per 0.1 s revolution', () => {
    const l = new Ld06()
    const rng = new Rng(1)
    expect(l.step(0.05, 0, 0, 0, emptyRoom(), rng, null)).toBe(225)
    expect(l.step(0.05, 0, 0, 0, emptyRoom(), rng, null)).toBe(225)
    expect(l.cursor).toBe(450)
  })

  it('measures exact wall distances without noise, in the body frame', () => {
    // Arrange
    const l = new Ld06()
    l.noise = 0
    // Act: robot at the center facing +y (90 deg)
    l.step(0.1, 0, 0, Math.PI / 2, emptyRoom(3), new Rng(1), null)
    // Assert: body 0 deg looks along +y, body 90 deg along -x
    expect(l.ranges[0]).toBeCloseTo(3 - LIDAR_OFFSET_X, 5)
    // bin 90 holds the sample at 90.4 deg, which is 3 / cos(0.4 deg) long
    expect(l.bins[90]).toBeCloseTo(3, 3)
    expect(l.bins[180]).toBeCloseTo(3 + LIDAR_OFFSET_X, 3)
    expect(l.minRange()).toBeCloseTo(3 - LIDAR_OFFSET_X, 3)
  })

  it('advances progressively with the rotation angle', () => {
    const l = new Ld06()
    l.step(0.025, 0, 0, 0, emptyRoom(), new Rng(1), null)
    expect(l.cursor).toBe(112)
    expect(l.headAngle).toBeCloseTo(Math.PI / 2, 1)
    expect(l.ranges[100]).toBeGreaterThan(0)
    expect(l.ranges[200]).toBe(0)
  })

  it('adds zero-mean Gaussian noise with sigma = max(10 mm, 1 % of range)', () => {
    // Arrange: a 9 m room, so every ray is 4.5-6.4 m long and sigma is range-relative
    const l = new Ld06()
    const room = emptyRoom(4.5)
    // Act
    l.step(0.1, 0, 0, 0, room, new Rng(42), null)
    // Assert: normalized errors are ~N(0, 1)
    const z: number[] = []
    for (let i = 0; i < 450; i++) {
      const a = (i / 450) * 2 * Math.PI
      const truth = room.cast(LIDAR_OFFSET_X, 0, Math.cos(a), Math.sin(a))
      z.push((l.ranges[i] - truth) / Math.max(0.01, 0.01 * truth))
    }
    const mean = z.reduce((acc, v) => acc + v, 0) / z.length
    const sd = Math.sqrt(z.reduce((acc, v) => acc + (v - mean) ** 2, 0) / z.length)
    expect(Math.abs(mean)).toBeLessThan(0.15)
    expect(sd).toBeGreaterThan(0.85)
    expect(sd).toBeLessThan(1.15)
  })

  it('reports no return beyond 12 m', () => {
    const l = new Ld06()
    l.noise = 0
    l.step(0.1, 0, 0, 0, emptyRoom(20), new Rng(1), null)
    expect(l.ranges[0]).toBe(0)
    expect(l.minRange()).toBe(LIDAR_MAX_RANGE)
  })

  it('feeds every returned sample to the map sink', () => {
    const l = new Ld06()
    let hits = 0
    l.step(0.1, 0, 0, 0, emptyRoom(), new Rng(1), () => hits++)
    expect(hits).toBe(450)
  })

  it('ingests a real scan into its angle bins and rejects junk ranges', () => {
    // Arrange
    const l = new Ld06()
    let fed = 0
    // Act
    const used = l.ingest({ a0: 0, da: 90, r: [1, 2, 99, Number.NaN] }, 0, 0, 0, () => fed++)
    // Assert
    expect(used).toBe(3)
    expect(fed).toBe(2)
    expect(l.bins[0]).toBe(1)
    expect(l.bins[90]).toBe(2)
    expect(l.bins[180]).toBe(0)
    expect(l.rangeAround(0, 3)).toBe(1)
  })
})

describe('LD06 real scans (HARDWARE)', () => {
  it('fills every degree bin from the firmware scan of 90 bins x 4 deg', () => {
    // Arrange: the generated firmware sends a0 = 2, da = 4 (bin centers)
    const l = new Ld06()
    const r = Array.from({ length: 90 }, (_, j) => 1 + j / 100)
    let rays = 0
    // Act
    const used = l.ingest({ a0: 2, da: 4, r }, 0, 0, 0, () => rays++)
    // Assert: degree b holds the firmware bin [4j, 4j + 4) it falls in, one map ray per bin
    expect(used).toBe(90)
    expect(rays).toBe(90)
    for (let b = 0; b < 360; b++) expect(l.bins[b]).toBeCloseTo(r[Math.floor(b / 4)], 6)
    for (let i = 0; i < l.samples; i++) expect(l.ranges[i]).toBeGreaterThan(0)
  })

  it('draws a real bin as an arc at its range around the sensor', () => {
    const l = new Ld06()
    l.ingest({ a0: 2, da: 4, r: Array.from({ length: 90 }, () => 2) }, 1, 0, Math.PI / 2, null)
    for (const i of [0, 3, 200, 449]) {
      expect(Math.hypot(l.ex[i] - l.ox[i], l.ey[i] - l.oy[i])).toBeCloseTo(2, 5)
    }
    expect(l.ox[0]).toBeCloseTo(1, 6)
    expect(l.oy[0]).toBeCloseTo(LIDAR_OFFSET_X, 6)
  })

  it('maps an analytic hit exactly at a rotated pose: circle ahead, rotated box, wall behind', () => {
    // Arrange: robot at the origin facing +y; sensor at (0, 0.02). Sample angles are
    // multiples of 0.8 deg, so 0, 180 and 288 deg (= -72) are exact samples.
    const scene = new RayScene()
    const dir = (90 - 72) * (Math.PI / 180)
    scene.set(2, [
      { kind: 'cyl', id: 1, x: 0, y: 1.02, r: 0.2, hgt: 0.5 },
      // a box whose near face is square to the -72 deg ray, 1.0 m from the sensor
      { kind: 'box', id: 2, x: 1.2 * Math.cos(dir), y: LIDAR_OFFSET_X + 1.2 * Math.sin(dir), w: 0.4, h: 0.3, a: dir, hgt: 0.5 },
    ])
    const l = new Ld06()
    l.noise = 0
    // Act
    l.step(0.1, 0, 0, Math.PI / 2, scene, new Rng(1), null)
    // Assert (the sample ring is float32, so about 7 significant digits)
    expect(l.ranges[0]).toBeCloseTo(0.8, 6)
    expect(l.ranges[225]).toBeCloseTo(2 + LIDAR_OFFSET_X, 6)
    expect(l.ranges[360]).toBeCloseTo(1.0, 6)
    expect(l.bins[288]).toBeCloseTo(1.0, 6)
  })
})

describe('reactive safety layer', () => {
  it('measures the footprint edge from the sensor in each direction', () => {
    expect(FOOTPRINT_EXIT[0]).toBeCloseTo(FOOT_HX - LIDAR_OFFSET_X, 6)
    expect(FOOTPRINT_EXIT[90]).toBeCloseTo(FOOT_HY, 6)
    expect(FOOTPRINT_EXIT[180]).toBeCloseTo(FOOT_HX + LIDAR_OFFSET_X, 6)
    expect(exitDistance(Math.PI / 4, -1, 1, -1, 1)).toBeCloseTo(Math.SQRT2, 9)
  })

  it('takes the worst clearance in the cone around the motion direction', () => {
    const bins = new Float32Array(360).fill(2)
    bins[20] = 0.5
    bins[100] = 0.2
    expect(clearanceToward(bins, 0)).toBeCloseTo(0.5 - FOOTPRINT_EXIT[20], 6)
    expect(minClearance(bins)).toBeCloseTo(0.2 - FOOTPRINT_EXIT[100], 6)
    expect(clearanceToward(new Float32Array(360), 0)).toBe(Infinity)
  })

  it('scales speed linearly between the stop and slow distances', () => {
    expect(safetyScale(1)).toBe(1)
    expect(safetyScale(0.0)).toBe(0)
    expect(safetyScale(0.18, 0.04, 0.32)).toBeCloseTo(0.5, 9)
  })

  it('slows translation toward an obstacle but leaves rotation alone', () => {
    // Arrange: wall 0.25 m ahead of the sensor, open behind
    const bins = new Float32Array(360).fill(3)
    for (let d = -40; d <= 40; d++) bins[(d + 360) % 360] = 0.25
    const fwd = { vx: 0.3, vy: 0, wz: 0.5 }
    const back = { vx: -0.3, vy: 0, wz: 0 }
    // Act
    const kf = applySafety(bins, fwd)
    const kb = applySafety(bins, back)
    // Assert
    expect(kf).toBeLessThan(0.5)
    expect(fwd.vx).toBeCloseTo(0.3 * kf, 9)
    expect(fwd.wz).toBe(0.5)
    expect(kb).toBe(1)
    expect(Math.abs(FOOTPRINT_EXIT[90] - FOOT_HY)).toBeLessThan(1e-6)
  })
})
