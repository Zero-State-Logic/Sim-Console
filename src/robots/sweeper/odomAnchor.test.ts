import { describe, expect, it } from 'vitest'
import { OdomAnchor } from './odomAnchor'

describe('odometry anchor', () => {
  it('maps the anchoring odometry pose exactly onto the world pose', () => {
    const a = new OdomAnchor()
    a.set({ x: -2.4, y: -2.4, th: 0.3 }, 1, 2, -0.5)
    const p = a.map(1, 2, -0.5, { x: 0, y: 0, th: 0 })
    expect(a.valid).toBe(true)
    expect(p.x).toBeCloseTo(-2.4)
    expect(p.y).toBeCloseTo(-2.4)
    expect(p.th).toBeCloseTo(0.3)
  })

  it('turns odometry motion by the heading offset (rigid transform)', () => {
    // Arrange: odom heading 0 is world heading +90 deg
    const a = new OdomAnchor()
    a.set({ x: 1, y: 1, th: Math.PI / 2 }, 0, 0, 0)
    // Act: the board drove 1 m along its +x
    const p = a.map(1, 0, 0, { x: 0, y: 0, th: 0 })
    // Assert: in the world that is 1 m along +y
    expect(p.x).toBeCloseTo(1)
    expect(p.y).toBeCloseTo(2)
    expect(p.th).toBeCloseTo(Math.PI / 2)
  })

  it('preserves distances between odometry poses', () => {
    const a = new OdomAnchor()
    a.set({ x: 0.3, y: -1, th: 2.1 }, 4, -3, 1.2)
    const p = a.map(4.6, -2.2, 0, { x: 0, y: 0, th: 0 })
    const q = a.map(4, -3, 0, { x: 0, y: 0, th: 0 })
    expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeCloseTo(1)
  })

  it('needs a new anchor after reset', () => {
    const a = new OdomAnchor()
    a.set({ x: 0, y: 0, th: 0 }, 0, 0, 0)
    a.reset()
    expect(a.valid).toBe(false)
  })
})
