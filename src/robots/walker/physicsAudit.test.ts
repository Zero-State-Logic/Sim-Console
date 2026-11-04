import { describe, expect, it } from 'vitest'
import { FOOT_RADIUS, type LegCount } from './geometry'
import { ACTUATOR_PRESETS, ActuatorBank, isOverloaded, servoCurrent } from './actuator'
import { distributeLoad } from './statics'
import { GRAVITY } from './simState'
import { WalkerSim } from './sim'

/* ============================================================
   PHYSICS AUDIT (KINEMATIC) — the sim against hand-derived
   statics and servo datasheets, independent of the code paths
   that compute them.
   ============================================================ */

const DEG = Math.PI / 180
const STILL = { vx: 0, vy: 0, wz: 0 }

function walk(sim: WalkerSim, seconds: number, dt: number, cmd = { vx: 0.08, vy: 0, wz: 0 }, each?: () => void): void {
  for (let k = 0; k < Math.round(seconds / dt); k++) {
    sim.stepKinematic(dt, cmd, k * dt)
    each?.()
  }
}

describe('standing statics (hand-derived)', () => {
  it('holds each foot at W/6 and the femur / tibia at the closed-form lever-arm torques', () => {
    // Arrange: 1.8 kg hexapod, ideal servos, symmetric stance
    const sim = new WalkerSim(6)
    const d = sim.layout.dims
    // Act
    sim.stepKinematic(1 / 60, STILL, 1 / 60)
    // Assert: by hand, α = 35.006°, α + β = 10.002° at the 85 mm stand height.
    // Ball foot: the normal force acts through the ball centre, (L3 − r) down the tibia.
    const W = 1.8 * GRAVITY
    const F = W / 6
    const a = 35.006 * DEG
    const ab = 10.002 * DEG
    const kneeR = d.femur * Math.cos(a)
    const ballR = (d.tibia - FOOT_RADIUS) * Math.sin(ab)
    const femurHand = -F * (kneeR + ballR) + GRAVITY * (0.06 * kneeR / 2 + 0.03 * (kneeR + (d.tibia / 2) * Math.sin(ab)))
    const tibiaHand = -F * ballR + GRAVITY * 0.03 * (d.tibia / 2) * Math.sin(ab)
    expect(femurHand).toBeCloseTo(-0.2022, 3)
    expect(tibiaHand).toBeCloseTo(-0.0575, 3)
    for (let i = 0; i < 6; i++) {
      expect(sim.state.load[i]).toBeCloseTo(F, 6)
      expect(sim.state.torque[i * 3]).toBeCloseTo(0, 9)
      expect(sim.state.torque[i * 3 + 1]).toBeCloseTo(femurHand, 4)
      expect(sim.state.torque[i * 3 + 2]).toBeCloseTo(tibiaHand, 4)
    }
  })

  it('splits a tripod load by the barycentric coordinates of the CoM (unique 3-foot solution)', () => {
    // Arrange: three feet, CoM off-centre
    const px = new Float64Array([0.21, -0.19, 0.02])
    const py = new Float64Array([-0.16, -0.13, 0.24])
    const cx = 0.025
    const cy = -0.01
    const W = 17.658
    const f = new Float64Array(3)
    // Act
    distributeLoad(px, py, new Uint8Array([1, 1, 1]), 3, cx, cy, W, f)
    // Assert: λ_i = area of the sub-triangle opposite foot i / total area
    const area = (ax: number, ay: number, bx: number, by: number, qx: number, qy: number): number => (bx - ax) * (qy - ay) - (by - ay) * (qx - ax)
    const total = area(px[0], py[0], px[1], py[1], px[2], py[2])
    const l0 = area(cx, cy, px[1], py[1], px[2], py[2]) / total
    const l1 = area(px[0], py[0], cx, cy, px[2], py[2]) / total
    expect(f[0]).toBeCloseTo(W * l0, 9)
    expect(f[1]).toBeCloseTo(W * l1, 9)
    expect(f[2]).toBeCloseTo(W * (1 - l0 - l1), 9)
  })

  it('balances force and both moments about the CoM on every walking frame for 4, 6 and 8 legs', () => {
    for (const n of [4, 6, 8] as LegCount[]) {
      const sim = new WalkerSim(n)
      sim.actuator = { ...ACTUATOR_PRESETS.mg996r }
      sim.pose.shiftX = 0.012
      sim.pose.pitch = 4 * DEG
      let frames = 0
      walk(sim, 3, 1 / 60, { vx: 0.03, vy: 0.01, wz: 0.15 }, () => {
        if (!sim.state.balanced) return
        let fz = 0
        let mx = 0
        let my = 0
        for (let i = 0; i < n; i++) {
          const f = sim.state.load[i]
          fz += f
          mx += f * (sim.state.feet[i * 3 + 1] - sim.state.com[1])
          my += f * (sim.state.feet[i * 3] - sim.state.com[0])
        }
        frames++
        expect(fz, `${n} legs`).toBeCloseTo(sim.weight, 6)
        expect(mx, `${n} legs`).toBeCloseTo(0, 6)
        expect(my, `${n} legs`).toBeCloseTo(0, 6)
      })
      expect(frames, `${n} legs`).toBeGreaterThan(150)
    }
  })
})

