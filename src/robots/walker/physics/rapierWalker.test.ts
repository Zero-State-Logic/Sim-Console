import { beforeAll, describe, expect, it } from 'vitest'
import { WalkerSim } from '../sim'
import { ACTUATOR_PRESETS } from '../actuator'
import { EvalState, GRAVITY, totalMass } from '../simState'
import { loadRapier, type Rapier } from './loader'
import { RapierWalker } from './rapierWalker'
import { axisQuat, quatMul, rotateByQuat } from './quat'

let R: Rapier

beforeAll(async () => {
  R = await loadRapier()
})

function spawn(sim: WalkerSim, actuator = ACTUATOR_PRESETS.mg996r): RapierWalker {
  return new RapierWalker(R, sim.layout, sim.mass, { pos: sim.state.bodyPos, R: sim.state.bodyR, q: sim.state.q }, actuator)
}

function settle(w: RapierWalker, seconds: number, out: EvalState): void {
  for (let k = 0; k < Math.round(seconds * 60); k++) {
    w.step(1 / 60)
    w.read(out)
  }
}

describe('RapierWalker', () => {
  it('reads back the spawn joint angles exactly (our joint convention = Rapier hinge angle)', () => {
    const sim = new WalkerSim(6)
    const w = spawn(sim)
    const out = new EvalState()
    w.read(out)
    for (let j = 0; j < 18; j++) expect(out.q[j]).toBeCloseTo(sim.state.q[j], 5)
    w.dispose()
  })

  it('stands up on its own legs with MG996R servos and carries its weight', () => {
    const sim = new WalkerSim(6)
    const w = spawn(sim)
    const out = new EvalState()
    settle(w, 2, out)
    expect(w.tipped).toBe(false)
    // compliant servos sag a little under 1.8 kg, they don't collapse
    expect(out.bodyPos[2]).toBeGreaterThan(sim.pose.height - 0.03)
    expect(out.bodyPos[2]).toBeLessThan(sim.pose.height + 0.01)
    let sum = 0
    for (let i = 0; i < 6; i++) sum += out.load[i]
    expect(sum).toBeCloseTo(totalMass(sim.mass, 6) * GRAVITY, -1)
    expect(out.contact.slice(0, 6).every((c) => c === 1)).toBe(true)
    // femur servos push down to hold the body up
    expect(out.torque[1]).toBeLessThan(0)
    w.dispose()
  })

  it('saturates SG90 motors far more often and sags lower than DS3218 on the same tripod walk', () => {
    const walkHeight = (preset: typeof ACTUATOR_PRESETS.sg90): { z: number; saturated: number } => {
      const sim = new WalkerSim(6)
      sim.actuator = { ...preset }
      const w = spawn(sim, sim.actuator)
      const out = new EvalState()
      settle(w, 0.5, out)
      let saturated = 0
      let z = 0
      for (let k = 0; k < 180; k++) {
        sim.plan(1 / 60, { vx: 0.06, vy: 0, wz: 0 }, false)
        w.setTargets(sim.actuators.out)
        w.step(1 / 60)
        w.read(out)
        z += out.bodyPos[2] / 180
        for (let j = 0; j < 18; j++) if (Math.abs(out.torque[j]) >= preset.stall - 1e-6) saturated++
      }
      w.dispose()
      return { z, saturated }
    }
    const weak = walkHeight(ACTUATOR_PRESETS.sg90)
    const strong = walkHeight(ACTUATOR_PRESETS.ds3218)
    expect(weak.saturated).toBeGreaterThan(0)
    expect(strong.saturated).toBeLessThan(weak.saturated / 4)
    expect(weak.z).toBeLessThan(strong.z - 0.004)
  })

  it('walks forward when fed the tripod gait targets', () => {
    const sim = new WalkerSim(6)
    sim.actuator = { ...ACTUATOR_PRESETS.ds3218 }
    const w = spawn(sim, sim.actuator)
    const out = new EvalState()
    settle(w, 0.5, out)
    const x0 = out.bodyPos[0]
    for (let k = 0; k < 240; k++) {
      sim.plan(1 / 60, { vx: 0.08, vy: 0, wz: 0 }, false)
      w.setTargets(sim.actuators.out)
      w.step(1 / 60)
      w.read(out)
    }
    expect(w.tipped).toBe(false)
    expect(out.bodyPos[0] - x0).toBeGreaterThan(0.08)
    w.dispose()
  })

  it('accumulates substeps at a fixed 1/240 s', () => {
    const sim = new WalkerSim(4)
    const w = spawn(sim)
    expect(w.step(1 / 60)).toBe(4)
    expect(w.step(1 / 480)).toBe(0)
    expect(w.step(1 / 480)).toBe(1)
    // a long stall is capped
    expect(w.step(1)).toBe(12)
    w.dispose()
  })
})

describe('quat helpers', () => {
  it('rotates a vector by a composed rotation', () => {
    const q = quatMul(axisQuat([0, 0, 1], Math.PI / 2), axisQuat([1, 0, 0], Math.PI / 2))
    const v = rotateByQuat(q, [0, 1, 0])
    // x-rotation sends y → z; z-rotation leaves z
    expect(v[0]).toBeCloseTo(0, 12)
    expect(v[1]).toBeCloseTo(0, 12)
    expect(v[2]).toBeCloseTo(1, 12)
  })
})
