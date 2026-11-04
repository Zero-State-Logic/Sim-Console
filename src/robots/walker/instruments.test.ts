import { describe, expect, it } from 'vitest'
import { ACTUATOR_PRESETS } from './actuator'
import { TelemetryWriter, buildInstrumentLayout, footLeg, ikText, overloadText, torqueChartMax } from './instruments'
import { IK_JOINT_LIMIT, IK_OUT_OF_REACH } from './kinematics'
import { WalkerSim } from './sim'

const extras = { t: 1, speed: 0.05, driveUtil: 0.5, physics: 'KINEMATIC' }

describe('buildInstrumentLayout', () => {
  it('has the DRIVE and STABILITY gauges, torque and foot charts, leg-load bars at twice a share', () => {
    const l = buildInstrumentLayout({ n: 6, gaitLabel: 'TRIPOD', stall: 1, weight: 18 })
    expect(l.subtitle).toBe('HEX · TRIPOD')
    expect(l.gauges.map((g) => g.key)).toEqual(['drive', 'stability'])
    expect(l.charts.map((c) => c.key)).toEqual(['torque', 'foot'])
    expect(l.charts[0].max).toBe(1.4)
    expect(l.bars?.max).toBe(6)
    expect(l.bars?.colors?.[7 % 6]).toBe('var(--l2)')
    expect(l.readouts.map((r) => r.key)).toEqual(['margin', 'comH', 'speed', 'current', 'power', 'stance', 'servo', 'ik', 'physics', 'pose'])
  })

  it('plots front-right, the next right leg and front-left on the foot chart', () => {
    expect([0, 1, 2].map((i) => footLeg(6, i))).toEqual([0, 1, 3])
    expect([0, 1, 2].map((i) => footLeg(4, i))).toEqual([0, 1, 2])
    expect(torqueChartMax(Infinity)).toBe(1)
    expect(torqueChartMax(0.18)).toBe(0.25)
  })
})

describe('TelemetryWriter', () => {
  it('writes into one reused frame', () => {
    const sim = new WalkerSim(6)
    const w = new TelemetryWriter(6)
    const a = w.write(sim, extras)
    const b = w.write(sim, extras)
    expect(a).toBe(b)
    expect(a.bars).toHaveLength(6)
    expect(a.gauges.drive).toBe(50)
    expect(a.gauges.stability).toBeCloseTo(100, 6)
    expect(a.readouts.margin).toBeCloseTo(sim.marginRef * 1000, 6)
    expect(a.readouts.stance).toBe(6)
    w.resize(4)
    expect(w.frame.bars).toHaveLength(4)
  })

  it('shows a dash for the margin without support and names the clamped leg', () => {
    const sim = new WalkerSim(6)
    sim.state.hullCount = 0
    sim.state.margin = -Infinity
    sim.ikStatus[2] = IK_OUT_OF_REACH
    const f = new TelemetryWriter(6).write(sim, extras)
    expect(f.readouts.margin).toBe('—')
    expect(f.gauges.stability).toBe(0)
    expect(ikText(sim)).toBe('OUT OF REACH L3')
    sim.ikStatus[2] = IK_JOINT_LIMIT
    expect(ikText(sim)).toBe('JOINT LIMIT L3')
  })

  it('formats the overload warning with the joint, torque and stall', () => {
    const sim = new WalkerSim(6)
    sim.actuator = { ...ACTUATOR_PRESETS.sg90 }
    sim.state.overload = 4
    sim.state.maxTorque = 0.27
    expect(overloadText(sim)).toBe('OVERLOAD L2 FEMUR 0.27/0.18 Nm')
    sim.state.overload = -1
    expect(overloadText(sim)).toBe('OK')
  })
})
