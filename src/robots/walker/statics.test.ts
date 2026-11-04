import { describe, expect, it } from 'vitest'
import { convexHull, distributeLoad, segmentDistance, stabilityMargin } from './statics'

function pts(list: [number, number][]): { px: Float64Array; py: Float64Array; n: number } {
  return { px: new Float64Array(list.map((p) => p[0])), py: new Float64Array(list.map((p) => p[1])), n: list.length }
}

const all = (n: number) => new Uint8Array(n).fill(1)

describe('convexHull', () => {
  it('returns the CCW outline and drops interior points', () => {
    const { px, py, n } = pts([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]])
    const hull = new Int32Array(8)
    const h = convexHull(px, py, all(n), n, hull)
    expect(h).toBe(4)
    expect(Array.from(hull.slice(0, h))).toEqual([0, 1, 2, 3])
  })

  it('ignores points not in the mask', () => {
    const { px, py, n } = pts([[0, 0], [1, 0], [1, 1], [0, 1]])
    const hull = new Int32Array(8)
    const h = convexHull(px, py, new Uint8Array([1, 1, 0, 1]), n, hull)
    expect(h).toBe(3)
    expect(Array.from(hull.slice(0, h)).sort()).toEqual([0, 1, 3])
  })

  it('collapses collinear points to the two ends', () => {
    const { px, py, n } = pts([[0, 0], [1, 1], [2, 2]])
    const hull = new Int32Array(8)
    expect(convexHull(px, py, all(n), n, hull)).toBe(2)
  })
})

describe('stabilityMargin', () => {
  const square = pts([[-1, -1], [1, -1], [1, 1], [-1, 1]])
  const hull = new Int32Array([0, 1, 2, 3])

  it('is the distance to the nearest edge inside the polygon', () => {
    expect(stabilityMargin(square.px, square.py, hull, 4, 0, 0)).toBeCloseTo(1, 12)
    expect(stabilityMargin(square.px, square.py, hull, 4, 0.75, 0)).toBeCloseTo(0.25, 12)
  })

  it('is negative outside the polygon by the distance to it', () => {
    expect(stabilityMargin(square.px, square.py, hull, 4, 3, 0)).toBeCloseTo(-2, 12)
    expect(stabilityMargin(square.px, square.py, hull, 4, 2, 2)).toBeCloseTo(-Math.SQRT2, 12)
  })

  it('is never positive with only two supports (a line has no interior)', () => {
    const two = pts([[-1, 0], [1, 0]])
    expect(stabilityMargin(two.px, two.py, new Int32Array([0, 1]), 2, 0, 0.5)).toBeCloseTo(-0.5, 12)
    expect(stabilityMargin(two.px, two.py, new Int32Array([0, 1]), 2, 0, 0)).toBeCloseTo(0, 12)
  })

  it('is −Infinity with no support', () => {
    expect(stabilityMargin(square.px, square.py, hull, 0, 0, 0)).toBe(-Infinity)
  })

  it('measures segment distance to the closest point on the segment', () => {
    expect(segmentDistance(0, 0, 2, 0, 1, 1)).toBeCloseTo(1, 12)
    expect(segmentDistance(0, 0, 2, 0, 3, 0)).toBeCloseTo(1, 12)
  })
})

