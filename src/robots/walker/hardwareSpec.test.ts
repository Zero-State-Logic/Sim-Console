import { describe, expect, it } from 'vitest'
import { WalkerSim } from './sim'
import { highCommand, jointCommand, loadToNewtons, validAngles, validImu, walkerHardwareSpec, walkerTelemetryTable } from './hardwareSpec'
import { JOINT_LIMITS_DEG, legFK, legToBody } from './kinematics'

describe('walkerHardwareSpec', () => {
  it('gives 3 joints per leg with limits, a home pose and REP-103 geometry for 4, 6 and 8 legs', () => {
    for (const n of [4, 6, 8] as const) {
      const sim = new WalkerSim(n)
      const spec = walkerHardwareSpec(sim)
      expect(spec.joints).toBe(n * 3)
      expect(spec.jointNames).toHaveLength(n * 3)
      expect(spec.jointLimits).toHaveLength(n * 3)
      expect(spec.homePose).toHaveLength(n * 3)
      const g = spec.geometry ?? {}
      expect(Object.keys(g).sort()).toEqual(['coxa', 'femur', 'footReach', 'mountX', 'mountY', 'mountYawDeg', 'standHeight', 'tibia'])
      expect(g.mountX).toHaveLength(n)
      // REP-103: the first leg is front-right (x > 0, y < 0)
      expect((g.mountX as number[])[0]).toBeGreaterThan(0)
      expect((g.mountY as number[])[0]).toBeLessThan(0)
      expect((g.mountYawDeg as number[])[0]).toBeLessThan(0)
    }
  })

  it('has a home pose whose FK stands every foot on the ground at the stand height', () => {
    const sim = new WalkerSim(6)
    const spec = walkerHardwareSpec(sim)
    const L = sim.layout
    const q = new Float64Array(spec.homePose.map((d) => (d * Math.PI) / 180))
    const p = new Float64Array(3)
    const b = new Float64Array(3)
    for (let i = 0; i < 6; i++) {
      legFK(L.dims, q, i * 3, p, 0)
      legToBody(L.mountX[i], L.mountY[i], L.mountYaw[i], p[0], p[1], p[2], b, 0)
      // home angles are rounded to 0.1°: ~0.2 mm at the foot
      expect(b[2]).toBeCloseTo(-(spec.geometry?.standHeight as number), 3)
    }
  })
})

describe('commands', () => {
  it('streams the commanded joint targets in degrees, clamped to the limits', () => {
    const sim = new WalkerSim(6)
    sim.qTarget[2] = -5
    const cmd = jointCommand(sim)
    expect(cmd.t).toBe('cmd')
    expect(cmd.q).toHaveLength(18)
    expect(cmd.q?.[2]).toBe(JOINT_LIMITS_DEG[2][0])
    expect(cmd.q?.[1]).toBeCloseTo((sim.qTarget[1] * 180) / Math.PI, 1)
  })

  it('sends the twist, gait and body height at the high level', () => {
    const sim = new WalkerSim(8)
    sim.engine.cmd.set([0.05, -0.01, 0.2])
    const cmd = highCommand(sim)
    expect(cmd.v).toEqual([0.05, -0.01, 0.2])
    expect(cmd.mode).toBe('tetrapod')
    expect(cmd.h).toBe(0.085)
  })
})

describe('telemetry parsing', () => {
  it('reads 0..1 loads as a fraction of the weight and larger values as newtons', () => {
    const out = new Float64Array(3)
    loadToNewtons([0.5, 0.25, 0], 20, out, 3)
    expect(Array.from(out)).toEqual([10, 5, 0])
    loadToNewtons([4, 3, -1], 20, out, 3)
    expect(Array.from(out)).toEqual([4, 3, 0])
  })

  it('validates joint-angle and IMU arrays off the wire', () => {
    expect(validAngles([1, 2, 3], 3)).toBe(true)
    expect(validAngles([1, 2], 3)).toBe(false)
    expect(validAngles([1, Number.NaN, 3], 3)).toBe(false)
    expect(validAngles('1,2,3', 3)).toBe(false)
    expect(validImu([1, 2, 3])).toBe(true)
    expect(validImu([1, 2, Infinity])).toBe(false)
  })

  it('tabulates measured angles and loads per leg, or the sim values without telemetry', () => {
    const sim = new WalkerSim(4)
    const ang = Array.from({ length: 12 }, (_, j) => j)
    const t = walkerTelemetryTable(sim, { t: 'tel', ang, load: [0.5, 0.5, 0, 0] })
    expect(t.rows).toHaveLength(4)
    expect(t.rows[1].cells.slice(0, 3)).toEqual([3, 4, 5])
    expect(t.rows[0].cells[4]).toBe('DOWN')
    expect(t.rows[2].cells[4]).toBe('AIR')
    const s = walkerTelemetryTable(sim, null)
    expect(s.rows[0].cells[4]).toBe('DOWN')
    expect(s.rows[0].cells[3]).toBeCloseTo(sim.state.load[0], 2)
  })
})
