import { describe, expect, it } from 'vitest'
import { FIT_NONE, FIT_RIGID, FIT_TRANSLATION, fitRigid, largestEigenvector4, levelOnPlane, loadSymmetric4, lowestPoint, supportPlane } from './bodyFit'
import { bodyToWorld, rotationZYX, worldToBody } from './pose'

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

const I3 = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1])

/** World points w = pos + R·b for body points b. */
function transform(b: Float64Array, n: number, pos: Float64Array, R: Float64Array): Float64Array {
  const w = new Float64Array(n * 3)
  for (let i = 0; i < n; i++) bodyToWorld(pos, R, b[i * 3], b[i * 3 + 1], b[i * 3 + 2], w, i * 3)
  return w
}

function residual(b: Float64Array, w: Float64Array, n: number, pos: Float64Array, R: Float64Array): number {
  const m = transform(b, n, pos, R)
  let e = 0
  for (let k = 0; k < n * 3; k++) e += (m[k] - w[k]) ** 2
  return e
}

describe('fitRigid', () => {
  it('recovers a random rigid transform exactly from 3 to 8 feet', () => {
    // Arrange
    const rand = rng(7)
    for (let trial = 0; trial < 200; trial++) {
      const n = 3 + (trial % 6)
      const b = new Float64Array(n * 3)
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI + rand() * 0.3
        b[i * 3] = Math.cos(a) * (0.15 + rand() * 0.1)
        b[i * 3 + 1] = Math.sin(a) * (0.15 + rand() * 0.1)
        b[i * 3 + 2] = -0.08 - rand() * 0.04
      }
      const R0 = new Float64Array(9)
      rotationZYX((rand() * 2 - 1) * Math.PI, (rand() - 0.5) * 0.6, (rand() - 0.5) * 0.6, R0)
      const p0 = new Float64Array([rand() - 0.5, rand() - 0.5, 0.05 + rand() * 0.1])
      const w = transform(b, n, p0, R0)
      const pos = new Float64Array(3)
      const R = new Float64Array(9)
      // Act
      const kind = fitRigid(b, w, new Uint8Array(n).fill(1), n, I3, pos, R)
      // Assert
      expect(kind).toBe(FIT_RIGID)
      for (let k = 0; k < 9; k++) expect(R[k]).toBeCloseTo(R0[k], 9)
      for (let k = 0; k < 3; k++) expect(pos[k]).toBeCloseTo(p0[k], 9)
    }
  })

  it('reproduces the planned pose when the feet are where the plan put them (coplanar ground points)', () => {
    const n = 6
    const b = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI
      b[i * 3] = 0.24 * Math.cos(a)
      b[i * 3 + 1] = 0.24 * Math.sin(a)
      b[i * 3 + 2] = -0.085
    }
    const R0 = new Float64Array(9)
    rotationZYX(0.4, 0, 0, R0)
    const p0 = new Float64Array([0.3, -0.2, 0.085])
    const w = transform(b, n, p0, R0)
    const pos = new Float64Array(3)
    const R = new Float64Array(9)
    fitRigid(b, w, new Uint8Array(n).fill(1), n, I3, pos, R)
    for (let k = 0; k < 9; k++) expect(R[k]).toBeCloseTo(R0[k], 10)
    expect(pos[2]).toBeCloseTo(0.085, 10)
  })

  it('is the least-squares optimum for noisy points (no small perturbation does better)', () => {
    const rand = rng(3)
    const n = 6
    const b = new Float64Array(n * 3)
    for (let k = 0; k < n * 3; k++) b[k] = rand() - 0.5
    const R0 = new Float64Array(9)
    rotationZYX(0.3, 0.1, -0.2, R0)
    const w = transform(b, n, new Float64Array([0.1, 0.2, 0.3]), R0)
    for (let k = 0; k < n * 3; k++) w[k] += (rand() - 0.5) * 0.01
    const pos = new Float64Array(3)
    const R = new Float64Array(9)
    fitRigid(b, w, new Uint8Array(n).fill(1), n, I3, pos, R)
    const best = residual(b, w, n, pos, R)
    const Rp = new Float64Array(9)
    const dR = new Float64Array(9)
    for (const [dy, dp, dr] of [[1e-3, 0, 0], [0, 1e-3, 0], [0, 0, 1e-3], [-1e-3, 0, 0], [0, -1e-3, 0], [0, 0, -1e-3]]) {
      rotationZYX(dy, dp, dr, dR)
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        Rp[r * 3 + c] = dR[r * 3] * R[c] + dR[r * 3 + 1] * R[3 + c] + dR[r * 3 + 2] * R[6 + c]
      }
      expect(residual(b, w, n, pos, Rp)).toBeGreaterThan(best)
    }
  })

  it('only fits the translation with two feet or collinear feet, keeping the guess rotation', () => {
    const guess = new Float64Array(9)
    rotationZYX(0.2, 0, 0, guess)
    const b = new Float64Array([0.2, 0, -0.1, -0.2, 0, -0.1, 0, 0, -0.1])
    const w = transform(b, 3, new Float64Array([1, 2, 0.1]), guess)
    const pos = new Float64Array(3)
    const R = new Float64Array(9)
    expect(fitRigid(b, w, new Uint8Array([1, 1, 0]), 3, guess, pos, R)).toBe(FIT_TRANSLATION)
    expect(Array.from(R)).toEqual(Array.from(guess))
    expect(pos[0]).toBeCloseTo(1, 12)
    expect(pos[2]).toBeCloseTo(0.1, 12)
    // three points on one line are still collinear
    expect(fitRigid(b, w, new Uint8Array([1, 1, 1]), 3, guess, pos, R)).toBe(FIT_TRANSLATION)
  })

  it('reports FIT_NONE and writes nothing when no foot is masked', () => {
    const pos = new Float64Array([9, 9, 9])
    const R = new Float64Array(9)
    expect(fitRigid(new Float64Array(6), new Float64Array(6), new Uint8Array(2), 2, I3, pos, R)).toBe(FIT_NONE)
    expect(Array.from(pos)).toEqual([9, 9, 9])
  })
})

