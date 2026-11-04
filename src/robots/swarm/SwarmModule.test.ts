import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { DriveSource, PointerEvt } from '../../core/types'
import type { TelMsg } from '../../core/protocol'
import { SwarmModule } from './SwarmModule'
import { entry } from './index'
import { simDroneTel } from './hardwareIO'

const FRAME = 1 / 60

function run(m: SwarmModule, seconds: number, source: DriveSource = 'sim'): void {
  const n = Math.round(seconds / FRAME)
  for (let i = 0; i < n; i++) m.update(FRAME, { source, t: i * FRAME })
}

function flying(seconds = 8): SwarmModule {
  const m = new SwarmModule()
  m.setControl('wind', false)
  m.setControl('takeoff', true)
  run(m, seconds)
  return m
}

/** Pointer event whose ray runs from a camera at (cx, 20, cz) straight down onto three.js (X, 0, Z). */
function pointer(type: PointerEvt['type'], X: number, Z: number, shiftKey = false): PointerEvt {
  const raycaster = new THREE.Raycaster(new THREE.Vector3(X, 20, Z), new THREE.Vector3(0, -1, 0))
  return { type, button: 0, shiftKey, ctrlKey: false, altKey: false, raycaster, ground: new THREE.Vector3(X, 0, Z) }
}

/** Telemetry for every drone of `src`, as a real swarm would send it. */
function telFrom(src: SwarmModule): TelMsg {
  return { t: 'tel', ms: 1000, drones: simDroneTel(src.simulation) }
}

describe('SwarmModule contract', () => {
  it('is registered as the swarm entry and starts landed with a square route', () => {
    // Act
    const m = entry.create() as SwarmModule
    // Assert
    expect(entry.kind).toBe('swarm')
    expect(m.kind).toBe('swarm')
    expect(m.simulation.count).toBe(4)
    expect(m.simulation.drones.every((d) => d.mode === 'landed')).toBe(true)
    expect(m.simulation.wpCount).toBe(4)
    expect(m.world.cameraPresets.map((p) => p.id)).toEqual(['iso', 'front', 'side', 'top'])
    expect(m.root.children.length).toBeGreaterThan(0)
  })

  it('publishes a telemetry frame carrying every key its instrument layout declares', () => {
    // Arrange
    const m = flying(3)
    const layout = m.getInstrumentLayout()
    // Act
    const f = m.getTelemetry()
    // Assert
    for (const g of layout.gauges) expect(Number.isFinite(f.gauges[g.key])).toBe(true)
    for (const c of layout.charts) for (const ch of c.channels) expect(Number.isFinite(f.channels[ch.key])).toBe(true)
    for (const r of layout.readouts) expect(f.readouts[r.key]).toBeDefined()
    expect(f.bars).toHaveLength(layout.bars?.labels.length ?? -1)
  })

  it('validates control values: sliders clamp, bad options and unknown keys are ignored', () => {
    // Arrange
    const m = new SwarmModule()
    // Act
    m.setControl('spacing', 99)
    m.setControl('shape', 'blob')
    m.setControl('drones', '9')
    m.setControl('nonsense', 1)
    // Assert
    const v = m.getControlValues()
    expect(v.spacing).toBe(4)
    expect(m.simulation.settings.spacing).toBe(4)
    expect(v.shape).toBe('wedge')
    expect(m.simulation.count).toBe(4)
    expect(v.nonsense).toBeUndefined()
  })

  it('restores the tuned gains with DEFAULT GAINS', () => {
    const m = new SwarmModule()
    m.setControl('posP', 3.5)
    expect(m.simulation.settings.gains.posP).toBe(3.5)
    m.setControl('resetGains', true)
    expect(m.getControlValues().posP).toBe(1.3)
    expect(m.simulation.settings.gains.posP).toBe(1.3)
  })
})

