import { describe, expect, it } from 'vitest'
import { integratePose, type Pose2, type Twist } from './mecanum'
import { followTarget, PurePursuit, type FollowParams, type PursuitTarget } from './pursuit'

const target = (): PursuitTarget => ({ x: 0, y: 0, remaining: 0, cross: 0, done: false })
const path = (pts: number[]) => {
  const p = new PurePursuit()
  p.setPath(Float64Array.from(pts), pts.length / 2)
  return p
}

/** Distance from (x, y) to the polyline. */
function distToPath(pts: number[], x: number, y: number): number {
  let best = Infinity
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2] - ax, by = pts[i + 3] - ay
    const t = Math.max(0, Math.min(1, ((x - ax) * bx + (y - ay) * by) / (bx * bx + by * by)))
    best = Math.min(best, Math.hypot(ax + bx * t - x, ay + by * t - y))
  }
  return best
}

describe('pure pursuit tracking', () => {
  it('places the lookahead point ahead of the projection on a straight path', () => {
    const p = path([0, 0, 4, 0])
    const t = p.track(1, 0.2, 0.5, target())
    expect(t.x).toBeCloseTo(1.5, 9)
    expect(t.y).toBeCloseTo(0, 9)
    expect(t.remaining).toBeCloseTo(3, 9)
    expect(t.cross).toBeCloseTo(0.2, 9)
    expect(t.done).toBe(false)
  })

  it('carries the lookahead around a corner and clamps it to the path end', () => {
    const p = path([0, 0, 1, 0, 1, 1])
    const t = p.track(0.9, 0, 0.4, target())
    expect(t.x).toBeCloseTo(1, 9)
    expect(t.y).toBeCloseTo(0.3, 9)
    const end = p.track(1, 0.9, 0.5, target())
    expect(end.x).toBeCloseTo(1, 9)
    expect(end.y).toBeCloseTo(1, 9)
  })

  it('only advances along the path, never back to an earlier segment', () => {
    const p = path([0, 0, 2, 0, 2, 0.4, 0, 0.4])
    p.track(2, 0.3, 0.2, target())
    expect(p.seg).toBe(1)
    p.track(1, 0.1, 0.2, target())
    expect(p.seg).toBeGreaterThanOrEqual(1)
  })

  it('reports done at the end of the path and for an empty path', () => {
    expect(path([0, 0, 1, 0]).track(1, 0.01, 0.3, target()).done).toBe(true)
    expect(new PurePursuit().track(0, 0, 0.3, target()).done).toBe(true)
  })
})

describe('holonomic follower', () => {
  const prm: FollowParams = { maxSpeed: 0.4, decel: 0.6, faceMotion: true }

  it('converges to the end of an L-shaped path with small cross-track error', () => {
    // Arrange
    const pts = [0, 0, 2, 0, 2, 1.5]
    const p = path(pts)
    const pose: Pose2 = { x: 0, y: -0.1, th: Math.PI / 2 }
    const tw: Twist = { vx: 0, vy: 0, wz: 0 }
    const t = target()
    let worst = 0
    let steps = 0
    // Act
    for (; steps < 120 * 30; steps++) {
      p.track(pose.x, pose.y, 0.3, t)
      if (t.done) break
      followTarget(pose, t, prm, tw)
      integratePose(pose, tw.vx, tw.vy, tw.wz, 1 / 120, pose)
      if (steps > 120) worst = Math.max(worst, distToPath(pts, pose.x, pose.y))
    }
    // Assert
    expect(t.done).toBe(true)
    expect(Math.hypot(pose.x - 2, pose.y - 1.5)).toBeLessThan(0.05)
    expect(worst).toBeLessThan(0.15)
    expect(steps / 120).toBeLessThan(15)
  })

  it('faces the direction of travel while moving', () => {
    const pose: Pose2 = { x: 0, y: 0, th: 0 }
    const tw: Twist = { vx: 0, vy: 0, wz: 0 }
    followTarget(pose, { x: 0, y: 1, remaining: 1, cross: 0, done: false }, prm, tw)
    expect(tw.wz).toBeGreaterThan(0)
    expect(tw.vy).toBeGreaterThan(0)
    expect(Math.abs(tw.vx)).toBeLessThan(1e-9)
  })

  it('outputs zero twist once the target is done', () => {
    const tw: Twist = { vx: 1, vy: 1, wz: 1 }
    followTarget({ x: 0, y: 0, th: 0 }, { x: 1, y: 0, remaining: 0, cross: 0, done: true }, prm, tw)
    expect(tw).toEqual({ vx: 0, vy: 0, wz: 0 })
  })

  it('never exceeds the speed limit', () => {
    const tw: Twist = { vx: 0, vy: 0, wz: 0 }
    followTarget({ x: 0, y: 0, th: 0 }, { x: 5, y: 0, remaining: 5, cross: 0, done: false }, prm, tw)
    expect(Math.hypot(tw.vx, tw.vy)).toBeLessThanOrEqual(0.4 + 1e-12)
  })
})
