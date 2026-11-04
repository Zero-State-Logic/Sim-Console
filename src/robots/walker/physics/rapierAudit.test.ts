import { beforeAll, describe, expect, it } from 'vitest'
import type { Collider } from '@dimforge/rapier3d-compat'
import { WalkerSim } from '../sim'
import { ACTUATOR_PRESETS, type ActuatorParams } from '../actuator'
import { EvalState, GRAVITY, computeCom, computeFeet, computeLoads, computeSupport, computeTorques, totalMass } from '../simState'
import { rpyFromRotation } from '../pose'
import type { LegCount } from '../geometry'
import { loadRapier, type Rapier } from './loader'
import { RapierWalker } from './rapierWalker'
import { DynamicMode } from './dynamicMode'

/* ============================================================
   PHYSICS AUDIT (DYNAMIC) — the Rapier walker against analytic
   statics and basic mechanics, stepped headless in Node.
   ============================================================ */

const DEG = Math.PI / 180
const DT = 1 / 60
let R: Rapier

beforeAll(async () => {
  R = await loadRapier()
})

/** Test-only view of the private world (to zero the friction). */
interface WorldView {
  world: { gravity: { x: number; y: number; z: number }; forEachCollider(f: (c: Collider) => void): void }
}

function spawn(sim: WalkerSim, actuator: ActuatorParams): RapierWalker {
  return new RapierWalker(R, sim.layout, sim.mass, { pos: sim.state.bodyPos, R: sim.state.bodyR, q: sim.state.q }, actuator)
}

/** Analytic statics (vertical loads, Jᵀ·F torques) on the pose and contacts the physics produced. */
function staticsOf(sim: WalkerSim, phys: EvalState): EvalState {
  const st = new EvalState()
  st.bodyPos.set(phys.bodyPos)
  st.bodyR.set(phys.bodyR)
  st.q.set(phys.q)
  st.contact.set(phys.contact)
  computeFeet(st, sim.layout)
  computeCom(st, sim.layout, sim.mass)
  computeSupport(st, sim.layout)
  computeLoads(st, sim.layout, sim.mass)
  computeTorques(st, sim.layout, sim.mass)
  return st
}

describe('Rapier walker mechanics', () => {
  it('runs at g = 9.81 m/s² down −z and carries exactly its weight on its feet', () => {
    const sim = new WalkerSim(6)
    const w = spawn(sim, ACTUATOR_PRESETS.mg996r)
    const out = new EvalState()
    for (let k = 0; k < 120; k++) {
      w.step(DT)
      w.read(out)
    }
    const g = (w as unknown as WorldView).world.gravity
    expect([g.x, g.y, g.z]).toEqual([0, 0, -GRAVITY])
    expect(w.totalMass()).toBeCloseTo(1.8, 9)
    let sum = 0
    for (let i = 0; i < 6; i++) sum += out.load[i]
    expect(sum).toBeCloseTo(totalMass(sim.mass, 6) * GRAVITY, 2)
    w.dispose()
  })

  it('stands a symmetric hexapod on six equal loads (no solver bias between legs)', () => {
    const sim = new WalkerSim(6)
    const w = spawn(sim, ACTUATOR_PRESETS.mg996r)
    const out = new EvalState()
    for (let k = 0; k < 120; k++) {
      w.step(DT)
      w.read(out)
    }
    const share = sim.weight / 6
    for (let i = 0; i < 6; i++) {
      expect(Math.abs(out.load[i] / share - 1), `leg ${i}`).toBeLessThan(0.03)
      expect(Math.abs(out.torque[i * 3 + 1] - out.torque[1]), `femur ${i}`).toBeLessThan(0.01)
    }
    w.dispose()
  })

  it('matches the analytic statics on a frictionless tripod: loads within 1 %, joint torques within a few %', () => {
    // Arrange: legs 2, 4, 6 lifted; with no friction every foot force is vertical and
    // three feet make the loads statically determinate, so both models must agree
    for (const preset of [ACTUATOR_PRESETS.mg996r, ACTUATOR_PRESETS.ds3218]) {
      const sim = new WalkerSim(6)
      const w = spawn(sim, preset)
      ;(w as unknown as WorldView).world.forEachCollider((c) => c.setFriction(0))
      const targets = sim.state.q.slice()
      for (const i of [1, 3, 5]) targets[i * 3 + 1] += 30 * DEG
      const out = new EvalState()
      // Act
      for (let k = 0; k < 180; k++) {
        w.setTargets(targets)
        w.step(DT)
        w.read(out)
      }
      // Assert
      const st = staticsOf(sim, out)
      expect(Array.from(out.contact.slice(0, 6))).toEqual([1, 0, 1, 0, 1, 0])
      for (const i of [0, 2, 4]) {
        expect(Math.abs(out.load[i] / st.load[i] - 1), `load ${i}`).toBeLessThan(0.01)
        // measured: tibia within 1 % (ball-foot lever in both models), femur 0–6 % (solver residual)
        expect(Math.abs(out.torque[i * 3 + 1] / st.torque[i * 3 + 1] - 1), `femur ${i}`).toBeLessThan(0.08)
        expect(Math.abs(out.torque[i * 3 + 2] / st.torque[i * 3 + 2] - 1), `tibia ${i}`).toBeLessThan(0.05)
      }
      w.dispose()
    }
  })

  it('falls onto its side when one side of the legs is lifted (CoM leaves the support)', () => {
    const sim = new WalkerSim(6)
    const w = spawn(sim, ACTUATOR_PRESETS.ds3218)
    const targets = sim.state.q.slice()
    for (const i of [0, 1, 2]) targets[i * 3 + 1] += 60 * DEG
    const out = new EvalState()
    const rpy = new Float64Array(3)
    for (let k = 0; k < 90; k++) {
      w.setTargets(targets)
      w.step(DT)
      w.read(out)
    }
    rpyFromRotation(out.bodyR, rpy)
    // right side (−y) goes down: positive roll about +x (it lifts +y), body resting on its edge
    expect(rpy[0]).toBeGreaterThan(8 * DEG)
    expect(out.bodyPos[2]).toBeLessThan(sim.pose.height - 0.02)
    w.dispose()
  })
})

