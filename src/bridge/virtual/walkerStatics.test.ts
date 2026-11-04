import { describe, expect, it } from 'vitest'
import { neutralFeet } from '../../codegen/walkerGeom'
import { anglesForFeet, geomOf, tiltedFeet, walkerGeometrySpec } from './fixtures'
import { WalkerStatics, distributeLoads } from './walkerStatics'

const RAD = Math.PI / 180

function standing(legs: 4 | 6 | 8 = 6, h = 0.09): { st: WalkerStatics; feet: [number, number, number][] } {
  const g = geomOf(walkerGeometrySpec(legs))
  const nf = neutralFeet(g)
  const feet = nf.x.map((x, i): [number, number, number] => [x, nf.y[i], -h])
  return { st: new WalkerStatics(g), feet }
}

function sum(a: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]
  return s
}

describe('WalkerStatics: ground plane and tilt', () => {
  it('reads a level body and shares the weight equally on a symmetric hexapod stance', () => {
    // Arrange
    const { st, feet } = standing(6)
    // Act
    st.update(anglesForFeet(geomOf(walkerGeometrySpec(6)), feet))
    // Assert
    expect(st.supported).toBe(true)
    expect(st.roll).toBeCloseTo(0, 6)
    expect(st.pitch).toBeCloseTo(0, 6)
    expect(Array.from(st.stance)).toEqual([1, 1, 1, 1, 1, 1])
    for (const f of st.load) expect(f).toBeCloseTo(1 / 6, 6)
  })

  it.each([
    [8, 0],
    [0, -6],
    [5, 7],
    [-10, 4],
  ])('recovers a body roll of %d° and pitch of %d° from the feet the servos reached', (rollDeg, pitchDeg) => {
    // Arrange
    const g = geomOf(walkerGeometrySpec(6))
    const st = new WalkerStatics(g)
    const q = anglesForFeet(g, tiltedFeet(g, rollDeg * RAD, pitchDeg * RAD, 0.09))
    // Act
    st.update(q)
    // Assert
    expect(st.roll / RAD).toBeCloseTo(rollDeg, 4)
    expect(st.pitch / RAD).toBeCloseTo(pitchDeg, 4)
    expect(sum(st.load)).toBeCloseTo(1, 9)
  })

  it('finds the swing feet above the ground and fits the tilt to the planted ones only', () => {
    // Arrange: a tripod mid-swing on a body rolled 6°
    const g = geomOf(walkerGeometrySpec(6))
    const st = new WalkerStatics(g)
    const feet = tiltedFeet(g, 6 * RAD, 0, 0.09)
    for (const i of [0, 2, 4]) feet[i] = [feet[i][0], feet[i][1], feet[i][2] + 0.03]
    // Act
    st.update(anglesForFeet(g, feet))
    // Assert
    expect(Array.from(st.stance)).toEqual([0, 1, 0, 1, 0, 1])
    expect(st.roll / RAD).toBeCloseTo(6, 3)
    expect(st.load[0] + st.load[2] + st.load[4]).toBe(0)
    expect(sum(st.load)).toBeCloseTo(1, 9)
  })

  it('rocks a trotting quadruped onto the swing foot on the CoM side of its stance diagonal', () => {
    // Arrange: FL (0) and RR (2) lifted, RL (1) and FR (3) down; feet 1 cm forward puts the CoM on the RR side
    const { st, feet } = standing(4)
    const g = geomOf(walkerGeometrySpec(4))
    const trot = feet.map(([x, y, z], i): [number, number, number] => [x + 0.01, y, z + (i === 0 || i === 2 ? 0.03 : 0)])
    // Act
    st.update(anglesForFeet(g, trot))
    // Assert: the body tips toward the rear right (right side down = roll +, rear down = pitch −)
    expect(st.supported).toBe(true)
    expect(Array.from(st.stance)).toEqual([0, 1, 1, 1])
    expect(st.roll).toBeGreaterThan(2 * RAD)
    expect(st.pitch).toBeLessThan(-2 * RAD)
    for (let m = 0; m < 4; m++) {
      const u = st.normal
      const d = u[0] * (st.feet[3 * m] - st.feet[3]) + u[1] * (st.feet[3 * m + 1] - st.feet[4]) + u[2] * (st.feet[3 * m + 2] - st.feet[5])
      expect(d).toBeGreaterThan(-1e-9)
    }
    for (const f of st.load) expect(f).toBeGreaterThanOrEqual(0)
    expect(sum(st.load)).toBeCloseTo(1, 9)
  })
})