describe('largestEigenvector4', () => {
  it('finds the dominant eigenvector of a symmetric matrix', () => {
    // diag(1, 5, 2, -3) rotated by a known orthogonal basis change is still dominated by e1
    loadSymmetric4([1, 0, 0, 0, 0, 5, 0, 0, 0, 0, 2, 0, 0, 0, 0, -3])
    const v = new Float64Array(4)
    largestEigenvector4(v)
    expect(Math.abs(v[1])).toBeCloseTo(1, 12)
    // a dense matrix: check A·v = λ·v for the returned vector
    const M = [4, 1, 2, 0.5, 1, 3, 0, 1, 2, 0, 5, 1.5, 0.5, 1, 1.5, 2]
    loadSymmetric4(M)
    largestEigenvector4(v)
    const Av = [0, 1, 2, 3].map((r) => M[r * 4] * v[0] + M[r * 4 + 1] * v[1] + M[r * 4 + 2] * v[2] + M[r * 4 + 3] * v[3])
    const lambda = Av[0] * v[0] + Av[1] * v[1] + Av[2] * v[2] + Av[3] * v[3]
    for (let r = 0; r < 4; r++) expect(Av[r]).toBeCloseTo(lambda * v[r], 9)
    expect(lambda).toBeGreaterThan(6)
  })
})

describe('lowestPoint', () => {
  it('returns the lowest world height of the points under the rotation', () => {
    const R = new Float64Array(9)
    rotationZYX(0, 0, 0.3, R)
    const b = new Float64Array([0, 0.1, -0.1, 0, -0.1, -0.1])
    // rolled right side down: the y = −0.1 point drops
    expect(lowestPoint(b, 2, R)).toBeCloseTo(-0.1 * Math.sin(0.3) - 0.1 * Math.cos(0.3), 12)
    expect(lowestPoint(b, 0, R)).toBe(Infinity)
  })
})

describe('supportPlane + levelOnPlane', () => {
  it('rests a tilted body back on the ground it stands on', () => {
    // Arrange: six feet on flat ground, seen from a body pitched and rolled at 0.09 m
    const R0 = new Float64Array(9)
    rotationZYX(0.4, 0.08, -0.05, R0)
    const p0 = new Float64Array([0.2, -0.1, 0.09])
    const b = new Float64Array(18)
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * 2 * Math.PI + 0.3
      worldToBody(p0, R0, 0.2 + 0.24 * Math.cos(a), -0.1 + 0.24 * Math.sin(a), 0, b, i * 3)
    }
    const plane = new Float64Array(4)
    // Act
    expect(supportPlane(b, 6, plane)).toBe(true)
    const R = new Float64Array(9)
    levelOnPlane(plane[0], plane[1], plane[2], 0.4, R)
    // Assert: the original attitude and height come back; every foot is on the ground
    for (let k = 0; k < 9; k++) expect(R[k]).toBeCloseTo(R0[k], 2)
    expect(-plane[3]).toBeCloseTo(0.09, 12)
    const w = transform(b, 6, new Float64Array([0, 0, -plane[3]]), R)
    for (let i = 0; i < 6; i++) expect(w[i * 3 + 2]).toBeCloseTo(0, 12)
  })

  it('stands on the lowest feet and leaves a raised foot in the air', () => {
    const b = new Float64Array(18)
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * 2 * Math.PI
      b[i * 3] = 0.24 * Math.cos(a)
      b[i * 3 + 1] = 0.24 * Math.sin(a)
      b[i * 3 + 2] = i === 2 ? -0.07 : -0.085
    }
    const plane = new Float64Array(4)
    expect(supportPlane(b, 6, plane)).toBe(true)
    expect(plane[2]).toBeCloseTo(1, 12)
    expect(-plane[3]).toBeCloseTo(0.085, 12)
  })

  it('finds no support with fewer than three feet or when the body is not over the feet', () => {
    const plane = new Float64Array(4)
    expect(supportPlane(new Float64Array([0.1, 0, -0.1, -0.1, 0, -0.1]), 2, plane)).toBe(false)
    const off = new Float64Array([0.3, 0.1, -0.1, 0.5, 0.1, -0.1, 0.4, 0.3, -0.1])
    expect(supportPlane(off, 3, plane)).toBe(false)
  })
})
