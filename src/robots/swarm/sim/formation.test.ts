import { describe, expect, it } from 'vitest'
import { FORMATION_SHAPES, formationOffsets, isFormationShape, slotWorld } from './formation'
import type { FormationShape } from './formation'

function pts(shape: FormationShape, n: number, s: number): [number, number][] {
  const o = formationOffsets(new Float64Array(12), shape, n, s)
  return Array.from({ length: n }, (_, k) => [o[2 * k], o[2 * k + 1]])
}

function minPairDistance(p: [number, number][]): number {
  let m = Infinity
  for (let i = 0; i < p.length; i++)
    for (let j = i + 1; j < p.length; j++) m = Math.min(m, Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1]))
  return m
}

describe('formation offsets', () => {
  it('puts the leader at the origin and keeps every pair at least one spacing apart', () => {
    for (const shape of FORMATION_SHAPES) {
      for (let n = 3; n <= 6; n++) {
        // Act
        const p = pts(shape, n, 2)
        // Assert
        expect(p[0]).toEqual([0, 0])
        expect(minPairDistance(p)).toBeGreaterThanOrEqual(2 - 1e-9)
      }
    }
  })

  it('line: all abreast of the leader, alternating right then left', () => {
    const p = pts('line', 5, 1.5)
    expect(p.map((q) => q[0])).toEqual([0, 0, 0, 0, 0])
    expect(p.map((q) => q[1])).toEqual([0, -1.5, 1.5, -3, 3])
  })

  it('wedge: symmetric V behind the leader at a 50° arm angle', () => {
    const p = pts('wedge', 5, 2)
    expect(p[1][0]).toBeCloseTo(p[2][0], 12)
    expect(p[1][1]).toBeCloseTo(-p[2][1], 12)
    expect(p[1][0]).toBeLessThan(0)
    expect(Math.hypot(p[1][0], p[1][1])).toBeCloseTo(2, 12)
    expect((Math.atan2(Math.abs(p[1][1]), -p[1][0]) * 180) / Math.PI).toBeCloseTo(50, 9)
    expect(Math.hypot(p[3][0], p[3][1])).toBeCloseTo(4, 12)
  })

  it('triangle: a full 6-drone triangle has rows of 1, 2 and 3 with equilateral spacing', () => {
    const p = pts('triangle', 6, 2)
    const depth = 2 * Math.sqrt(3) / 2
    expect(p[1][0]).toBeCloseTo(-depth, 12)
    expect(p[2][0]).toBeCloseTo(-depth, 12)
    expect(p.slice(3).every((q) => Math.abs(q[0] + 2 * depth) < 1e-12)).toBe(true)
    expect(Math.hypot(p[1][0], p[1][1])).toBeCloseTo(2, 12)
    expect(p[3][1] + p[5][1]).toBeCloseTo(0, 12)
  })

  it('triangle: a partial last row stays on the lattice and symmetric', () => {
    const four = pts('triangle', 4, 2)
    expect(four[3][1]).toBeCloseTo(0, 12)
    const five = pts('triangle', 5, 2)
    expect(five[3][1] + five[4][1]).toBeCloseTo(0, 12)
    expect(Math.abs(five[3][1])).toBeCloseTo(2, 12)
  })

  it('circle: every slot is on one ring and neighbours are one spacing apart', () => {
    for (let n = 3; n <= 6; n++) {
      const s = 1.8
      const p = pts('circle', n, s)
      const r = s / (2 * Math.sin(Math.PI / n))
      for (const q of p) expect(Math.hypot(q[0] + r, q[1])).toBeCloseTo(r, 9)
      for (let k = 0; k < n; k++) {
        const a = p[k], b = p[(k + 1) % n]
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(s, 9)
      }
    }
  })

  it('column: single file straight behind the leader', () => {
    const p = pts('column', 4, 2.5)
    expect(p).toEqual([[0, 0], [-2.5, 0], [-5, 0], [-7.5, 0]])
  })

  it('rotates and translates slots with the formation heading', () => {
    const o = formationOffsets(new Float64Array(12), 'column', 3, 2)
    const out = new Float64Array(2)
    slotWorld(out, o, 1, 10, 5, Math.PI / 2)
    // heading +y: "behind" is -y
    expect(out[0]).toBeCloseTo(10, 12)
    expect(out[1]).toBeCloseTo(3, 12)
  })

  it('validates shape names', () => {
    expect(isFormationShape('wedge')).toBe(true)
    expect(isFormationShape('blob')).toBe(false)
    expect(isFormationShape(3)).toBe(false)
  })
})
