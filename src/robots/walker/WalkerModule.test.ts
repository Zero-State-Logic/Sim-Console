import { describe, expect, it } from 'vitest'
import type { ControlDef, SelectDef, SliderDef, StepContext } from '../../core/types'
import { entry } from './index'
import { WalkerModule } from './WalkerModule'
import { JOINT_LIMITS_DEG } from './kinematics'
import { heightRange } from './geometry'

const DT = 1 / 60

/** A module on a fake clock, so hardware-telemetry freshness is deterministic. */
function make(): { m: WalkerModule; clock: { now: number } } {
  const clock = { now: 100 }
  return { m: new WalkerModule({ clock: () => clock.now }), clock }
}

function run(m: WalkerModule, seconds: number, source: StepContext['source'] = 'sim', clock?: { now: number }): void {
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    if (clock) clock.now += DT
    m.update(DT, { source, t: k * DT })
  }
}

function def(m: WalkerModule, key: string): ControlDef {
  const d = m.getControlSchema().find((x) => x.key === key)
  if (!d) throw new Error(`no control ${key}`)
  return d
}

describe('walker entry', () => {
  it('registers kind walker and creates a module with a scene graph', () => {
    expect(entry.kind).toBe('walker')
    expect(entry.label).toBe('WALKER')
    const m = entry.create()
    expect(m.kind).toBe('walker')
    expect(m.root.children.length).toBeGreaterThan(0)
    m.dispose()
  })
})

