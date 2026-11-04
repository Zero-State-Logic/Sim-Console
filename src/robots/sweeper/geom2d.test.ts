import { describe, expect, it } from 'vitest'
import {
  clampObstacleToRoom,
  footprintCollides,
  footprintPush,
  obbInsideRoom,
  obbOverlapsCircle,
  obbOverlapsObb,
  obstacleInsideRoom,
  obstaclesOverlap,
  pointInObstacle,
  type Obstacle,
  type Vec2,
} from './geom2d'

const box = (x: number, y: number, w: number, h: number, a = 0): Obstacle => ({ kind: 'box', id: 1, x, y, w, h, a, hgt: 0.4 })
const cyl = (x: number, y: number, r: number): Obstacle => ({ kind: 'cyl', id: 2, x, y, r, hgt: 0.4 })

describe('oriented box overlap (SAT)', () => {
  it('detects overlapping and separated axis-aligned boxes', () => {
    expect(obbOverlapsObb(0, 0, 1, 1, 0, 1.9, 0, 1, 1, 0)).toBe(true)
    expect(obbOverlapsObb(0, 0, 1, 1, 0, 2.1, 0, 1, 1, 0)).toBe(false)
  })

  it('separates rotated boxes whose bounding boxes overlap', () => {
    // a diamond (45 deg) next to a square corner: AABBs overlap, shapes do not
    const a = Math.PI / 4
    expect(obbOverlapsObb(0, 0, 0.5, 0.5, 0, 1.15, 1.15, 0.5, 0.5, a)).toBe(false)
    expect(obbOverlapsObb(0, 0, 0.5, 0.5, 0, 0.8, 0.8, 0.5, 0.5, a)).toBe(true)
  })

  it('tests a rotated box against a circle by its closest point', () => {
    expect(obbOverlapsCircle(0, 0, 1, 0.2, 0, 0, 0.5, 0.31)).toBe(true)
    expect(obbOverlapsCircle(0, 0, 1, 0.2, 0, 0, 0.5, 0.29)).toBe(false)
    expect(obbOverlapsCircle(0, 0, 1, 0.2, Math.PI / 2, 0, 0.9, 0.05)).toBe(true)
  })
})

describe('room containment and footprint', () => {
  it('keeps an oriented box inside the room only when all corners are inside', () => {
    expect(obbInsideRoom(2.84, 0, 0.15, 0.125, 0, 3)).toBe(true)
    expect(obbInsideRoom(2.9, 0, 0.15, 0.125, 0, 3)).toBe(false)
    expect(obbInsideRoom(2.84, 0, 0.15, 0.125, Math.PI / 4, 3)).toBe(false)
  })

  it('collides with walls and obstacles but not in free space', () => {
    const obs = [box(1, 0, 0.4, 0.4), cyl(-1, 0, 0.2)]
    expect(footprintCollides(0, 0, 0, 0.15, 0.125, obs, 3)).toBe(false)
    expect(footprintCollides(0.7, 0, 0, 0.15, 0.125, obs, 3)).toBe(true)
    expect(footprintCollides(-0.7, 0, 0, 0.15, 0.125, obs, 3)).toBe(true)
    expect(footprintCollides(2.9, 0, 0, 0.15, 0.125, obs, 3)).toBe(true)
  })
})

