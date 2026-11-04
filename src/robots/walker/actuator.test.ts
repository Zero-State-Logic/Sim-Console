import { describe, expect, it } from 'vitest'
import {
  ACTUATOR_PRESETS,
  ActuatorBank,
  PROP_BAND,
  backlash,
  complianceDeflection,
  isOverloaded,
  servoCurrent,
  torqueSpeedLimit,
  type ActuatorParams,
} from './actuator'

const DEG = Math.PI / 180
const base: ActuatorParams = { tau: 0, speed: 300 * DEG, stall: Infinity, deadband: 0, backlash: 0, kt: 0.4, idle: 0.01, volts: 6 }

function run(p: ActuatorParams, target: number, seconds: number, load = 0, dt = 0.001): ActuatorBank {
  const bank = new ActuatorBank(3)
  const t = new Float64Array([target, 0, 0])
  const l = new Float64Array([load, 0, 0])
  for (let k = 0; k < Math.round(seconds / dt); k++) bank.step(dt, t, l, p, 1)
  return bank
}

describe('ActuatorBank', () => {
  it('tracks the target exactly with the IDEAL preset', () => {
    const bank = new ActuatorBank(3)
    const t = new Float64Array([0.5, -0.3, 0.2])
    bank.step(0.016, t, null, ACTUATOR_PRESETS.ideal, 3)
    expect(Array.from(bank.out)).toEqual([0.5, -0.3, 0.2])
  })

  it('never moves faster than the speed limit', () => {
    const b = run(base, 1, 0.1)
    expect(b.out[0]).toBeCloseTo(300 * DEG * 0.1, 6)
  })

  it('responds as a first-order lag: 63 % of a small step after one time constant', () => {
    const p = { ...base, tau: 0.05, speed: Infinity }
    const b = run(p, 0.1, 0.05)
    expect(b.out[0] / 0.1).toBeCloseTo(1 - Math.exp(-1), 2)
  })

  it('ignores corrections inside the deadband and stops at its edge', () => {
    const p = { ...base, deadband: 2 * DEG }
    const b = run(p, 0.9 * DEG, 0.2)
    expect(b.out[0]).toBe(0)
    // outside the ±1° band: drives until the error is back inside it
    const c = run(p, 3 * DEG, 0.2)
    expect(Math.abs(c.out[0] - 3 * DEG)).toBeLessThanOrEqual(1 * DEG + 1e-12)
    expect(c.out[0]).toBeGreaterThan(1.5 * DEG)
  })

  it('slows down against a load following the torque-speed line', () => {
    const p = { ...base, stall: 1 }
    const b = run(p, 1, 0.1, 0.5)
    expect(b.motor[0]).toBeCloseTo(0.5 * 300 * DEG * 0.1, 6)
  })

  it('deflects under load by its proportional band: τ/τ_stall of the band, against the holding torque', () => {
    const p = { ...base, stall: 1 }
    const b = run(p, 0.2, 1, 0.5)
    expect(b.motor[0]).toBeCloseTo(0.2, 6)
    expect(b.out[0]).toBeCloseTo(0.2 - 0.5 * PROP_BAND, 9)
  })

  it('saturates past stall: no progress against the load, full deflection, no runaway', () => {
    const p = { ...base, stall: 0.2 }
    const b = run(p, 1, 0.5, 0.3)
    expect(b.motor[0]).toBe(0)
    expect(b.out[0]).toBeCloseTo(-PROP_BAND, 9)
    expect(isOverloaded(0.3, p)).toBe(true)
    expect(isOverloaded(0.1, p)).toBe(false)
  })

  it('filters the deflection with the servo time constant (no pop when a foot lands)', () => {
    const p = { ...base, stall: 1, tau: 0.05, speed: Infinity }
    const b = run(p, 0, 0.05, 0.5)
    expect(b.deflection[0] / (-0.5 * PROP_BAND)).toBeCloseTo(1 - Math.exp(-1), 2)
  })

  it('skips torque-speed, stall and compliance when no load is given (DYNAMIC mode)', () => {
    const p = { ...base, stall: 0.2, tau: 0.02 }
    const bank = new ActuatorBank(3)
    const t = new Float64Array([0.3, 0, 0])
    for (let k = 0; k < 2000; k++) bank.step(0.001, t, null, p, 1)
    expect(bank.out[0]).toBeCloseTo(0.3, 9)
    expect(bank.deflection[0]).toBe(0)
  })

  it('leaves the output shaft inside the backlash when unloaded', () => {
    const p = { ...base, backlash: 2 * DEG }
    const bank = new ActuatorBank(3)
    const t = new Float64Array([0.3, 0, 0])
    for (let k = 0; k < 2000; k++) bank.step(0.001, t, null, p, 1)
    // driven forward: the shaft trails the motor by half the play
    expect(bank.motor[0]).toBeCloseTo(0.3, 6)
    expect(bank.out[0]).toBeCloseTo(0.3 - 1 * DEG, 6)
    // reverse a little (less than the play): the shaft does not move
    t[0] = 0.3 - 1.5 * DEG
    for (let k = 0; k < 2000; k++) bank.step(0.001, t, null, p, 1)
    expect(bank.out[0]).toBeCloseTo(0.3 - 1 * DEG, 6)
  })

  it('takes up the backlash against the holding torque under load', () => {
    expect(backlash(0, 0, 0.01, 0.5, Infinity)).toBeCloseTo(-0.01, 12)
    expect(backlash(0, 0, 0.01, -0.5, Infinity)).toBeCloseTo(0.01, 12)
    // limited take-up speed
    expect(backlash(0, 0, 0.01, 0.5, 0.004)).toBeCloseTo(-0.004, 12)
  })

  it('stays inside the joint limits', () => {
    const b = run(base, 10, 2)
    expect(b.out[0]).toBeLessThanOrEqual(70 * DEG + 1e-12)
  })

  it('reports output velocity', () => {
    const b = run(base, 1, 0.05)
    expect(b.vel[0]).toBeCloseTo(300 * DEG, 6)
  })

  it('does nothing for a zero time step', () => {
    const bank = new ActuatorBank(3)
    bank.step(0, new Float64Array([1, 1, 1]), null, base, 3)
    expect(Array.from(bank.out)).toEqual([0, 0, 0])
  })
})

