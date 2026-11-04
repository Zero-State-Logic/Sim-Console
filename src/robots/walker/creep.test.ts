import { describe, expect, it } from 'vitest'
import { creepPoint, incentre, smoothstep, triangleMargin } from './creep'

describe('incentre', () => {
  it('is equally far from all three edges (the inradius)', () => {
    const out = new Float64Array(2)
    expect(incentre(0, 0, 4, 0, 0, 3, out, 0)).toBe(true)
    // 3-4-5 triangle: inradius (a + b − c) / 2 = 1, at (1, 1)
    expect(out[0]).toBeCloseTo(1, 12)
    expect(out[1]).toBeCloseTo(1, 12)
    expect(triangleMargin(0, 0, 4, 0, 0, 3, out[0], out[1])).toBeCloseTo(1, 12)
  })

  it('rejects a degenerate (collinear) triangle', () => {
    expect(incentre(0, 0, 1, 1, 2, 2, new Float64Array(2), 0)).toBe(false)
  })
})

describe('triangleMargin', () => {
  it('is positive inside, negative outside, for either winding', () => {
    expect(triangleMargin(0, 0, 4, 0, 0, 3, 0.5, 0.5)).toBeCloseTo(0.5, 12)
    expect(triangleMargin(0, 0, 0, 3, 4, 0, 0.5, 0.5)).toBeCloseTo(0.5, 12)
    expect(triangleMargin(0, 0, 4, 0, 0, 3, -1, 1)).toBeCloseTo(-1, 12)
    expect(triangleMargin(0, 0, 4, 0, 0, 3, 4, 3)).toBeLessThan(0)
  })
})

describe('smoothstep', () => {
  it('runs 0 → 1 with flat ends and clamps outside', () => {
    expect(smoothstep(-1)).toBe(0)
    expect(smoothstep(0.5)).toBe(0.5)
    expect(smoothstep(2)).toBe(1)
    expect(smoothstep(0.01)).toBeLessThan(0.001)
  })
})

describe('creepPoint', () => {
  // support triangle of a quad with the left-hind foot lifted; the origin sits on its diagonal edge
  const T = [0.18, -0.15, -0.18, -0.15, 0.18, 0.15] as const

  it('moves from the origin toward the incentre just far enough for the wanted margin', () => {
    // Arrange
    const out = new Float64Array(2)
    const inc = new Float64Array(2)
    incentre(T[0], T[1], T[2], T[3], T[4], T[5], inc, 0)
    // Act
    expect(creepPoint(T[0], T[1], T[2], T[3], T[4], T[5], 0.025, out, 0)).toBe(true)
    // Assert: on the origin → incentre segment, at a margin of exactly 25 mm (origin margin is 0)
    expect(out[0] * inc[1] - out[1] * inc[0]).toBeCloseTo(0, 12)
    expect(Math.hypot(out[0], out[1])).toBeLessThan(Math.hypot(inc[0], inc[1]))
    expect(triangleMargin(T[0], T[1], T[2], T[3], T[4], T[5], out[0], out[1])).toBeCloseTo(0.025, 9)
  })

  it('does not sway when the origin is already safe, and stops at the incentre for a small triangle', () => {
    const out = new Float64Array(2)
    creepPoint(-0.2, -0.2, 0.2, -0.2, 0, 0.3, 0.025, out, 0)
    expect(Math.hypot(out[0], out[1])).toBe(0)
    const inc = new Float64Array(2)
    incentre(0.05, 0, 0.09, 0, 0.07, 0.03, inc, 0)
    creepPoint(0.05, 0, 0.09, 0, 0.07, 0.03, 0.025, out, 0)
    expect(out[0]).toBeCloseTo(inc[0], 12)
    expect(out[1]).toBeCloseTo(inc[1], 12)
  })

  it('rejects a degenerate triangle', () => {
    expect(creepPoint(0, 0, 1, 1, 2, 2, 0.02, new Float64Array(2), 0)).toBe(false)
  })
})