describe('obstacle helpers', () => {
  it('tests points inside rotated boxes and circles', () => {
    expect(pointInObstacle(0.45, 0, box(0, 0, 1, 0.2))).toBe(true)
    expect(pointInObstacle(0, 0.45, box(0, 0, 1, 0.2))).toBe(false)
    expect(pointInObstacle(0, 0.45, box(0, 0, 1, 0.2, Math.PI / 2))).toBe(true)
    expect(pointInObstacle(0.25, 0, cyl(0, 0, 0.2), 0.06)).toBe(true)
  })

  it('reports overlaps between every obstacle kind pair with a gap', () => {
    expect(obstaclesOverlap(cyl(0, 0, 0.2), cyl(0.5, 0, 0.2))).toBe(false)
    expect(obstaclesOverlap(cyl(0, 0, 0.2), cyl(0.5, 0, 0.2), 0.2)).toBe(true)
    expect(obstaclesOverlap(box(0, 0, 0.4, 0.4), cyl(0.35, 0, 0.2))).toBe(true)
    expect(obstaclesOverlap(box(0, 0, 0.4, 0.4), box(0.5, 0, 0.4, 0.4))).toBe(false)
  })

  it('clamps an obstacle into the room without mutating it', () => {
    const o = box(5, -5, 1, 0.5)
    const c = clampObstacleToRoom(o, 3)
    expect(o.x).toBe(5)
    expect(obstacleInsideRoom(c, 3)).toBe(true)
    expect(c.x).toBeCloseTo(2.5, 12)
    expect(c.y).toBeCloseTo(-2.75, 12)
  })
})

describe('footprint push-out (minimum translation)', () => {
  const HX = 0.15, HY = 0.125
  const n: Vec2 = { x: 0, y: 0 }

  it('pushes the footprint off a box face by the SAT overlap', () => {
    // Arrange: box spans x 0.1..0.5, the footprint reaches x = 0.15
    const box: Obstacle = { kind: 'box', id: 1, x: 0.3, y: 0, w: 0.4, h: 0.4, a: 0, hgt: 0.5 }
    // Act
    const depth = footprintPush(0, 0, 0, HX, HY, box, n)
    // Assert
    expect(depth).toBeCloseTo(0.05, 12)
    expect(n.x).toBeCloseTo(-1, 12)
    expect(n.y).toBeCloseTo(0, 12)
    expect(footprintCollides(n.x * (depth + 1e-6), 0, 0, HX, HY, [box], 3)).toBe(false)
  })

  it('pushes away from a circle along the closest-point normal', () => {
    // Arrange: circle edge 5 cm inside the front face, and one past a corner
    const front: Obstacle = { kind: 'cyl', id: 1, x: 0.2, y: 0, r: 0.1, hgt: 0.5 }
    const corner: Obstacle = { kind: 'cyl', id: 2, x: 0.15 + 0.06, y: 0.125 + 0.08, r: 0.15, hgt: 0.5 }
    // Act / Assert
    expect(footprintPush(0, 0, 0, HX, HY, front, n)).toBeCloseTo(0.05, 12)
    expect(n.x).toBeCloseTo(-1, 12)
    expect(footprintPush(0, 0, 0, HX, HY, corner, n)).toBeCloseTo(0.15 - 0.1, 12)
    expect(n.x).toBeCloseTo(-0.6, 12)
    expect(n.y).toBeCloseTo(-0.8, 12)
  })

  it('leaves through the nearest face when a circle center is inside the footprint', () => {
    const inside: Obstacle = { kind: 'cyl', id: 1, x: 0.1, y: 0, r: 0.1, hgt: 0.5 }
    const depth = footprintPush(0, 0, 0, HX, HY, inside, n)
    expect(depth).toBeCloseTo(0.05 + 0.1, 12)
    expect(n.x).toBe(-1)
    expect(footprintCollides(-(depth + 1e-6), 0, 0, HX, HY, [inside], 3)).toBe(false)
  })

  it('works in the rotated footprint frame and reports -1 when apart', () => {
    // Arrange: robot turned 90 deg, so its 0.125 m half width now faces +x
    const box: Obstacle = { kind: 'box', id: 1, x: 0.3, y: 0, w: 0.4, h: 0.4, a: 0, hgt: 0.5 }
    // Act
    const depth = footprintPush(0, 0, Math.PI / 2, HX, HY, box, n)
    // Assert: overlap 0.125 - 0.1 = 0.025 along -x
    expect(depth).toBeCloseTo(0.025, 12)
    expect(n.x).toBeCloseTo(-1, 9)
    expect(footprintPush(-1, 0, 0, HX, HY, box, n)).toBe(-1)
  })
})