describe('WalkerModule controls', () => {
  it('lays the control groups out in rail order', () => {
    const { m } = make()
    const groups: string[] = []
    for (const d of m.getControlSchema()) if (!groups.includes(d.group)) groups.push(d.group)
    expect(groups).toEqual(['SIMULATION', 'GAIT PATTERN', 'LOCOMOTION', 'PARAMETERS', 'BODY POSE', 'DIMENSIONS', 'ACTUATOR', 'ACTIONS'])
    m.dispose()
  })

  it('follows the shared direction-pad, turn and camera conventions', () => {
    const { m } = make()
    const dir = def(m, 'dir') as SelectDef
    expect(dir.display).toBe('grid3')
    expect(dir.options.map((o) => o.value)).toEqual(['fl', 'f', 'fr', 'l', 'stop', 'r', 'bl', 'b', 'br'])
    expect(dir.options.map((o) => o.icon)).toEqual(['↖', '↑', '↗', '←', '■', '→', '↙', '↓', '↘'])
    expect((def(m, 'turn') as SelectDef).options.map((o) => o.value)).toEqual(['ccw', 'none', 'cw'])
    expect((def(m, 'legs') as SelectDef).options.map((o) => o.value)).toEqual(['4', '6', '8'])
    expect(m.world.cameraPresets.map((p) => p.id)).toEqual(['iso', 'front', 'side', 'top'])
    m.dispose()
  })

  it('switches legs live: rebuilds, offers only valid gaits and bumps the revision', () => {
    const { m } = make()
    const rev = m.revision
    m.setControl('legs', '4')
    expect(m.revision).toBeGreaterThan(rev)
    expect((def(m, 'gait') as SelectDef).options.map((o) => o.value)).toEqual(['crawl', 'trot', 'pace'])
    expect(m.getControlValues().gait).toBe('crawl')
    // the crawl brings its own (slower) cycle with it, like its duty
    expect(m.getControlValues().gaitHz).toBe(m.sim.gait.freq)
    expect(m.sim.params.freq).toBe(0.5)
    m.setControl('gait', 'trot')
    expect(m.sim.params.freq).toBe(1.2)
    expect(m.getHardwareSpec().joints).toBe(12)
    expect(m.getInstrumentLayout().bars?.labels).toEqual(['L1', 'L2', 'L3', 'L4'])
    expect(m.getTelemetry().bars).toHaveLength(4)
    m.setControl('legs', '8')
    expect((def(m, 'gait') as SelectDef).options.map((o) => o.value)).toEqual(['tetrapod', 'ripple', 'wave'])
    expect(m.getInstrumentLayout().subtitle).toBe('OCTO · TETRAPOD')
    m.dispose()
  })

  it('rebuilds for new dimensions and keeps the height slider inside the reachable range', () => {
    const { m } = make()
    m.setControl('tibia', 0.2)
    const h = def(m, 'height') as SliderDef
    const [lo, hi] = heightRange({ coxa: 0.045, femur: 0.075, tibia: 0.2, bodyRadius: 0.11 })
    expect([h.min, h.max]).toEqual([lo, hi])
    expect(m.getHardwareSpec().geometry?.tibia).toBe(0.2)
    m.setControl('height', 10)
    expect(m.getControlValues().height).toBe(hi)
    m.dispose()
  })

  it('validates writes: unknown keys, foreign options and non-numbers are ignored, sliders clamped', () => {
    const { m } = make()
    const before = m.getControlValues()
    m.setControl('nope', 1)
    m.setControl('gait', 'trot')
    m.setControl('speed', 'fast')
    m.setControl('treadmill', 'yes')
    expect(m.getControlValues()).toEqual(before)
    m.setControl('speed', 250)
    expect(m.getControlValues().speed).toBe(100)
    m.dispose()
  })

  it('switches the gait, resets the duty to the new gait and raises its minimum', () => {
    const { m } = make()
    m.setControl('gait', 'wave')
    expect(m.sim.gait.id).toBe('wave')
    const duty = def(m, 'duty') as SliderDef
    expect(duty.min).toBeCloseTo(5 / 6, 9)
    expect(m.getControlValues().duty).toBeCloseTo(5 / 6, 9)
    m.dispose()
  })

  it('applies actuator presets, and editing a slider switches to CUSTOM from the preset values', () => {
    const { m } = make()
    m.setControl('actuator', 'mg996r')
    expect(m.sim.actuator.stall).toBe(1)
    expect(m.getControlValues().actStall).toBe(1)
    expect(m.getInstrumentLayout().charts[0].channels.map((c) => c.key)).toContain('tqStall')
    // a profile re-applying the preset's own value keeps the preset
    m.setControl('actStall', 1)
    expect(m.getControlValues().actuator).toBe('mg996r')
    m.setControl('actStall', 1.5)
    expect(m.getControlValues().actuator).toBe('custom')
    expect(m.sim.actuator.stall).toBe(1.5)
    expect(m.sim.actuator.speed).toBeCloseTo(350 * (Math.PI / 180), 9)
    m.setControl('actuator', 'ideal')
    expect(m.getInstrumentLayout().charts[0].channels.map((c) => c.key)).not.toContain('tqStall')
    m.dispose()
  })

  it('bumps the revision for a servo change only when the instrument layout changes shape', () => {
    const { m } = make()
    m.setControl('actuator', 'custom')
    const rev = m.revision
    m.setControl('actBacklash', 2)
    m.setControl('actTau', 60)
    expect(m.revision).toBe(rev)
    m.setControl('actStall', 2.5)
    expect(m.revision).toBeGreaterThan(rev)
    expect(m.getInstrumentLayout().charts[0].max).toBe(3.5)
    m.dispose()
  })

  it('applies body pose edits while paused and resets the pose', () => {
    const { m } = make()
    m.setControl('height', 0.1)
    m.setControl('roll', 10)
    m.update(0, { source: 'sim', t: 0 })
    expect(m.sim.state.bodyPos[2]).toBeCloseTo(0.1, 9)
    expect(m.sim.state.feet[2]).toBeCloseTo(0, 9)
    m.setControl('resetPose', true)
    m.update(0, { source: 'sim', t: 0 })
    expect(m.getControlValues().roll).toBe(0)
    expect(m.sim.state.bodyPos[2]).toBeCloseTo(0.085, 9)
    m.dispose()
  })
})

