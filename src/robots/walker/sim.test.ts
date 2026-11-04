import { describe, expect, it } from 'vitest'
import { BELLY_HEIGHT, DEFAULT_DIMS, LEG_COUNTS } from './geometry'
import { legFK, legToBody } from './kinematics'
import { bodyToWorld, rotationZYX } from './pose'
import { WalkerSim } from './sim'
import { ACTUATOR_PRESETS } from './actuator'
import { GRAVITY, totalMass } from './simState'

const DT = 1 / 60
const FWD = { vx: 0.08, vy: 0, wz: 0 }

function run(sim: WalkerSim, seconds: number, cmd = FWD, each?: (t: number) => void): void {
  let t = 0
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    t += DT
    sim.stepKinematic(DT, cmd, t)
    each?.(t)
  }
}

describe('WalkerSim', () => {
  it('renders stance feet exactly where the gait planted them with ideal servos', () => {
    for (const n of LEG_COUNTS) {
      const sim = new WalkerSim(n)
      run(sim, 2, { vx: 0.06, vy: 0.01, wz: 0.2 }, () => {
        for (let i = 0; i < n; i++) {
          if (!sim.engine.contact[i]) continue
          for (let k = 0; k < 3; k++) expect(sim.state.feet[i * 3 + k]).toBeCloseTo(sim.engine.feet[i * 3 + k], 6)
        }
      })
    }
  })

  it('applies the body pose through IK with the feet staying put', () => {
    const sim = new WalkerSim(6)
    const before = sim.state.feet.slice(0, 18)
    sim.pose.roll = 0.1
    sim.pose.pitch = -0.08
    sim.pose.yaw = 0.15
    sim.pose.shiftX = 0.02
    sim.pose.height = 0.1
    sim.stepKinematic(DT, { vx: 0, vy: 0, wz: 0 }, DT)
    for (let k = 0; k < 18; k++) expect(sim.state.feet[k]).toBeCloseTo(before[k], 6)
    expect(sim.state.bodyPos[2]).toBeCloseTo(0.1, 12)
    expect(sim.ikStatus.slice(0, 6).every((s) => s === 0)).toBe(true)
  })

  it('carries the full weight with balanced moments on every frame of a tripod walk', () => {
    const sim = new WalkerSim(6)
    const W = totalMass(sim.mass, 6) * GRAVITY
    run(sim, 2, FWD, () => {
      let sum = 0
      for (let i = 0; i < 6; i++) sum += sim.state.load[i]
      expect(sum).toBeCloseTo(W, 6)
      expect(sim.state.margin).toBeGreaterThan(0)
      for (let i = 0; i < 6; i++) if (!sim.state.contact[i]) expect(sim.state.load[i]).toBe(0)
    })
  })

  it('weighs about 1.8 kg as a hexapod and scales with the leg count', () => {
    const sim = new WalkerSim(6)
    expect(totalMass(sim.mass, 6)).toBeCloseTo(1.8, 9)
    expect(totalMass(sim.mass, 4)).toBeLessThan(totalMass(sim.mass, 8))
  })

  it('computes real femur torque from the load (Jacobianᵀ·F)', () => {
    const sim = new WalkerSim(6)
    sim.stepKinematic(DT, { vx: 0, vy: 0, wz: 0 }, DT)
    // standing on 6 feet: each femur holds about (W/6) × horizontal lever, pushing down (negative)
    const share = sim.weight / 6
    const L = sim.layout
    const lever = L.footReach - L.dims.coxa
    expect(sim.state.torque[1]).toBeLessThan(0)
    expect(Math.abs(sim.state.torque[1])).toBeGreaterThan(0.5 * share * lever)
    expect(Math.abs(sim.state.torque[1])).toBeLessThan(1.5 * share * lever)
    expect(sim.state.totalCurrent).toBeGreaterThan(0)
    expect(sim.state.power).toBeCloseTo(sim.state.totalCurrent * sim.actuator.volts, 9)
  })

  it('flags an overload when the femur torque exceeds the SG90 stall torque', () => {
    const sim = new WalkerSim(6)
    sim.actuator = { ...ACTUATOR_PRESETS.sg90 }
    run(sim, 1)
    expect(sim.state.overload).toBeGreaterThanOrEqual(0)
    expect(sim.state.overload % 3).not.toBe(0)
  })

  it('lets weak servos sag under load (the pose follows the actuator, not the IK)', () => {
    const sim = new WalkerSim(6)
    sim.actuator = { ...ACTUATOR_PRESETS.sg90 }
    run(sim, 1, { vx: 0, vy: 0, wz: 0 })
    let worst = 0
    for (let j = 0; j < 18; j++) worst = Math.max(worst, Math.abs(sim.state.q[j] - sim.qTarget[j]))
    expect(worst).toBeGreaterThan(0.05)
  })

  it('keeps the CoM inside the support triangle on every frame of the quadruped crawl, with ideal and real servos', () => {
    const cmds = [{ vx: 0.06, vy: 0, wz: 0 }, { vx: 0, vy: 0.05, wz: 0 }, { vx: 0.03, vy: 0, wz: 0.3 }, { vx: -0.05, vy: 0.02, wz: 0 }]
    for (const id of ['ideal', 'mg996r'] as const) {
      for (const cmd of cmds) {
        const sim = new WalkerSim(4)
        sim.actuator = { ...ACTUATOR_PRESETS[id] }
        expect(sim.gait.id).toBe('crawl')
        let min = Infinity
        let steps = 0
        let was = 0
        run(sim, 10, cmd, (t) => {
          const sw = sim.engine.swinging[0] + sim.engine.swinging[1] + sim.engine.swinging[2] + sim.engine.swinging[3]
          if (sw > was) steps++
          was = sw
          if (t > 1.5) min = Math.min(min, sim.state.margin)
        })
        // statically stable: the full CoM (legs included) stays inside even with the body
        // following lagging MG996R servos, and no step is skipped
        const tag = `${id} ${JSON.stringify(cmd)}`
        expect(min, tag).toBeGreaterThan(id === 'ideal' ? 0.015 : 0.005)
        expect(steps, tag).toBeGreaterThanOrEqual(4 * Math.floor(10 * sim.params.freq) - 1)
      }
    }
  })

  it('plans a crawl that hobby servos can follow: no body jumps, joint rates inside an MG996R', () => {
    // Arrange: the default crawl at 60 % speed, sampled finely
    const sim = new WalkerSim(4)
    const h = 1 / 240
    const v = sim.engine.maxSpeed(sim.params) * 0.6
    const prevQ = new Float64Array(12)
    let prevX = NaN
    let prevY = NaN
    let peakSpeed = 0
    let peakRate = 0
    // Act
    for (let k = 0; k < Math.round(8 / h); k++) {
      sim.stepKinematic(h, { vx: v, vy: 0, wz: 0 }, k * h)
      const x = sim.planPos[0]
      const y = sim.planPos[1]
      if (k * h > 1.5) {
        peakSpeed = Math.max(peakSpeed, Math.hypot(x - prevX, y - prevY) / h)
        for (let j = 0; j < 12; j++) peakRate = Math.max(peakRate, Math.abs(sim.qTarget[j] - prevQ[j]) / h)
      }
      prevX = x
      prevY = y
      prevQ.set(sim.qTarget.subarray(0, 12))
    }
    // Assert: the old full-incentre sway jumped ~14 cm in 40 ms (5 m/s, 4000 °/s)
    expect(peakSpeed).toBeLessThan(0.4)
    expect(peakRate).toBeLessThan(ACTUATOR_PRESETS.mg996r.speed)
  })

  it('re-settles the quadruped feet after stopping without ever losing static stability', () => {
    const sim = new WalkerSim(4)
    let min = Infinity
    run(sim, 4, { vx: 0.06, vy: 0, wz: 0.2 }, (t) => { if (t > 1.5) min = Math.min(min, sim.state.margin) })
    // feet re-settle one cycle at a time: give it four gait cycles
    run(sim, 4 / sim.params.freq, { vx: 0, vy: 0, wz: 0 }, () => { min = Math.min(min, sim.state.margin) })
    expect(min).toBeGreaterThan(0.015)
    expect(sim.engine.stanceCount()).toBe(4)
    expect(Math.hypot(sim.engine.sway[0], sim.engine.sway[1])).toBeLessThan(1e-3)
  })

  it('shows zero margin on two feet in the trot (dynamically stable only)', () => {
    const sim = new WalkerSim(4)
    sim.setGait('trot')
    let minMargin = Infinity
    run(sim, 3, { vx: 0.06, vy: 0, wz: 0 }, () => { minMargin = Math.min(minMargin, sim.state.margin) })
    expect(minMargin).toBeLessThanOrEqual(1e-9)
  })

  it('reconfigures leg count and dimensions, keeping a valid gait', () => {
    const sim = new WalkerSim(6)
    sim.setGait('wave')
    sim.configure(8, DEFAULT_DIMS)
    expect(sim.gait.id).toBe('wave')
    sim.configure(4, { ...DEFAULT_DIMS, femur: 0.09 })
    expect(sim.gait.id).toBe('crawl')
    expect(sim.layout.dims.femur).toBe(0.09)
    expect(sim.state.contact.slice(4).every((c) => c === 0)).toBe(true)
  })

  it('rejects a gait that is not valid for the leg count', () => {
    const sim = new WalkerSim(6)
    expect(sim.setGait('trot')).toBe(false)
    expect(sim.gait.id).toBe('tripod')
  })

  it('follows a setLeg override in the body frame and infers contact from the foot height', () => {
    const sim = new WalkerSim(6)
    sim.legOverride[0] = sim.layout.neutralX[0]
    sim.legOverride[1] = sim.layout.neutralY[0]
    sim.legOverride[2] = -sim.pose.height + 0.04
    sim.stepKinematic(DT, { vx: 0, vy: 0, wz: 0 }, DT)
    expect(sim.state.feet[2]).toBeCloseTo(0.04, 6)
    expect(sim.state.contact[0]).toBe(0)
    expect(sim.state.load[0]).toBe(0)
  })

  it('follows a setJoint override for that joint only', () => {
    const sim = new WalkerSim(6)
    sim.jointOverride[4] = 0.5
    sim.stepKinematic(DT, { vx: 0, vy: 0, wz: 0 }, DT)
    expect(sim.state.q[4]).toBeCloseTo(0.5, 12)
    sim.clearOverrides()
    sim.stepKinematic(DT, { vx: 0, vy: 0, wz: 0 }, 2 * DT)
    expect(sim.state.q[4]).not.toBeCloseTo(0.5, 3)
  })

  it('shows measured joint angles while hardware telemetry is fresh, then falls back to the sim', () => {
    const sim = new WalkerSim(6)
    sim.measQ.fill(0)
    sim.measQAt = 1
    sim.stepKinematic(DT, { vx: 0, vy: 0, wz: 0 }, 1.2)
    expect(sim.poseSource).toBe('measured')
    expect(sim.state.q[1]).toBe(0)
    sim.stepKinematic(DT, { vx: 0, vy: 0, wz: 0 }, 1.6)
    expect(sim.poseSource).toBe('sim')
    expect(sim.state.q[1]).toBeGreaterThan(0.3)
  })

  it('uses measured loads and IMU tilt when present', () => {
    const sim = new WalkerSim(6)
    sim.measLoad.set([3, 3, 3, 3, 3, 0])
    sim.measLoadAt = 1
    sim.measImu.set([0.1, -0.05, 0])
    sim.measImuAt = 1
    sim.stepKinematic(DT, { vx: 0, vy: 0, wz: 0 }, 1.1)
    expect(sim.state.load[0]).toBe(3)
    expect(sim.state.contact[5]).toBe(0)
    expect(sim.state.bodyR[7]).toBeCloseTo(Math.cos(-0.05) * Math.sin(0.1), 9)
  })

  it('gives a home pose whose FK puts every foot on the ground at its neutral point', () => {
    const sim = new WalkerSim(8)
    const q = new Float64Array(24)
    sim.homePose(q)
    const p = new Float64Array(3)
    const b = new Float64Array(3)
    const w = new Float64Array(3)
    const pos = new Float64Array([0, 0, sim.pose.height])
    const R = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
    for (let i = 0; i < 8; i++) {
      legFK(sim.layout.dims, q, i * 3, p, 0)
      legToBody(sim.layout.mountX[i], sim.layout.mountY[i], sim.layout.mountYaw[i], p[0], p[1], p[2], b, 0)
      bodyToWorld(pos, R, b[0], b[1], b[2], w, 0)
      expect(w[0]).toBeCloseTo(sim.layout.neutralX[i], 9)
      expect(w[2]).toBeCloseTo(0, 9)
    }
  })

  it('rests the body on the planted feet the compliant servos imply: it sinks, the feet stay put', () => {
    const sim = new WalkerSim(6)
    sim.actuator = { ...ACTUATOR_PRESETS.mg996r }
    run(sim, 2, { vx: 0, vy: 0, wz: 0 })
    const sag = sim.pose.height - sim.state.bodyPos[2]
    // MG996R holding ~0.22 Nm deflects ~1.3° at the femur: a few millimetres of sag
    expect(sag).toBeGreaterThan(0.001)
    expect(sag).toBeLessThan(0.008)
    for (let i = 0; i < 6; i++) {
      for (let k = 0; k < 3; k++) expect(sim.state.feet[i * 3 + k]).toBeCloseTo(sim.engine.feet[i * 3 + k], 9)
    }
    // closing the chain onto the planted feet stays within a few degrees of the free servo
    // output (the strain friction at the feet takes, which the vertical-load statics ignores)
    for (let j = 0; j < 18; j++) expect(Math.abs(sim.state.q[j] - sim.actuators.out[j])).toBeLessThan(3 * (Math.PI / 180))
  })

  it('sinks more on weaker servos (IDEAL < DS3218 < MG996R < SG90)', () => {
    const z = (['ideal', 'ds3218', 'mg996r', 'sg90'] as const).map((id) => {
      const sim = new WalkerSim(6)
      sim.actuator = { ...ACTUATOR_PRESETS[id] }
      run(sim, 1.5, { vx: 0, vy: 0, wz: 0 })
      return sim.state.bodyPos[2]
    })
    expect(z[0]).toBeCloseTo(0.085, 9)
    for (let k = 1; k < 4; k++) expect(z[k]).toBeLessThan(z[k - 1])
  })

  it('keeps stance feet exactly on their planted points while lagging, compliant servos walk', () => {
    const sim = new WalkerSim(6)
    sim.actuator = { ...ACTUATOR_PRESETS.ds3218 }
    let worst = 0
    run(sim, 3, FWD, (t) => {
      if (t < 0.5) return
      for (let i = 0; i < 6; i++) {
        if (!sim.engine.contact[i]) continue
        worst = Math.max(worst, Math.hypot(sim.state.feet[i * 3] - sim.engine.feet[i * 3], sim.state.feet[i * 3 + 1] - sim.engine.feet[i * 3 + 1]))
      }
    })
    expect(worst).toBeLessThan(1e-9)
  })

  it('rests measured angles on the lowest foot, and on the belly when no foot reaches the ground', () => {
    const sim = new WalkerSim(6)
    const home = new Float64Array(24)
    sim.homePose(home)
    sim.measQ.set(home)
    sim.measQAt = 1
    sim.stepKinematic(DT, { vx: 0, vy: 0, wz: 0 }, 1.05)
    expect(sim.state.bodyPos[2]).toBeCloseTo(sim.pose.height, 9)
    expect(sim.state.contact.slice(0, 6).every((c) => c === 1)).toBe(true)
    // legs raised like a dead bug (femur +80°, tibia straight out): no foot reaches below the belly
    for (let i = 0; i < 6; i++) {
      sim.measQ[i * 3 + 1] = 80 * (Math.PI / 180)
      sim.measQ[i * 3 + 2] = 10 * (Math.PI / 180)
    }
    sim.measQAt = 1.06
    sim.stepKinematic(DT, { vx: 0, vy: 0, wz: 0 }, 1.08)
    expect(sim.state.belly).toBe(true)
    expect(sim.state.bodyPos[2]).toBeCloseTo(BELLY_HEIGHT, 12)
    expect(sim.state.contact.slice(0, 6).every((c) => c === 0)).toBe(true)
    expect(sim.state.load.slice(0, 6).every((f) => f === 0)).toBe(true)
  })

  it('rests a robot whose every joint CODE drives on its own feet (a servo sketch)', () => {
    const sim = new WalkerSim(6)
    const home = new Float64Array(24)
    sim.homePose(home)
    for (let j = 0; j < 18; j++) sim.jointOverride[j] = home[j]
    // the right-middle leg is lifted 20° at the femur
    sim.jointOverride[4] = home[4] + 20 * (Math.PI / 180)
    for (let k = 0; k < 30; k++) sim.stepKinematic(DT, { vx: 0, vy: 0, wz: 0 }, k * DT)
    expect(sim.state.bodyPos[2]).toBeCloseTo(sim.pose.height, 6)
    expect(Array.from(sim.state.contact.slice(0, 6))).toEqual([1, 0, 1, 1, 1, 1])
    for (const i of [0, 2, 3, 4, 5]) expect(sim.state.feet[i * 3 + 2]).toBeCloseTo(0, 9)
    expect(sim.state.feet[1 * 3 + 2]).toBeGreaterThan(0.01)
  })

  it('lifts the body only as far as the legs reach when the height is out of reach', () => {
    const sim = new WalkerSim(6)
    sim.pose.height = 0.3
    sim.settle(0)
    expect(sim.ikStatus[0]).not.toBe(0)
    expect(sim.state.bodyPos[2]).toBeLessThan(sim.layout.dims.femur + sim.layout.dims.tibia)
    for (let i = 0; i < 6; i++) expect(Math.abs(sim.state.feet[i * 3 + 2])).toBeLessThan(0.02)
  })

  it('continues the plan from the physics body pose when leaving DYNAMIC', () => {
    const sim = new WalkerSim(6)
    sim.state.bodyPos.set([0.4, -0.2, 0.07])
    rotationZYX(0.7, 0.05, 0, sim.state.bodyR)
    sim.adoptBodyPose()
    expect(sim.engine.frame[0]).toBeCloseTo(0.4, 9)
    expect(sim.engine.frame[1]).toBeCloseTo(-0.2, 9)
    expect(sim.engine.frame[2]).toBeCloseTo(0.7, 9)
    expect(sim.state.bodyPos[2]).toBeCloseTo(sim.pose.height, 9)
  })

  it('stays well inside the frame budget (kinematic update under 1 ms for 8 legs)', () => {
    const sim = new WalkerSim(8)
    sim.actuator = { ...ACTUATOR_PRESETS.mg996r }
    run(sim, 1)
    // best of several batches: robust when other test files share the CPU
    let best = Infinity
    for (let rep = 0; rep < 6; rep++) {
      const t0 = performance.now()
      run(sim, 1)
      best = Math.min(best, (performance.now() - t0) / 60)
    }
    expect(best).toBeLessThan(1)
  })
})