describe('distributeLoad', () => {
  const W = 1.8 * 9.81

  function check(px: Float64Array, py: Float64Array, f: Float64Array, cx: number, cy: number): void {
    let sum = 0, mx = 0, my = 0
    for (let i = 0; i < px.length; i++) {
      sum += f[i]
      mx += f[i] * (py[i] - cy)
      my += f[i] * (px[i] - cx)
    }
    expect(sum).toBeCloseTo(W, 9)
    expect(mx).toBeCloseTo(0, 9)
    expect(my).toBeCloseTo(0, 9)
  }

  it('splits evenly over a symmetric hexagon with the CoM at the centre', () => {
    const p = pts(Array.from({ length: 6 }, (_, i) => [Math.cos((i * Math.PI) / 3) * 0.2, Math.sin((i * Math.PI) / 3) * 0.2] as [number, number]))
    const f = new Float64Array(6)
    const r = distributeLoad(p.px, p.py, all(6), 6, 0, 0, W, f)
    expect(r.balanced).toBe(true)
    for (let i = 0; i < 6; i++) expect(f[i]).toBeCloseTo(W / 6, 9)
  })

  it('sums to m·g and balances both moments for an off-centre CoM (tripod)', () => {
    const p = pts([[0.2, -0.15], [-0.2, -0.15], [0, 0.22]])
    const f = new Float64Array(3)
    const r = distributeLoad(p.px, p.py, all(3), 3, 0.03, -0.02, W, f)
    expect(r.balanced).toBe(true)
    check(p.px, p.py, f, 0.03, -0.02)
    for (let i = 0; i < 3; i++) expect(f[i]).toBeGreaterThan(0)
  })

  it('finds the minimum-norm solution among many for six feet', () => {
    const p = pts([[0.2, -0.15], [0, -0.22], [-0.2, -0.15], [0.2, 0.15], [0, 0.22], [-0.2, 0.15]])
    const f = new Float64Array(6)
    distributeLoad(p.px, p.py, all(6), 6, 0.02, 0.01, W, f)
    check(p.px, p.py, f, 0.02, 0.01)
    // minimum norm ⇔ f lies in the row space of the equilibrium matrix: f_i = a + b·x_i + c·y_i
    const det = (p.px[1] - p.px[0]) * (p.py[2] - p.py[0]) - (p.px[2] - p.px[0]) * (p.py[1] - p.py[0])
    const b = ((f[1] - f[0]) * (p.py[2] - p.py[0]) - (f[2] - f[0]) * (p.py[1] - p.py[0])) / det
    const c = ((p.px[1] - p.px[0]) * (f[2] - f[0]) - (p.px[2] - p.px[0]) * (f[1] - f[0])) / det
    const a = f[0] - b * p.px[0] - c * p.py[0]
    for (let i = 3; i < 6; i++) expect(f[i]).toBeCloseTo(a + b * p.px[i] + c * p.py[i], 9)
  })

  it('carries nothing on swing legs', () => {
    const p = pts([[0.2, -0.15], [0, -0.22], [-0.2, -0.15], [0.2, 0.15], [0, 0.22], [-0.2, 0.15]])
    const f = new Float64Array(6)
    distributeLoad(p.px, p.py, new Uint8Array([1, 0, 1, 0, 1, 0]), 6, 0, 0, W, f)
    expect(f[1]).toBe(0)
    expect(f[3]).toBe(0)
    expect(f[5]).toBe(0)
    expect(f[0] + f[2] + f[4]).toBeCloseTo(W, 9)
  })

  it('never asks a foot to pull: drops it when the CoM leaves the support', () => {
    const p = pts([[0.2, -0.15], [-0.2, -0.15], [0, 0.22]])
    const f = new Float64Array(3)
    // far beyond the edge between feet 0 and 1
    const r = distributeLoad(p.px, p.py, all(3), 3, 0, -0.4, W, f)
    expect(r.balanced).toBe(false)
    for (let i = 0; i < 3; i++) expect(f[i]).toBeGreaterThanOrEqual(0)
    expect(f[2]).toBe(0)
    expect(f[0] + f[1]).toBeCloseTo(W, 9)
  })

  it('uses the lever rule on two feet (trot diagonal)', () => {
    const p = pts([[0.2, -0.15], [-0.2, 0.15]])
    const f = new Float64Array(2)
    const r = distributeLoad(p.px, p.py, all(2), 2, 0.1, -0.075, W, f)
    expect(r.balanced).toBe(true)
    expect(f[0]).toBeCloseTo(0.75 * W, 9)
    expect(f[1]).toBeCloseTo(0.25 * W, 9)
  })

  it('reports imbalance when the CoM is off the line of two feet', () => {
    const p = pts([[0.2, -0.15], [-0.2, 0.15]])
    const f = new Float64Array(2)
    const r = distributeLoad(p.px, p.py, all(2), 2, 0.05, 0.05, W, f)
    expect(r.balanced).toBe(false)
    expect(f[0] + f[1]).toBeCloseTo(W, 9)
  })

  it('returns zero loads with no contact', () => {
    const p = pts([[0, 0], [1, 0], [0, 1]])
    const f = new Float64Array(3).fill(5)
    const r = distributeLoad(p.px, p.py, new Uint8Array(3), 3, 0, 0, W, f)
    expect(r.loaded).toBe(0)
    expect(Array.from(f)).toEqual([0, 0, 0])
  })
})
