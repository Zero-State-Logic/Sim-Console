import { describe, expect, it } from 'vitest'
import { canPlace, defaultLayout, parseArenaConfig, randomLayout, rescaleLayout, serializeObstacle, startPose } from './arena'
import { FOOT_HX, FOOT_HY, MAX_OBSTACLES } from './constants'
import { footprintCollides, obstacleInsideRoom, obstaclesOverlap, type Obstacle } from './geom2d'
import { Rng } from './rng'

function noOverlaps(obs: readonly Obstacle[]): boolean {
  return obs.every((a, i) => obs.every((b, j) => i === j || !obstaclesOverlap(a, b)))
}

describe('default furnished room', () => {
  it.each([3, 6, 10])('fits a %d m room without overlaps and leaves the start pose free', (size) => {
    const obs = defaultLayout(size)
    const s = startPose(size)
    expect(obs.length).toBeGreaterThan(size >= 6 ? 8 : 0)
    for (const o of obs) expect(obstacleInsideRoom(o, size / 2)).toBe(true)
    expect(noOverlaps(obs)).toBe(true)
    expect(footprintCollides(s.x, s.y, s.th, FOOT_HX, FOOT_HY, obs, size / 2)).toBe(false)
  })
})

describe('random rooms', () => {
  it('are reproducible from the seed, passable and clear of the robot', () => {
    const robot = startPose(6)
    const a = randomLayout(new Rng(42), 6, robot, 1)
    const b = randomLayout(new Rng(42), 6, robot, 1)
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(4)
    expect(a.length).toBeLessThanOrEqual(MAX_OBSTACLES)
    for (const o of a) expect(canPlace(o, a, 3, robot, 0)).toBe(true)
  })
})

describe('rescaling', () => {
  it('moves centers with the room and drops what no longer fits', () => {
    const obs = rescaleLayout(defaultLayout(6), 6, 3)
    for (const o of obs) expect(obstacleInsideRoom(o, 1.5)).toBe(true)
    expect(noOverlaps(obs)).toBe(true)
  })
})

describe('config validation (untrusted profiles)', () => {
  it('accepts a well-formed config, clamping sizes and snapping the room to 0.5 m', () => {
    const c = parseArenaConfig({ size: 6.2, obstacles: [{ kind: 'box', x: 0, y: 0, w: 9, h: 0.5, a: 0.3, hgt: 0.6 }, { kind: 'cyl', x: 1, y: 1, r: 0.2 }] })
    expect(c?.size).toBe(6)
    expect(c?.obstacles).toHaveLength(2)
    const b = c?.obstacles[0]
    expect(b?.kind === 'box' && b.w).toBe(4)
    expect(c?.obstacles[1].hgt).toBe(0.5)
  })

  it('rejects junk and skips malformed obstacles', () => {
    expect(parseArenaConfig(null)).toBeNull()
    expect(parseArenaConfig({ size: 6 })).toBeNull()
    expect(parseArenaConfig({ size: 'x', obstacles: [] })).toBeNull()
    const c = parseArenaConfig({ size: 6, obstacles: [{ kind: 'pyramid', x: 0, y: 0 }, { kind: 'cyl', x: 'a', y: 0, r: 1 }, 7] })
    expect(c?.obstacles).toEqual([])
  })

  it('caps the obstacle count', () => {
    const many = Array.from({ length: 200 }, () => ({ kind: 'cyl', x: 0, y: 0, r: 0.1 }))
    expect(parseArenaConfig({ size: 6, obstacles: many })?.obstacles).toHaveLength(MAX_OBSTACLES)
  })

  it('serializes obstacles to millimetres without ids', () => {
    expect(serializeObstacle({ kind: 'cyl', id: 3, x: 1.23456, y: 0, r: 0.2, hgt: 0.5 })).toEqual({ kind: 'cyl', x: 1.235, y: 0, r: 0.2, hgt: 0.5 })
  })

  it('clamps obstacles to the snapped room, not the requested size', () => {
    // a 5.2 m request builds a 5.0 m room: a cylinder at x = 2.55 must end up inside it
    const c = parseArenaConfig({ size: 5.2, obstacles: [{ kind: 'cyl', x: 2.55, y: 0, r: 0.1 }] })
    expect(c?.size).toBe(5)
    const o = c?.obstacles[0]
    expect(o && o.kind === 'cyl' && o.x + o.r).toBeLessThanOrEqual(2.5 + 1e-12)
  })
})