describe('WalkerModule locomotion', () => {
  it('walks forward from the direction pad and the follow target tracks the body (Y-up)', () => {
    const { m } = make()
    m.setControl('dir', 'f')
    m.setControl('speed', 100)
    run(m, 3)
    const x = m.sim.state.bodyPos[0]
    expect(x).toBeGreaterThan(0.3)
    const f = m.followTarget()
    expect(f.x).toBeCloseTo(x, 12)
    expect(f.y).toBeCloseTo(m.sim.state.bodyPos[2], 12)
    expect(f.z).toBeCloseTo(-m.sim.state.bodyPos[1], 12)
    const tel = m.getTelemetry()
    expect(tel.gauges.drive).toBeGreaterThan(90)
    expect(tel.readouts.speed).toBeGreaterThan(0.1)
    m.dispose()
  })

  it('turns CCW for turn = ccw and strafes left for dir = l', () => {
    const { m } = make()
    m.setControl('turn', 'ccw')
    run(m, 2)
    expect(m.sim.engine.frame[2]).toBeGreaterThan(0.3)
    m.setControl('turn', 'none')
    m.setControl('dir', 'l')
    const y0 = m.sim.engine.frame[1]
    run(m, 2)
    // left in the (rotated) body frame still has a +y component after a small turn
    expect(Math.hypot(m.sim.engine.frame[0], m.sim.engine.frame[1] - y0)).toBeGreaterThan(0.1)
    m.dispose()
  })

  it('keeps the body centred on the treadmill and shows the belt', () => {
    const { m } = make()
    m.setControl('treadmill', true)
    m.setControl('dir', 'f')
    run(m, 2)
    expect(Math.hypot(m.sim.state.bodyPos[0], m.sim.state.bodyPos[1])).toBeLessThan(0.01)
    expect(m.sim.engine.odometer).toBeGreaterThan(0.1)
    let belt = false
    m.root.traverse((o) => {
      if ((o as { isPoints?: boolean }).isPoints && o.visible) belt = true
    })
    expect(belt).toBe(true)
    m.dispose()
  })

  it('reports physically consistent telemetry: loads sum to the weight on a statically stable gait', () => {
    const { m } = make()
    m.setControl('dir', 'f')
    for (let k = 0; k < 120; k++) {
      m.update(DT, { source: 'sim', t: k * DT })
      const tel = m.getTelemetry()
      expect(tel.bars.reduce((a, b) => a + b, 0)).toBeCloseTo(m.sim.weight, 6)
      expect(tel.gauges.stability).toBeGreaterThan(0)
    }
    m.dispose()
  })

  it('fills every channel and readout its layout declares', () => {
    const { m } = make()
    run(m, 0.2)
    const layout = m.getInstrumentLayout()
    const tel = m.getTelemetry()
    for (const c of layout.charts) for (const ch of c.channels) expect(typeof tel.channels[ch.key]).toBe('number')
    for (const r of layout.readouts) expect(tel.readouts[r.key]).toBeDefined()
    for (const g of layout.gauges) expect(typeof tel.gauges[g.key]).toBe('number')
    expect(tel.bars).toHaveLength(layout.bars?.labels.length ?? -1)
    m.dispose()
  })

  it('warns about an overload when the servos cannot hold the robot', () => {
    const { m } = make()
    m.setControl('actuator', 'sg90')
    run(m, 0.5)
    expect(String(m.getTelemetry().readouts.servo)).toMatch(/^OVERLOAD L\d (FEMUR|TIBIA) /)
    m.dispose()
  })

  it('stays well inside the frame budget in kinematic mode (8 legs, MG996R)', () => {
    const { m } = make()
    m.setControl('legs', '8')
    m.setControl('actuator', 'mg996r')
    m.setControl('dir', 'f')
    run(m, 0.5)
    // best of several batches: robust when other test files share the CPU
    let best = Infinity
    for (let rep = 0; rep < 6; rep++) {
      const t0 = performance.now()
      for (let k = 0; k < 60; k++) {
        m.update(DT, { source: 'sim', t: k * DT })
        m.getTelemetry()
      }
      best = Math.min(best, (performance.now() - t0) / 60)
    }
    expect(best).toBeLessThan(3)
    m.dispose()
  })
})