describe('WalkerStatics: loads', () => {
  it('balances the moments about the CoM when the body sits off-center over its feet', () => {
    // Arrange: feet shifted 3 cm forward, so the CoM is behind their centroid
    const { st, feet } = standing(6)
    const shifted = feet.map(([x, y, z]): [number, number, number] => [x + 0.03, y, z])
    // Act
    st.update(anglesForFeet(geomOf(walkerGeometrySpec(6)), shifted))
    // Assert
    let mx = 0
    let my = 0
    for (let i = 0; i < 6; i++) {
      mx += st.load[i] * st.feet[3 * i]
      my += st.load[i] * st.feet[3 * i + 1]
    }
    expect(sum(st.load)).toBeCloseTo(1, 9)
    expect(mx).toBeCloseTo(0, 9)
    expect(my).toBeCloseTo(0, 9)
    // rear legs (mount yaw ±135°) carry more than the front ones (±45°)
    expect(st.load[2]).toBeGreaterThan(st.load[0])
    expect(st.load[3]).toBeGreaterThan(st.load[5])
  })

  it('rocks the other way when the CoM sits on the front-left side of the diagonal', () => {
    // Arrange: same trot, feet 1 cm back
    const { st, feet } = standing(4)
    const g = geomOf(walkerGeometrySpec(4))
    const trot = feet.map(([x, y, z], i): [number, number, number] => [x - 0.01, y, z + (i === 0 || i === 2 ? 0.03 : 0)])
    // Act
    st.update(anglesForFeet(g, trot))
    // Assert: left side down (roll −), nose down (pitch +)
    expect(Array.from(st.stance)).toEqual([1, 1, 0, 1])
    expect(st.roll).toBeLessThan(-2 * RAD)
    expect(st.pitch).toBeGreaterThan(2 * RAD)
  })

  it('tips the body back onto lifted feet when the CoM leaves the planted triangle', () => {
    // Arrange: feet 5 cm forward, rear three lifted; FL, ML, FR alone would leave the CoM behind them
    const { st, feet } = standing(6)
    const shifted = feet.map(([x, y, z], i): [number, number, number] => [x + 0.05, y, z + (i >= 2 && i <= 4 ? 0.03 : 0)])
    // Act
    st.update(anglesForFeet(geomOf(walkerGeometrySpec(6)), shifted))
    // Assert: nose up, a lifted rear foot now touches, and the loads balance about the CoM
    expect(st.supported).toBe(true)
    expect(st.pitch).toBeLessThan(-1 * RAD)
    expect(st.stance[2] + st.stance[3] + st.stance[4]).toBeGreaterThan(0)
    for (const f of st.load) expect(f).toBeGreaterThanOrEqual(0)
    expect(sum(st.load)).toBeCloseTo(1, 9)
  })

  it('drops a foot the minimum-norm solution would pull on and re-solves the rest', () => {
    // Arrange: one far foot at x = 10 makes the unconstrained force on it negative
    const lx = [-1, 1, 1, 1, 1, 1, 1, 10]
    const ly = [0, 0.3, -0.3, 0.6, -0.6, 0.1, -0.1, 0]
    const mask = new Uint8Array(8).fill(1)
    const out = new Float64Array(8)
    // Act
    const ok = distributeLoads(lx, ly, mask, out)
    // Assert: Σf = 1 and zero moment with the far foot unloaded
    expect(ok).toBe(true)
    expect(mask[7]).toBe(0)
    expect(out[7]).toBe(0)
    expect(out[0]).toBeCloseTo(0.5, 9)
    for (let i = 1; i < 7; i++) expect(out[i]).toBeCloseTo(1 / 12, 9)
    let mx = 0
    for (let i = 0; i < 8; i++) mx += out[i] * lx[i]
    expect(mx).toBeCloseTo(0, 9)
  })

  it('splits two feet by the lever rule and puts a lone foot at full load', () => {
    // Arrange
    const out = new Float64Array(3)
    // Act / Assert
    expect(distributeLoads([-0.1, 0.3, 0], [0, 0, 0], Uint8Array.from([1, 1, 0]), out)).toBe(true)
    expect(out[0]).toBeCloseTo(0.75, 9)
    expect(out[1]).toBeCloseTo(0.25, 9)
    expect(distributeLoads([0.2, 0, 0], [0, 0, 0], Uint8Array.from([1, 0, 0]), out)).toBe(true)
    expect(Array.from(out)).toEqual([1, 0, 0])
    expect(distributeLoads([0, 0, 0], [0, 0, 0], new Uint8Array(3), out)).toBe(false)
  })
})

describe('WalkerStatics: yaw from planted feet', () => {
  it('integrates the body yaw from the rotation of the planted feet in the body frame', () => {
    // Arrange: the body turns +2° per sample, so world-fixed feet turn −2° in the body frame
    const { st, feet } = standing(6)
    const g = geomOf(walkerGeometrySpec(6))
    // Act
    for (let k = 0; k <= 10; k++) {
      const a = -2 * k * RAD
      const c = Math.cos(a)
      const s = Math.sin(a)
      st.update(anglesForFeet(g, feet.map(([x, y, z]): [number, number, number] => [c * x - s * y, s * x + c * y, z])))
    }
    // Assert
    expect(st.yaw / RAD).toBeCloseTo(20, 6)
    // Act: re-home forgets the reference
    st.resetYaw()
    st.update(anglesForFeet(g, feet))
    // Assert
    expect(st.yaw).toBe(0)
  })
})