describe('DYNAMIC walking stays physical', () => {
  async function walk(n: LegCount, gait: string, id: keyof typeof ACTUATOR_PRESETS, frac: { vx: number; vy: number; wz: number }, fps = 60, seconds = 5): Promise<{ dx: number; zMax: number; minUp: number; overloadSeen: boolean }> {
    const sim = new WalkerSim(n)
    sim.actuator = { ...ACTUATOR_PRESETS[id] }
    sim.setGait(gait as never)
    const d = new DynamicMode(() => {})
    await d.enable(sim)
    const cmd = { vx: frac.vx * sim.engine.maxSpeed(sim.params), vy: frac.vy * sim.engine.maxSpeed(sim.params), wz: frac.wz * sim.engine.maxYawRate(sim.params) }
    const x0 = sim.state.bodyPos[0]
    let zMax = 0
    let minUp = 1
    let overloadSeen = false
    for (let k = 0; k < Math.round(seconds * fps); k++) {
      sim.plan(1 / fps, cmd, false)
      d.step(1 / fps, sim, sim.actuators.out)
      zMax = Math.max(zMax, sim.state.bodyPos[2])
      minUp = Math.min(minUp, sim.state.bodyR[8])
      if (sim.state.overload >= 0) overloadSeen = true
    }
    const dx = sim.state.bodyPos[0] - x0
    d.dispose()
    return { dx, zMax, minUp, overloadSeen }
  }

  it('crawls on four legs without tipping or being launched (it used to flip and fly ~1 m)', async () => {
    for (const id of ['mg996r', 'ideal'] as const) {
      for (const frac of [{ vx: 0.8, vy: 0, wz: 0 }, { vx: 0.3, vy: 0.4, wz: 0.4 }]) {
        const r = await walk(4, 'crawl', id, frac)
        const tag = `${id} ${JSON.stringify(frac)}`
        expect(r.minUp, tag).toBeGreaterThan(0.97)
        expect(r.zMax, tag).toBeLessThan(0.11)
      }
    }
    const fwd = await walk(4, 'crawl', 'mg996r', { vx: 0.8, vy: 0, wz: 0 })
    expect(fwd.dx).toBeGreaterThan(0.05)
  })

  it('walks the same distance at 30, 60 and 144 fps (fixed 1/240 s substeps)', async () => {
    const d = await Promise.all([30, 60, 144].map((fps) => walk(6, 'tripod', 'mg996r', { vx: 0.8, vy: 0, wz: 0 }, fps, 4)))
    expect(d[1].dx).toBeGreaterThan(0.2)
    for (const r of d) expect(Math.abs(r.dx / d[1].dx - 1)).toBeLessThan(0.04)
  })

  it('reports OVERLOAD when the motors saturate (SG90s cannot hold a 1.8 kg hexapod)', async () => {
    const weak = await walk(6, 'tripod', 'sg90', { vx: 0.6, vy: 0, wz: 0 }, 60, 2)
    const strong = await walk(6, 'tripod', 'ds3218', { vx: 0.6, vy: 0, wz: 0 }, 60, 2)
    expect(weak.overloadSeen).toBe(true)
    expect(strong.overloadSeen).toBe(false)
  })
})
