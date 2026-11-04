import { describe, expect, it } from 'vitest'
import {
  integratePose,
  mecanumForward,
  mecanumInverse,
  rateLimitWheels,
  saturateWheels,
  wrapAngle,
  type Pose2,
  type Twist,
} from './mecanum'

const twist = (): Twist => ({ vx: 0, vy: 0, wz: 0 })

describe('mecanum kinematics', () => {
  it('forward kinematics inverts inverse kinematics for arbitrary twists', () => {
    // Arrange
    const cases: [number, number, number][] = [[0.3, 0, 0], [0, 0.2, 0], [0, 0, 1.2], [0.25, -0.15, 0.7], [-0.4, 0.33, -2]]
    const w = new Float64Array(4)
    for (const [vx, vy, wz] of cases) {
      // Act
      mecanumInverse(vx, vy, wz, w)
      const out = mecanumForward(w, twist())
      // Assert
      expect(out.vx).toBeCloseTo(vx, 10)
      expect(out.vy).toBeCloseTo(vy, 10)
      expect(out.wz).toBeCloseTo(wz, 10)
    }
  })

  it('drives all wheels forward equally for a pure forward twist', () => {
    const w = new Float64Array(4)
    mecanumInverse(0.4, 0, 0, w)
    expect([...w]).toEqual([10, 10, 10, 10])
  })

  it('uses the X-roller pattern for a left strafe (FL and RR backward)', () => {
    const w = new Float64Array(4)
    mecanumInverse(0, 0.2, 0, w)
    expect(w[0]).toBeLessThan(0)
    expect(w[1]).toBeGreaterThan(0)
    expect(w[2]).toBeGreaterThan(0)
    expect(w[3]).toBeLessThan(0)
  })

  it('spins left wheels backward and right wheels forward for a CCW turn', () => {
    const w = new Float64Array(4)
    mecanumInverse(0, 0, 1, w)
    expect(w[0]).toBeLessThan(0)
    expect(w[2]).toBeLessThan(0)
    expect(w[1]).toBeGreaterThan(0)
    expect(w[3]).toBeGreaterThan(0)
  })
})

describe('wheel saturation and rate limit', () => {
  it('scales every wheel by one factor so the twist keeps its direction', () => {
    // Arrange
    const w = new Float64Array(4)
    mecanumInverse(1.0, 0.6, 2.0, w)
    const before = mecanumForward(w, twist())
    // Act
    const s = saturateWheels(w, 15)
    const after = mecanumForward(w, twist())
    // Assert
    expect(s).toBeLessThan(1)
    expect(Math.max(...[...w].map(Math.abs))).toBeCloseTo(15, 9)
    expect(after.vx / before.vx).toBeCloseTo(s, 9)
    expect(after.vy / before.vy).toBeCloseTo(s, 9)
    expect(after.wz / before.wz).toBeCloseTo(s, 9)
  })

  it('leaves wheels below the limit untouched', () => {
    const w = [1, -2, 3, -4]
    expect(saturateWheels(w, 15)).toBe(1)
    expect(w).toEqual([1, -2, 3, -4])
  })

  it('limits the largest wheel change and keeps the change direction', () => {
    // Arrange
    const cur = new Float64Array([0, 0, 0, 0])
    const target = [10, -5, 2, 0]
    // Act
    rateLimitWheels(cur, target, 1)
    // Assert
    expect(cur[0]).toBeCloseTo(1, 12)
    expect(cur[1]).toBeCloseTo(-0.5, 12)
    expect(cur[2]).toBeCloseTo(0.2, 12)
    expect(cur[3]).toBe(0)
  })

  it('reaches the target when the change is within the limit', () => {
    const cur = new Float64Array([1, 1, 1, 1])
    rateLimitWheels(cur, [1.2, 0.9, 1, 1.1], 0.5)
    expect([...cur]).toEqual([1.2, 0.9, 1, 1.1])
  })
})

describe('pose integration', () => {
  it('moves straight along the heading for a pure forward twist', () => {
    const p: Pose2 = { x: 1, y: 2, th: Math.PI / 2 }
    integratePose(p, 0.5, 0, 0, 2, p)
    expect(p.x).toBeCloseTo(1, 12)
    expect(p.y).toBeCloseTo(3, 12)
  })

  it('strafes sideways in the body frame', () => {
    const p: Pose2 = { x: 0, y: 0, th: 0 }
    integratePose(p, 0, 0.3, 0, 1, p)
    expect(p.x).toBeCloseTo(0, 12)
    expect(p.y).toBeCloseTo(0.3, 12)
  })

  it('closes a full circle exactly for constant vx and wz', () => {
    // Arrange
    const p: Pose2 = { x: 0, y: 0, th: 0 }
    const wz = 0.8
    // Act
    integratePose(p, 0.4, 0, wz, (2 * Math.PI) / wz, p)
    // Assert
    expect(p.x).toBeCloseTo(0, 9)
    expect(p.y).toBeCloseTo(0, 9)
  })

  it('agrees with many small Euler steps on an arc', () => {
    const exact: Pose2 = { x: 0, y: 0, th: 0.3 }
    integratePose(exact, 0.3, 0.1, 0.9, 1.5, exact)
    const euler: Pose2 = { x: 0, y: 0, th: 0.3 }
    const n = 20000, h = 1.5 / n
    for (let i = 0; i < n; i++) {
      const c = Math.cos(euler.th), s = Math.sin(euler.th)
      euler.x += (c * 0.3 - s * 0.1) * h
      euler.y += (s * 0.3 + c * 0.1) * h
      euler.th += 0.9 * h
    }
    expect(exact.x).toBeCloseTo(euler.x, 4)
    expect(exact.y).toBeCloseTo(euler.y, 4)
  })

  it('is continuous across the small-angle branch', () => {
    const a: Pose2 = { x: 0, y: 0, th: 0 }
    const b: Pose2 = { x: 0, y: 0, th: 0 }
    integratePose(a, 0.5, 0.2, 1e-7, 1, a)
    integratePose(b, 0.5, 0.2, 1e-5, 1, b)
    expect(a.x).toBeCloseTo(b.x, 5)
    expect(a.y).toBeCloseTo(b.y, 5)
  })

  it('wraps angles into [-pi, pi)', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(-Math.PI, 12)
    expect(wrapAngle(-Math.PI / 2 - 2 * Math.PI)).toBeCloseTo(-Math.PI / 2, 12)
    expect(wrapAngle(0.5)).toBeCloseTo(0.5, 12)
  })
})