describe('WalkerModule HARDWARE', () => {
  it('describes the robot for codegen with the documented geometry keys', () => {
    const { m } = make()
    const spec = m.getHardwareSpec()
    expect(spec.robot).toBe('walker')
    expect(spec.joints).toBe(18)
    expect(spec.legs).toBe(6)
    expect(spec.jointNames.slice(0, 4)).toEqual(['L1 coxa', 'L1 femur', 'L1 tibia', 'L2 coxa'])
    expect(spec.defaultLevel).toEqual({ wired: 'joint', wireless: 'high' })
    expect(Object.keys(spec.geometry ?? {}).sort()).toEqual(['coxa', 'femur', 'footReach', 'mountX', 'mountY', 'mountYawDeg', 'standHeight', 'tibia'])
    for (const k of ['mountX', 'mountY', 'mountYawDeg']) expect(spec.geometry?.[k]).toHaveLength(6)
    m.dispose()
  })

  it('builds joint commands clamped to the limits and high-level commands with gait and height', () => {
    const { m } = make()
    m.sim.jointOverride[0] = 3
    m.setControl('dir', 'f')
    run(m, 0.5)
    const j = m.buildCommand('joint')
    expect(j.q).toHaveLength(18)
    expect(j.q?.[0]).toBe(JOINT_LIMITS_DEG[0][1])
    j.q?.forEach((v, i) => {
      expect(v).toBeGreaterThanOrEqual(JOINT_LIMITS_DEG[i % 3][0])
      expect(v).toBeLessThanOrEqual(JOINT_LIMITS_DEG[i % 3][1])
    })
    const h = m.buildCommand('high')
    expect(h.v).toHaveLength(3)
    expect(h.v?.[0]).toBeGreaterThan(0)
    expect(h.mode).toBe('tripod')
    expect(h.h).toBeCloseTo(0.085, 4)
    m.dispose()
  })

  it('shows measured joint angles, loads and IMU tilt while fresh, then falls back to the sim after 500 ms', () => {
    const { m, clock } = make()
    const home = m.getHardwareSpec().homePose
    const ang = home.map((v, i) => (i === 4 ? v + 20 : v))
    m.applyTelemetry({ t: 'tel', ang, load: [0.2, 0.2, 0.2, 0.2, 0.2, 0], imu: [5, -3, 0] })
    run(m, 0.1, 'hardware', clock)
    expect(m.getTelemetry().readouts.pose).toBe('MEASURED')
    expect(m.sim.state.q[4]).toBeCloseTo(ang[4] * (Math.PI / 180), 9)
    expect(m.getTelemetry().bars[0]).toBeCloseTo(0.2 * m.sim.weight, 9)
    expect(m.sim.state.contact[5]).toBe(0)
    expect(Math.atan2(m.sim.state.bodyR[7], m.sim.state.bodyR[8])).toBeCloseTo(5 * (Math.PI / 180), 9)
    run(m, 0.6, 'hardware', clock)
    expect(m.getTelemetry().readouts.pose).toBe('SIM')
    m.dispose()
  })

  it('ignores malformed telemetry and lists one table row per leg', () => {
    const { m } = make()
    m.applyTelemetry({ t: 'tel', ang: [1, 2, Number.NaN], imu: [1, 2] as unknown as [number, number, number] })
    run(m, 0.1)
    expect(m.getTelemetry().readouts.pose).toBe('SIM')
    const table = m.telemetryTable(null)
    expect(table.cols).toEqual(['COXA °', 'FEMUR °', 'TIBIA °', 'LOAD N', 'CONTACT'])
    expect(table.rows.map((r) => r.label)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6'])
    expect(table.rows[0].cells[4]).toBe('DOWN')
    m.dispose()
  })
})

describe('WalkerModule CODE', () => {
  it('exposes the robot API with the documented sensors', () => {
    const { m } = make()
    const names = m.getSandboxApi().map((f) => f.name)
    expect(names).toEqual(['setJoint', 'setLeg', 'walk', 'stop', 'setGait', 'setBodyHeight', 'setBodyPose', 'readJoint', 'readLoad', 'readContact', 'readImu', 'legCount', 'jointCount'])
    const s = m.getSandboxSensors()
    expect(s.legs).toBe(6)
    expect(s.joints).toBe(18)
    expect(s.joint).toHaveLength(18)
    expect(s.load).toHaveLength(6)
    expect(s.contact).toHaveLength(6)
    expect(s.imu).toHaveLength(3)
    m.dispose()
  })

  it('applies setJoint, setLeg, walk, setGait, setBodyHeight and setBodyPose, and releases them', () => {
    const { m } = make()
    m.applySandboxCommands([
      { fn: 'setJoint', args: [1, 40] },
      { fn: 'setLeg', args: [3, 0.15, 0.2, -0.04] },
      { fn: 'walk', args: [0.05, 0, 0] },
      { fn: 'setGait', args: [1] },
      { fn: 'setBodyHeight', args: [0.1] },
      { fn: 'setBodyPose', args: [5, 0, 90] },
    ])
    run(m, 1, 'code')
    const s = m.getSandboxSensors()
    expect((s.joint as number[])[1]).toBeCloseTo(40, 1)
    expect((s.contact as number[])[3]).toBe(0)
    expect(m.sim.gait.id).toBe('ripple')
    expect(m.sim.pose.height).toBeCloseTo(0.1, 12)
    expect(m.sim.pose.yaw).toBeCloseTo(20 * (Math.PI / 180), 12)
    expect(m.sim.engine.frame[0]).toBeGreaterThan(0.02)
    m.releaseSandbox()
    run(m, 0.5, 'code')
    expect(Number.isNaN(m.sim.jointOverride[1])).toBe(true)
    expect(m.sim.pose.height).toBeCloseTo(0.085, 9)
    expect(m.sim.pose.yaw).toBe(0)
    m.dispose()
  })

  it('rejects malformed commands from the worker', () => {
    const { m } = make()
    m.applySandboxCommands([
      { fn: 'setJoint', args: [99, 10] },
      { fn: 'setJoint', args: [1.5, 10] },
      { fn: 'setLeg', args: [0, 5, 0, 0] },
      { fn: 'walk', args: [Number.NaN, 0, 0] },
      { fn: 'eval', args: [] },
    ] as never)
    expect(Array.from(m.sim.jointOverride).every(Number.isNaN)).toBe(true)
    expect(Array.from(m.sim.legOverride).every(Number.isNaN)).toBe(true)
    m.dispose()
  })
})

describe('WalkerModule replay and profiles', () => {
  it('restores a snapshot exactly and ignores one recorded with another leg count', () => {
    const { m } = make()
    m.setControl('dir', 'f')
    run(m, 1)
    const snap = m.snapshot()
    const pos = Array.from(m.sim.state.bodyPos)
    const q = Array.from(m.sim.state.q.subarray(0, 18))
    run(m, 1)
    m.restore(structuredClone(snap))
    m.update(0, { source: 'sim', t: 0 })
    for (let k = 0; k < 3; k++) expect(m.sim.state.bodyPos[k]).toBeCloseTo(pos[k], 12)
    for (let j = 0; j < 18; j++) expect(m.sim.state.q[j]).toBeCloseTo(q[j], 12)
    m.setControl('legs', '4')
    const before = Array.from(m.sim.state.bodyPos)
    m.restore(snap)
    expect(Array.from(m.sim.state.bodyPos)).toEqual(before)
    m.restore({ v: 1, body: 'x' })
    m.dispose()
  })

  it('round-trips dimensions and custom actuator values through serializeConfig / loadConfig', () => {
    const a = make().m
    a.setControl('femur', 0.09)
    a.setControl('actuator', 'custom')
    a.setControl('actBacklash', 2)
    const cfg = JSON.parse(JSON.stringify(a.serializeConfig())) as unknown
    const b = make().m
    b.setControl('actuator', 'custom')
    b.loadConfig(cfg)
    expect(b.sim.layout.dims.femur).toBe(0.09)
    expect(b.getControlValues().femur).toBe(0.09)
    expect(b.sim.actuator.backlash).toBeCloseTo(2 * (Math.PI / 180), 12)
    // garbage and out-of-range values cannot break it
    b.loadConfig({ v: 2 })
    b.loadConfig({ v: 1, dims: { femur: 5, tibia: 'x' } })
    expect(b.sim.layout.dims.femur).toBe(0.12)
    a.dispose()
    b.dispose()
  })
})

describe('WalkerModule DYNAMIC', () => {
  it('lazy-loads Rapier, runs the physics body, respawns and switches back', async () => {
    const { m } = make()
    m.setControl('actuator', 'mg996r')
    m.setControl('physics', 'dynamic')
    expect(m.getTelemetry().readouts.physics).toBe('INITIALIZING PHYSICS')
    expect((def(m, 'treadmill') as { disabled?: boolean }).disabled).toBe(true)
    expect(await m.physicsReady()).toBe(true)
    run(m, 1)
    const tel = m.getTelemetry()
    expect(tel.readouts.pose).toBe('PHYSICS')
    expect(String(tel.readouts.physics)).toMatch(/^DYNAMIC/)
    expect(tel.bars.reduce((a, b) => a + b, 0)).toBeGreaterThan(0.8 * m.sim.weight)
    m.setControl('respawn', true)
    run(m, 0.2)
    expect(Math.abs(m.sim.state.bodyPos[0])).toBeLessThan(0.02)
    m.setControl('physics', 'kinematic')
    run(m, 0.1)
    expect(m.getTelemetry().readouts.physics).toBe('KINEMATIC')
    m.dispose()
  })

  it('falls back to KINEMATIC with a message when the physics engine fails to load', async () => {
    const m = new WalkerModule({ loadPhysics: () => Promise.reject(new Error('no wasm')) })
    m.setControl('physics', 'dynamic')
    expect(await m.physicsReady()).toBe(false)
    expect(m.getControlValues().physics).toBe('kinematic')
    expect(String(m.getTelemetry().readouts.physics)).toContain('PHYSICS FAILED: no wasm')
    run(m, 0.2)
    expect(m.getTelemetry().readouts.pose).toBe('SIM')
    m.dispose()
  })
})

describe('WalkerModule dispose', () => {
  it('frees everything once and ignores later calls', () => {
    const { m } = make()
    m.dispose()
    expect(m.root.children).toHaveLength(0)
    m.dispose()
    m.update(DT, { source: 'sim', t: 0 })
    m.setControl('legs', '4')
    expect(m.sim.n).toBe(6)
  })
})