describe('SwarmModule mission', () => {
  it('TAKEOFF climbs the fleet to the cruise altitude and flies the route in formation', () => {
    // Arrange
    const m = flying(10)
    const sim = m.simulation
    let formation = 0
    let minSep = Infinity
    let maxLeaderSpeed = 0
    const frames = 240
    // Act: four more seconds of mission, sampled like the instruments do
    for (let i = 0; i < frames; i++) {
      m.update(FRAME, { source: 'sim', t: 10 + i * FRAME })
      const f = m.getTelemetry()
      formation += f.gauges.formation / frames
      minSep = Math.min(minSep, f.readouts.minSep as number)
      maxLeaderSpeed = Math.max(maxLeaderSpeed, f.readouts.leaderSpeed as number)
    }
    // Assert
    expect(sim.phase).toBe('mission')
    for (const d of sim.drones) expect(Math.abs(d.s[2] - 3)).toBeLessThan(0.5)
    expect(formation).toBeGreaterThan(60)
    expect(minSep).toBeGreaterThan(2 * sim.orca.radius)
    expect(maxLeaderSpeed).toBeGreaterThan(1)
    expect(m.getTelemetry().readouts.wp).toMatch(/^\d\/4$/)
    // the follow target is the leader drawn at s + v·renderLead (render extrapolation)
    const l = sim.leader
    expect(m.followTarget().y).toBeCloseTo(l ? l.s[2] + l.s[5] * sim.renderLead : -1, 9)
    expect(sim.renderLead).toBeLessThanOrEqual(1 / sim.settings.physicsHz)
  })

  it('rebuilds the fleet when DRONES changes and bumps the revision', () => {
    // Arrange
    const m = new SwarmModule()
    const rev = m.revision
    // Act
    m.setControl('drones', '6')
    // Assert
    expect(m.revision).toBe(rev + 1)
    expect(m.simulation.count).toBe(6)
    expect(m.getInstrumentLayout().charts[0].channels).toHaveLength(6)
    expect(m.getTelemetry().bars).toHaveLength(6)
    expect(m.getHardwareSpec().joints).toBe(6)
    expect(m.getControlValues().drones).toBe('6')
    expect(m.getControlSchema().find((d) => d.key === 'drones')?.type).toBe('select')
  })

  it('LAND then RESET puts every drone back on its pad', () => {
    const m = flying(6)
    m.setControl('land', true)
    run(m, 10)
    expect(m.simulation.drones.every((d) => d.mode === 'landed')).toBe(true)
    m.setControl('reset', true)
    expect(m.simulation.phase).toBe('idle')
    expect(m.simulation.drones.every((d) => d.battery.percent === 100)).toBe(true)
  })
})

describe('SwarmModule record/replay and profiles', () => {
  it('restores a JSON-cloned snapshot exactly, including attitude and prop speeds', () => {
    // Arrange
    const m = flying(4)
    const snap = JSON.parse(JSON.stringify(m.snapshot()))
    // JSON turns -0 into 0; compare values, not signed zeros
    const state = (): number[][] => m.simulation.drones.map((d) => [...d.s, ...d.omega].map((v) => v + 0))
    const before = state()
    run(m, 2)
    // Act
    m.restore(snap)
    // Assert
    expect(state()).toEqual(before)
  })

  it('ignores a snapshot that is not a swarm snapshot', () => {
    const m = flying(2)
    const z = m.simulation.drones[0].s[2]
    m.restore({ v: 1, n: 4, s: 'nope' })
    expect(m.simulation.drones[0].s[2]).toBe(z)
  })

  it('round-trips waypoints and formation settings through a profile', () => {
    // Arrange
    const a = new SwarmModule()
    a.setControl('shape', 'column')
    a.setControl('spacing', 3.2)
    a.setControl('cruiseAlt', 5)
    a.setControl('routeMode', 'pingpong')
    a.simulation.addWaypoint(1, -2)
    const b = new SwarmModule()
    // Act
    b.loadConfig(JSON.parse(JSON.stringify(a.serializeConfig())))
    // Assert
    expect(b.serializeConfig()).toEqual(a.serializeConfig())
    expect(b.getControlValues().shape).toBe('column')
    expect(b.simulation.settings.cruiseAlt).toBe(5)
  })

  it('throws on a config that is not a swarm config, and treats null as nothing to load', () => {
    const m = new SwarmModule()
    expect(() => m.loadConfig('junk')).toThrow()
    expect(() => m.loadConfig({ v: 9 })).toThrow()
    expect(() => m.loadConfig(null)).not.toThrow()
    expect(m.simulation.wpCount).toBe(4)
  })
})

describe('SwarmModule CODE source', () => {
  it('lets user code fly a drone to a world point and read it back', () => {
    // Arrange
    const m = new SwarmModule()
    m.setControl('wind', false)
    // Act
    m.applySandboxCommands([{ fn: 'setTarget', args: [0, 2, 4, -3] }])
    run(m, 8, 'code')
    // Assert
    const s = m.getSandboxSensors()
    expect((s.posX as number[])[0]).toBeCloseTo(2, 1)
    expect((s.posY as number[])[0]).toBeCloseTo(4, 1)
    expect((s.posZ as number[])[0]).toBeCloseTo(-3, 1)
    expect(s.drones).toBe(4)
    expect(m.getSandboxApi().map((f) => f.name)).toContain('readBattery')
  })

  it('mirrors setFormation into the SHAPE control and hands drones back on release', () => {
    const m = new SwarmModule()
    const rev = m.revision
    m.applySandboxCommands([{ fn: 'setTarget', args: [1, 0, 2, 0] }, { fn: 'setFormation', args: [4] }, { fn: 'setTarget', args: [2, 0, 2, 0] }])
    expect(m.getControlValues().shape).toBe('column')
    expect(m.revision).toBeGreaterThan(rev)
    expect(m.simulation.drones[2].manual).toBe(true)
    m.releaseSandbox()
    expect(m.simulation.drones.some((d) => d.manual)).toBe(false)
  })
})