describe('torqueSpeedLimit', () => {
  it('passes velocities that move with the load unchanged up to no-load speed', () => {
    const p = { ...base, stall: 1 }
    expect(torqueSpeedLimit(-1, 0.5, p)).toBe(-1)
    expect(torqueSpeedLimit(1, -0.5, p)).toBe(1)
  })

  it('caps the speed against the load and floors it at zero past stall', () => {
    const p = { ...base, stall: 1 }
    expect(torqueSpeedLimit(10, 0.25, p)).toBeCloseTo(0.75 * 300 * DEG, 12)
    expect(torqueSpeedLimit(-10, -0.25, p)).toBeCloseTo(-0.75 * 300 * DEG, 12)
    expect(torqueSpeedLimit(10, 1.5, p)).toBe(0)
  })
})

describe('complianceDeflection', () => {
  it('is zero for an ideal servo and saturates at the band', () => {
    expect(complianceDeflection(5, Infinity)).toBe(0)
    expect(complianceDeflection(0.5, 1)).toBeCloseTo(-0.5 * PROP_BAND, 12)
    expect(complianceDeflection(-3, 1)).toBeCloseTo(PROP_BAND, 12)
  })
})

describe('servoCurrent', () => {
  it('adds idle current to torque over the torque constant', () => {
    expect(servoCurrent(0.4, base)).toBeCloseTo(0.01 + 1, 12)
    expect(servoCurrent(-0.4, base)).toBeCloseTo(0.01 + 1, 12)
  })

  it('draws the stall current at stall torque for the MG996R preset', () => {
    const p = ACTUATOR_PRESETS.mg996r
    expect(servoCurrent(p.stall, p) - p.idle).toBeCloseTo(2.5, 9)
  })
})