describe('servo model against datasheets', () => {
  it('needs the datasheet time for a 60° move: SG90 0.10 s, MG996R 0.17 s, DS3218 0.16 s', () => {
    for (const [id, sec] of [['sg90', 0.1], ['mg996r', 0.171], ['ds3218', 0.16]] as const) {
      // Arrange
      const bank = new ActuatorBank(1)
      bank.reset(new Float64Array([0]), 1)
      const target = new Float64Array([60 * DEG])
      const h = 1 / 1000
      let t = 0
      // Act: unloaded, until within 2° (an SG90 settles 1.25° short: ½ deadband + ½ backlash)
      while (bank.out[0] < 58 * DEG && t < 1) {
        bank.step(h, target, null, ACTUATOR_PRESETS[id], 1)
        t += h
      }
      // Assert: speed-limited (never faster than the datasheet), plus a little first-order tail
      expect(t, id).toBeGreaterThanOrEqual(sec * (57 / 60))
      expect(t, id).toBeLessThan(sec + 2.5 * ACTUATOR_PRESETS[id].tau)
    }
  })

  it('never draws more than the stall current, even when the load is past stall', () => {
    const sg = ACTUATOR_PRESETS.sg90
    const stallCurrent = sg.idle + sg.stall / sg.kt
    expect(stallCurrent).toBeCloseTo(0.006 + 0.65, 9)
    expect(servoCurrent(0.5, sg)).toBeCloseTo(stallCurrent, 12)
    // a 1.8 kg hexapod on SG90s overloads its femurs; 18 servos stay under 18 × stall current
    const sim = new WalkerSim(6)
    sim.actuator = { ...sg }
    walk(sim, 1, 1 / 60, STILL)
    expect(sim.state.overload).toBeGreaterThanOrEqual(0)
    for (let j = 0; j < 18; j++) expect(sim.state.current[j]).toBeLessThanOrEqual(stallCurrent + 1e-12)
  })

  it('flags a joint at exactly the stall torque (a saturated DYNAMIC motor reads stall)', () => {
    const mg = ACTUATOR_PRESETS.mg996r
    expect(isOverloaded(mg.stall, mg)).toBe(true)
    expect(isOverloaded(-mg.stall, mg)).toBe(true)
    expect(isOverloaded(0.999 * mg.stall, mg)).toBe(false)
    expect(isOverloaded(1e6, ACTUATOR_PRESETS.ideal)).toBe(false)
  })

  it('estimates a plausible standing current and power for an MG996R hexapod (~4 A, ~25 W at 6 V)', () => {
    const sim = new WalkerSim(6)
    sim.actuator = { ...ACTUATOR_PRESETS.mg996r }
    walk(sim, 1.5, 1 / 60, STILL)
    expect(sim.state.overload).toBe(-1)
    expect(sim.state.totalCurrent).toBeGreaterThan(3)
    expect(sim.state.totalCurrent).toBeLessThan(5)
    expect(sim.state.power).toBeCloseTo(sim.state.totalCurrent * 6, 9)
  })
})

describe('integration does not depend on the frame rate', () => {
  it('walks the same distance and shows the same servo sag at 30, 60 and 144 fps', () => {
    const result = [30, 60, 144].map((fps) => {
      const sim = new WalkerSim(6)
      sim.actuator = { ...ACTUATOR_PRESETS.mg996r }
      walk(sim, 4, 1 / fps)
      return { x: sim.state.bodyPos[0], z: sim.state.bodyPos[2], frame: sim.engine.frame[0] }
    })
    for (const r of result) {
      expect(r.frame).toBeCloseTo(result[1].frame, 3)
      expect(Math.abs(r.x - result[1].x)).toBeLessThan(0.003)
      expect(Math.abs(r.z - result[1].z)).toBeLessThan(0.0015)
    }
  })
})