describe('SwarmModule HARDWARE source', () => {
  it('sends no setpoint to a real drone before it has reported, even on the first call', () => {
    // Arrange: a fresh module that has only ever run under SIM
    const m = new SwarmModule()
    run(m, 0.5)
    // Act: the bridge asks for a command before this frame's update
    const cmd = m.buildCommand('high')
    // Assert
    expect(cmd.sp).toEqual([])
    expect(cmd.mode).toBe('idle')
  })

  it('mirrors real drones, then sends mission setpoints in the wire frame', () => {
    // Arrange: real drones hovering where a reference sim has them
    const ref = flying(6)
    const m = new SwarmModule()
    m.applyTelemetry(telFrom(ref))
    // Act
    m.setControl('takeoff', true)
    for (let i = 0; i < 60; i++) {
      m.applyTelemetry(telFrom(ref))
      m.update(FRAME, { source: 'hardware', t: i * FRAME })
    }
    const cmd = m.buildCommand('high')
    // Assert
    expect(m.simulation.drones[1].s[2]).toBeCloseTo(ref.simulation.drones[1].s[2], 9)
    expect(cmd.sp).toHaveLength(4)
    for (const sp of cmd.sp ?? []) {
      expect(sp.p.every(Number.isFinite)).toBe(true)
      expect(sp.p[1]).toBeGreaterThan(2)
    }
    expect(m.getTelemetry().readouts.phase).toMatch(/· HW$/)
    expect(m.telemetryTable(telFrom(ref)).rows).toHaveLength(4)
  })

  it('stays in the mirror while the recorder re-poses it with dt = 0 under source sim', () => {
    // Arrange
    const ref = flying(6)
    const m = new SwarmModule()
    m.applyTelemetry(telFrom(ref))
    m.setControl('takeoff', true)
    m.update(FRAME, { source: 'hardware', t: 0 })
    const snap = m.snapshot()
    // Act: replay scrub (restore + dt = 0 update as 'sim'), then live again
    m.restore(snap)
    m.update(0, { source: 'sim', t: 0 })
    m.applyTelemetry(telFrom(ref))
    m.update(FRAME, { source: 'hardware', t: FRAME })
    // Assert: the mission was not stood down by a phantom source switch
    expect(m.simulation.drones.every((d) => d.armed)).toBe(true)
    expect(m.buildCommand('high').sp).toHaveLength(4)
  })

  it('reads the battery percent from telemetry and lands real drones onto the ground', () => {
    const ref = flying(6)
    const m = new SwarmModule()
    const tel = telFrom(ref)
    for (const d of tel.drones ?? []) d.bat = 25
    m.applyTelemetry(tel)
    m.setControl('takeoff', true)
    m.update(FRAME, { source: 'hardware', t: 0 })
    m.setControl('land', true)
    m.update(FRAME, { source: 'hardware', t: FRAME })
    expect(m.getTelemetry().gauges.battery).toBeCloseTo(25, 9)
    expect(m.telemetryTable(tel).rows[0].cells[6]).toBe(25)
    for (const sp of m.buildCommand('high').sp ?? []) expect(sp.p[1]).toBe(0)
  })
})

describe('SwarmModule pointer and scene', () => {
  it('drops a waypoint on a ground click without locking the camera on pointer down', () => {
    // Arrange
    const m = new SwarmModule()
    m.setControl('clearWp', true)
    // Act
    const down = m.onPointer(pointer('down', 3, -4))
    const up = m.onPointer(pointer('up', 3, -4))
    // Assert
    expect(down).toBe(false)
    expect(up).toBe(true)
    expect(m.serializeConfig()).toMatchObject({ waypoints: [[3, -4]] })
  })

  it('consumes a marker grab so the shell locks the orbit, and moves the marker on drag', () => {
    const m = new SwarmModule()
    m.setControl('clearWp', true)
    m.onPointer(pointer('down', 2, 2))
    m.onPointer(pointer('up', 2, 2))
    expect(m.onPointer(pointer('down', 2, 2))).toBe(true)
    m.onPointer(pointer('move', -5, 1))
    m.onPointer(pointer('up', -5, 1))
    expect(m.serializeConfig()).toMatchObject({ waypoints: [[-5, 1]] })
  })

  it('follows the fleet centroid while nobody leads, and disposes its scene', () => {
    const m = new SwarmModule()
    const c = m.followTarget()
    expect(c.x).toBeCloseTo(0, 9)
    expect(c.z).toBeCloseTo(1.5, 9)
    m.dispose()
    expect(m.root.children).toHaveLength(0)
  })
})
