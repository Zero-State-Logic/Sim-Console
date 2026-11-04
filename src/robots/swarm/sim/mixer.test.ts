import { describe, expect, it } from 'vitest'
import { mix, mixerGeom, SAT_RP, SAT_THRUST, SAT_YAW, SPIN, SZ, unmix } from './mixer'
import { QUAD_250, maxMotorThrust } from './params'
import { Rng } from './rng'

const geom = mixerGeom(QUAD_250)
const W = 0.6 * 9.81

describe('X-frame mixer', () => {
  it('inverts exactly for feasible wrenches (forward ∘ inverse = identity)', () => {
    // Arrange
    const rng = new Rng(7)
    const th = new Float64Array(4)
    const back = new Float64Array(4)
    for (let k = 0; k < 200; k++) {
      const T = W * (0.8 + 0.4 * rng.next())
      const tx = (rng.next() - 0.5) * 0.1
      const ty = (rng.next() - 0.5) * 0.1
      const tz = (rng.next() - 0.5) * 0.01
      // Act
      const flags = mix(th, T, tx, ty, tz, geom)
      unmix(back, th, geom)
      // Assert
      expect(flags).toBe(0)
      expect(back[0]).toBeCloseTo(T, 9)
      expect(back[1]).toBeCloseTo(tx, 9)
      expect(back[2]).toBeCloseTo(ty, 9)
      expect(back[3]).toBeCloseTo(tz, 9)
    }
  })

  it('splits pure collective thrust equally across the four motors', () => {
    const th = new Float64Array(4)
    mix(th, W, 0, 0, 0, geom)
    for (const t of th) expect(t).toBeCloseTo(W / 4, 12)
  })

  it('produces positive roll torque by loading the left motors (FL, RL)', () => {
    const th = new Float64Array(4)
    mix(th, W, 0.05, 0, 0, geom)
    expect(th[0]).toBeGreaterThan(th[1])
    expect(th[3]).toBeGreaterThan(th[2])
  })

  it('reacts a CCW (+z) yaw torque to the CW props, as on a PX4 quad-X (FL and RR spin CW)', () => {
    // Arrange: speed up only the CW pair by 0.1 N each
    const th = new Float64Array([W / 4 + 0.1, W / 4, W / 4 + 0.1, W / 4])
    const out = new Float64Array(4)
    // Act
    unmix(out, th, geom)
    // Assert: drag torque on a CW rotor is CCW on the airframe, τz = κ·0.2 N, no roll or pitch
    expect(SPIN[0]).toBe(-1)
    expect(SPIN[2]).toBe(-1)
    expect(out[3]).toBeCloseTo((QUAD_250.kQ / QUAD_250.kT) * 0.2, 12)
    expect(out[1]).toBeCloseTo(0, 12)
    expect(out[2]).toBeCloseTo(0, 12)
    for (let i = 0; i < 4; i++) expect(SZ[i]).toBe(-SPIN[i])
  })

  it('puts the hover point at half the motor range: thrust-to-weight 2:1, rotor speed 1/√2 of maximum', () => {
    const th = new Float64Array(4)
    mix(th, W, 0, 0, 0, geom)
    expect(th[0] / maxMotorThrust(QUAD_250)).toBeCloseTo(0.5, 12)
    expect(Math.sqrt(th[0] / QUAD_250.kT) / QUAD_250.omegaMax).toBeCloseTo(Math.SQRT1_2, 12)
  })

  it('drops yaw first when roll and yaw both ask for more than the motors have', () => {
    // Arrange: a large roll demand near full collective plus a huge yaw demand
    const th = new Float64Array(4)
    const back = new Float64Array(4)
    const tx = 0.12
    // Act
    const flags = mix(th, 2.0 * W, tx, 0, 0.5, geom)
    unmix(back, th, geom)
    // Assert: roll survives untouched, yaw is reduced, motors stay in range
    expect(flags & SAT_YAW).toBe(SAT_YAW)
    expect(back[1]).toBeCloseTo(tx, 9)
    expect(back[3]).toBeLessThan(0.5)
    for (const t of th) {
      expect(t).toBeGreaterThanOrEqual(geom.tMin - 1e-12)
      expect(t).toBeLessThanOrEqual(geom.tMax + 1e-12)
    }
  })

  it('sacrifices collective thrust before roll/pitch at the top of the range', () => {
    const th = new Float64Array(4)
    const back = new Float64Array(4)
    const flags = mix(th, 4 * maxMotorThrust(QUAD_250), 0.08, 0, 0, geom)
    unmix(back, th, geom)
    expect(flags & SAT_THRUST).toBe(SAT_THRUST)
    expect(flags & SAT_RP).toBe(0)
    expect(back[1]).toBeCloseTo(0.08, 9)
    expect(back[0]).toBeLessThan(4 * maxMotorThrust(QUAD_250))
  })

  it('scales roll/pitch down only when they alone exceed the motor span', () => {
    const th = new Float64Array(4)
    const flags = mix(th, W, 10, 10, 0, geom)
    expect(flags & SAT_RP).toBe(SAT_RP)
    for (const t of th) {
      expect(t).toBeGreaterThanOrEqual(geom.tMin - 1e-12)
      expect(t).toBeLessThanOrEqual(geom.tMax + 1e-12)
    }
  })
})
