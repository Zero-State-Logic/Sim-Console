import { describe, expect, it } from 'vitest'
import { rigidBodyDerivative, rk4Step, eulerStep, stepMotors, STATE_LEN, thrustToOmega } from './dynamics'
import { QUAD_250, hoverOmega } from './params'
import { eulerToQuat } from './quat'

const p = QUAD_250
const noWind = new Float64Array(3)

function hoverState(): Float64Array {
  const s = new Float64Array(STATE_LEN)
  s[2] = 2
  s[6] = 1
  return s
}

describe('rigid-body dynamics', () => {
  it('is in equilibrium at hover: total thrust m·g gives zero acceleration', () => {
    // Arrange
    const s = hoverState()
    const wrench = new Float64Array([p.mass * p.g, 0, 0, 0])
    const d = new Float64Array(STATE_LEN)
    // Act
    rigidBodyDerivative(d, s, wrench, noWind, p)
    // Assert
    for (let i = 3; i < STATE_LEN; i++) expect(Math.abs(d[i])).toBeLessThan(1e-12)
  })

  it('makes hover rotor speed produce exactly the weight', () => {
    const w = hoverOmega(p)
    expect(4 * p.kT * w * w).toBeCloseTo(p.mass * p.g, 10)
    expect(w).toBeLessThan(p.omegaMax)
    // max thrust is about 2x hover per motor
    expect((p.kT * p.omegaMax ** 2) / (p.kT * w * w)).toBeCloseTo(2, 6)
  })

  it('falls at g with motors off and no air', () => {
    const s = hoverState()
    const d = new Float64Array(STATE_LEN)
    rigidBodyDerivative(d, s, new Float64Array(4), noWind, p)
    expect(d[5]).toBeCloseTo(-p.g, 12)
  })

  it('drag opposes the air-relative velocity (wind pushes a hovering drone downwind)', () => {
    const s = hoverState()
    const wind = new Float64Array([3, 0, 0])
    const d = new Float64Array(STATE_LEN)
    rigidBodyDerivative(d, s, new Float64Array([p.mass * p.g, 0, 0, 0]), wind, p)
    const expected = ((p.dragLin + p.dragQuad * 3) * 3) / p.mass
    expect(d[3]).toBeCloseTo(expected, 10)
  })

  it('keeps the quaternion unit-norm over a long tumbling integration', () => {
    // Arrange: an asymmetric tumble with no torque
    const s = hoverState()
    s[10] = 3
    s[11] = -1.5
    s[12] = 4
    const wrench = new Float64Array([p.mass * p.g, 0, 0, 0])
    // Act: 60 s at 1 kHz
    for (let i = 0; i < 60000; i++) rk4Step(s, 1e-3, wrench, noWind, p)
    // Assert
    expect(Math.abs(Math.hypot(s[6], s[7], s[8], s[9]) - 1)).toBeLessThan(1e-12)
  })

  it('conserves rotational kinetic energy and angular momentum torque-free (RK4 accuracy)', () => {
    const P0 = { ...p, dragRot: 0, kFlap: 0, dragLin: 0, dragQuad: 0 }
    const s = hoverState()
    s[10] = 2
    s[11] = 0.5
    s[12] = -1
    const J = [P0.Ixx, P0.Iyy, P0.Izz]
    const energy = () => 0.5 * (J[0] * s[10] ** 2 + J[1] * s[11] ** 2 + J[2] * s[12] ** 2)
    const momentum = () => Math.hypot(J[0] * s[10], J[1] * s[11], J[2] * s[12])
    const e0 = energy()
    const l0 = momentum()
    for (let i = 0; i < 10000; i++) rk4Step(s, 1e-3, new Float64Array([P0.mass * P0.g, 0, 0, 0]), noWind, P0)
    expect(Math.abs(energy() - e0) / e0).toBeLessThan(1e-8)
    expect(Math.abs(momentum() - l0) / l0).toBeLessThan(1e-8)
  })

  it('converges at 4th order (RK4) and 1st order (semi-implicit Euler) on a powered, tumbling flight in wind', () => {
    // Arrange: thrust, torques, body rates, wind and both drag terms all active
    const wrench = new Float64Array([4, 0.01, -0.005, 0.002])
    const wind = new Float64Array([2, -1, 0])
    const solve = (step: typeof rk4Step, h: number): Float64Array => {
      const s = hoverState()
      s[2] = 50
      s[3] = 3
      s[10] = 2
      s[11] = -1
      s[12] = 3
      for (let i = 0; i < Math.round(2 / h); i++) step(s, h, wrench, wind, p)
      return s
    }
    const ref = solve(rk4Step, 1e-4)
    const err = (s: Float64Array): number => Math.hypot(...Array.from(s, (v, i) => v - ref[i]))
    // Act: global error over 2 s at three step sizes each
    const rk = [8e-3, 4e-3, 2e-3].map((h) => err(solve(rk4Step, h)))
    const eu = [4e-3, 2e-3, 1e-3].map((h) => err(solve(eulerStep, h)))
    // Assert: halving h divides the error by 2^order
    expect(rk[0] / rk[1]).toBeCloseTo(16, 0)
    expect(rk[1] / rk[2]).toBeCloseTo(16, 0)
    expect(eu[0] / eu[1]).toBeCloseTo(2, 1)
    expect(eu[1] / eu[2]).toBeCloseTo(2, 1)
    // at the default 1 kHz substep RK4 is far below anything visible (< 1 µm over 2 s)
    expect(err(solve(rk4Step, 1e-3))).toBeLessThan(1e-6)
  })

  it('semi-implicit Euler integrates drag-free free fall to first order', () => {
    // Arrange
    const vacuum = { ...p, dragLin: 0, dragQuad: 0 }
    const s = hoverState()
    s[2] = 100
    // Act: 1 s at 1 kHz
    for (let i = 0; i < 1000; i++) eulerStep(s, 1e-3, new Float64Array(4), noWind, vacuum)
    // Assert: velocity is exact for constant acceleration, position is O(h)
    expect(s[5]).toBeCloseTo(-p.g, 9)
    expect(s[2]).toBeCloseTo(100 - 0.5 * p.g, 1)
    expect(Math.abs(Math.hypot(s[6], s[7], s[8], s[9]) - 1)).toBeLessThan(1e-12)
  })

  it('reaches a realistic terminal velocity with drag', () => {
    const s = hoverState()
    s[2] = 1000
    for (let i = 0; i < 20000; i++) rk4Step(s, 1e-3, new Float64Array(4), noWind, p)
    // 0.12·v + 0.03·v² = m·g  ->  v ≈ 12.1 m/s
    const vt = (-p.dragLin + Math.sqrt(p.dragLin ** 2 + 4 * p.dragQuad * p.mass * p.g)) / (2 * p.dragQuad)
    expect(-s[5]).toBeCloseTo(vt, 3)
  })

  it('blade flapping tilts a hovering drone downwind', () => {
    const s = hoverState()
    const d = new Float64Array(STATE_LEN)
    rigidBodyDerivative(d, s, new Float64Array([p.mass * p.g, 0, 0, 0]), new Float64Array([3, 0, 0]), p)
    // +y rotation (REP-103) is nose-down toward +x, the downwind side
    expect(d[11]).toBeGreaterThan(0)
    expect(d[10]).toBeCloseTo(0, 12)
  })

  it('a pure roll torque spins the body about x only', () => {
    const s = hoverState()
    eulerToQuat(s, 6, 0, 0, 0)
    const d = new Float64Array(STATE_LEN)
    rigidBodyDerivative(d, s, new Float64Array([p.mass * p.g, 0.01, 0, 0]), noWind, p)
    expect(d[10]).toBeCloseTo(0.01 / p.Ixx, 10)
    expect(d[11]).toBe(0)
    expect(d[12]).toBe(0)
  })
})

describe('motor model', () => {
  it('follows a first-order lag: 63% of a step after one time constant', () => {
    const w = new Float64Array(4)
    const cmd = new Float64Array(4).fill(1000)
    const th = new Float64Array(4)
    const h = 1e-3
    const steps = Math.round(p.motorTau / h)
    for (let i = 0; i < steps; i++) stepMotors(w, cmd, th, h, p)
    expect(w[0] / 1000).toBeCloseTo(1 - Math.exp(-1), 3)
    expect(th[0]).toBeCloseTo(p.kT * w[0] * w[0], 12)
  })

  it('clamps commanded speed to the motor range', () => {
    expect(thrustToOmega(-1, p)).toBe(0)
    expect(thrustToOmega(1e6, p)).toBe(p.omegaMax)
    const t = 1.2
    expect(p.kT * thrustToOmega(t, p) ** 2).toBeCloseTo(t, 9)
  })
})
