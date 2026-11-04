import { describe, expect, it } from 'vitest'
import { RayScene, rayCircle, rayObb, rayRoom } from './raycast'

const S2 = Math.SQRT1_2

describe('ray vs room walls', () => {
  it('hits the east wall at the half size from the center', () => {
    expect(rayRoom(0, 0, 1, 0, 3)).toBeCloseTo(3, 12)
  })

  it('hits the nearer wall first from an off-center origin', () => {
    expect(rayRoom(1, 2, 0, 1, 3)).toBeCloseTo(1, 12)
    expect(rayRoom(1, 2, -1, 0, 3)).toBeCloseTo(4, 12)
  })

  it('reaches the corner along the diagonal', () => {
    expect(rayRoom(0, 0, S2, S2, 2)).toBeCloseTo(2 * Math.SQRT2, 12)
  })
})

describe('ray vs oriented box', () => {
  it('hits the near face of an axis-aligned box', () => {
    expect(rayObb(0, 0, 1, 0, 3, 0, 0.5, 0.4, 1, 0)).toBeCloseTo(2.5, 12)
  })

  it('hits the vertex of a box rotated 45 degrees', () => {
    const a = Math.PI / 4
    expect(rayObb(0, 0, 1, 0, 2, 0, 0.5, 0.5, Math.cos(a), Math.sin(a))).toBeCloseTo(2 - 0.5 * Math.SQRT2, 10)
  })

  it('misses a box beside the ray and one behind the origin', () => {
    expect(rayObb(0, 0, 1, 0, 3, 1, 0.5, 0.4, 1, 0)).toBe(Infinity)
    expect(rayObb(0, 0, 1, 0, -3, 0, 0.5, 0.4, 1, 0)).toBe(Infinity)
  })

  it('returns 0 when the origin is inside the box', () => {
    expect(rayObb(0, 0, 0, 1, 0, 0, 1, 1, 1, 0)).toBe(0)
  })
})

describe('ray vs circle', () => {
  it('hits the near side of a circle', () => {
    expect(rayCircle(0, 0, 1, 0, 3, 0, 1)).toBeCloseTo(2, 12)
  })

  it('hits a circle at an oblique angle', () => {
    // circle at (2, 2) r = 1 along the diagonal: distance to center 2*sqrt2, minus r
    expect(rayCircle(0, 0, S2, S2, 2, 2, 1)).toBeCloseTo(2 * Math.SQRT2 - 1, 10)
  })

  it('misses circles off the ray or behind it, and is 0 inside', () => {
    expect(rayCircle(0, 0, 1, 0, 3, 1.5, 1)).toBe(Infinity)
    expect(rayCircle(0, 0, 1, 0, -3, 0, 1)).toBe(Infinity)
    expect(rayCircle(0, 0, 1, 0, 0.2, 0, 1)).toBe(0)
  })
})

describe('RayScene', () => {
  it('returns the nearest of walls, boxes and circles', () => {
    // Arrange
    const scene = new RayScene()
    scene.set(3, [
      { kind: 'box', id: 1, x: 2, y: 0, w: 0.4, h: 1, a: 0, hgt: 0.5 },
      { kind: 'cyl', id: 2, x: 0, y: 1.5, r: 0.5, hgt: 0.5 },
    ])
    // Act / Assert
    expect(scene.cast(0, 0, 1, 0)).toBeCloseTo(1.8, 12)
    expect(scene.cast(0, 0, 0, 1)).toBeCloseTo(1, 12)
    expect(scene.cast(0, 0, -1, 0)).toBeCloseTo(3, 12)
  })

  it('grows its packed buffer for many obstacles', () => {
    const scene = new RayScene()
    const many = Array.from({ length: 100 }, (_, i) => ({ kind: 'cyl' as const, id: i, x: 2.5, y: -2.4 + i * 0.05, r: 0.01, hgt: 0.3 }))
    scene.set(3, many)
    expect(scene.count).toBe(100)
    expect(scene.cast(0, 0, 1, 0)).toBeCloseTo(2.49, 10)
  })
})

describe('LD06 scan plane', () => {
  it('looks over obstacles lower than the scan height and sees taller ones', () => {
    // Arrange: a 10 cm box (under the 14.2 cm plane) in front of a tall cylinder
    const scene = new RayScene()
    scene.set(3, [
      { kind: 'box', id: 1, x: 1, y: 0, w: 0.2, h: 0.6, a: 0, hgt: 0.1 },
      { kind: 'cyl', id: 2, x: 2, y: 0, r: 0.2, hgt: 0.8 },
    ], 0.142)
    // Act / Assert
    expect(scene.hidden).toBe(1)
    expect(scene.count).toBe(1)
    expect(scene.cast(0, 0, 1, 0)).toBeCloseTo(1.8, 12)
  })
})
