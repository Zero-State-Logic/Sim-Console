import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { PointerEvt, StepContext } from '../../core/types'
import { entry } from './index'
import { LAYOUT } from './schema'
import { SweeperModule } from './SweeperModule'

const SIM: StepContext = { source: 'sim', t: 0 }
const FRAME = 1 / 60

function run(m: SweeperModule, seconds: number, ctx: StepContext = SIM): void {
  for (let i = 0; i < Math.round(seconds / FRAME); i++) m.update(FRAME, ctx)
}

/** A pointer event whose ray points straight down at plan (x, y). */
function pointer(type: PointerEvt['type'], x: number, y: number, mods: Partial<PointerEvt> = {}): PointerEvt {
  const raycaster = new THREE.Raycaster(new THREE.Vector3(x, 5, -y), new THREE.Vector3(0, -1, 0))
  return { type, button: 0, shiftKey: false, ctrlKey: false, altKey: false, raycaster, ground: new THREE.Vector3(x, 0, -y), ...mods }
}

describe('registry entry', () => {
  it('creates a sweeper module with a scene graph', () => {
    // Act
    const m = entry.create()
    // Assert
    expect(entry.kind).toBe('sweeper')
    expect(m.kind).toBe('sweeper')
    expect(m.root.children.length).toBeGreaterThan(0)
    expect(m.world.cameraPresets[0].id).toBe('iso')
    m.dispose()
  })
})

describe('telemetry', () => {
  it('fills every gauge, channel, bar and readout of the layout', () => {
    const m = new SweeperModule()
    run(m, 0.5)
    const tel = m.getTelemetry()
    for (const g of LAYOUT.gauges) expect(Number.isFinite(tel.gauges[g.key])).toBe(true)
    for (const c of LAYOUT.charts) for (const ch of c.channels) expect(Number.isFinite(tel.channels[ch.key])).toBe(true)
    expect(tel.bars).toHaveLength(LAYOUT.bars?.labels.length ?? 0)
    for (const r of LAYOUT.readouts) expect(tel.readouts[r.key]).toBeDefined()
    expect(tel.channels.minRange).toBeGreaterThan(0)
    m.dispose()
  })

  it('sweeps coverage and maps the room while running COVERAGE', () => {
    const m = new SweeperModule()
    run(m, 8)
    const tel = m.getTelemetry()
    expect(tel.gauges.coverage).toBeGreaterThan(0.5)
    expect(tel.readouts.known as number).toBeGreaterThan(20)
    expect(m.sim.bumps).toBe(0)
    m.dispose()
  })
})

describe('reset', () => {
  it('puts the robot back at the start with a fresh map and coverage, keeping the room', () => {
    // Arrange
    const m = new SweeperModule()
    const start = { ...m.sim.pose }
    const obstacles = m.sim.obstacles
    run(m, 4)
    // Act
    m.reset()
    m.update(0, SIM)
    // Assert
    expect(m.sim.pose).toEqual(start)
    expect(m.sim.coverage.coveredCount).toBe(0)
    expect(m.sim.grid.knownFraction(m.sim.half)).toBe(0)
    expect(m.sim.obstacles).toBe(obstacles)
    expect(m.getInstrumentLayout()).toBe(LAYOUT)
    m.dispose()
  })
})

describe('controls', () => {
  it('clamps sliders, rejects unknown options and wrong types', () => {
    const m = new SweeperModule()
    m.setControl('maxSpeed', 9)
    m.setControl('mode', 'fly')
    m.setControl('showMap', 'yes')
    const v = m.getControlValues()
    expect(v.maxSpeed).toBe(0.6)
    expect(m.sim.params.maxSpeed).toBe(0.6)
    expect(v.mode).toBe('coverage')
    expect(v.showMap).toBe(true)
    m.dispose()
  })

  it('switches to TELEOP when a drive key is pressed and drives forward', () => {
    const m = new SweeperModule()
    const x0 = m.sim.pose.x
    m.setControl('dir', 'f')
    run(m, 1)
    expect(m.getControlValues().mode).toBe('teleop')
    expect(m.sim.pose.x - x0).toBeGreaterThan(0.15)
    m.dispose()
  })

  it('keeps the program in charge of the wheels in CODE when a drive key is pressed', () => {
    const m = new SweeperModule()
    m.update(FRAME, { source: 'code', t: 0 })
    m.setControl('dir', 'f')
    expect(m.getControlValues().mode).toBe('coverage')
    m.dispose()
  })

  it('rebuilds the room and scales the camera presets with ARENA SIZE', () => {
    const m = new SweeperModule()
    const iso6 = m.world.cameraPresets[0].position[0]
    m.setControl('arena', 9)
    expect(m.sim.size).toBe(9)
    expect(m.world.cameraPresets[0].position[0]).toBeCloseTo(iso6 * 1.5)
    for (const o of m.sim.obstacles) expect(Math.abs(o.x)).toBeLessThan(4.5)
    m.dispose()
  })

  it('enables REMOVE SELECTED only while an obstacle is selected', () => {
    const m = new SweeperModule()
    const removeSel = () => m.getControlSchema().find((d) => d.key === 'removeSel')
    expect(removeSel()?.disabled).toBe(true)
    const rev = m.revision
    m.setControl('addBox', true)
    expect(removeSel()?.disabled).toBeFalsy()
    expect(m.revision).toBeGreaterThan(rev)
    m.dispose()
  })
})

describe('arena editing', () => {
  it('adds, removes, randomizes and clears obstacles in the sim and the LiDAR scene', () => {
    const m = new SweeperModule()
    const n = m.sim.obstacles.length
    m.setControl('addCyl', true)
    expect(m.sim.obstacles).toHaveLength(n + 1)
    m.setControl('removeSel', true)
    expect(m.sim.obstacles).toHaveLength(n)
    m.setControl('randomize', true)
    expect(m.sim.obstacles.length).toBeGreaterThan(3)
    m.setControl('clear', true)
    expect(m.sim.obstacles).toHaveLength(0)
    expect(m.sim.scene.count).toBe(0)
    m.dispose()
  })

  it('drags an obstacle with the pointer and consumes the events', () => {
    // Arrange: one cylinder in an otherwise empty room
    const m = new SweeperModule()
    m.setControl('clear', true)
    m.loadConfig({ size: 6, obstacles: [{ kind: 'cyl', x: 0.5, y: 0.5, r: 0.2, hgt: 0.5 }] })
    run(m, FRAME)
    // Act
    const down = m.onPointer(pointer('down', 0.5, 0.5))
    const move = m.onPointer(pointer('move', 1.2, 0.8))
    const up = m.onPointer(pointer('up', 1.2, 0.8))
    // Assert
    expect([down, move, up]).toEqual([true, true, true])
    expect(m.sim.obstacles[0].x).toBeCloseTo(1.2, 5)
    expect(m.sim.obstacles[0].y).toBeCloseTo(0.8, 5)
    m.dispose()
  })

  it('never drops a dragged obstacle onto the robot', () => {
    const m = new SweeperModule()
    m.loadConfig({ size: 6, obstacles: [{ kind: 'box', x: 0, y: -1.5, w: 0.4, h: 0.4, a: 0, hgt: 0.5 }] })
    run(m, FRAME)
    const { x, y } = m.sim.pose
    m.onPointer(pointer('down', 0, -1.5))
    m.onPointer(pointer('move', x, y))
    m.onPointer(pointer('up', x, y))
    const o = m.sim.obstacles[0]
    expect(Math.hypot(o.x - x, o.y - y)).toBeGreaterThan(0.3)
    m.dispose()
  })

  it('leaves a click on empty floor to the orbit camera outside GOTO', () => {
    const m = new SweeperModule()
    m.setControl('clear', true)
    expect(m.onPointer(pointer('down', 1, 1))).toBe(false)
    m.dispose()
  })
})

describe('GOTO goals', () => {
  it('sets a goal with a floor click in GOTO mode and drives to it', () => {
    const m = new SweeperModule()
    m.setControl('clear', true)
    m.setControl('mode', 'goto')
    expect(m.onPointer(pointer('down', 1, 1))).toBe(true)
    m.onPointer(pointer('up', 1, 1))
    run(m, 18)
    expect(Math.hypot(m.sim.pose.x - 1, m.sim.pose.y - 1)).toBeLessThan(0.1)
    m.dispose()
  })

  it('switches to GOTO on a shift-click in another mode', () => {
    const m = new SweeperModule()
    m.setControl('clear', true)
    const rev = m.revision
    m.onPointer(pointer('down', -1, 1, { shiftKey: true }))
    m.onPointer(pointer('up', -1, 1, { shiftKey: true }))
    expect(m.getControlValues().mode).toBe('goto')
    expect(m.sim.nav.goalX).toBeCloseTo(-1)
    expect(m.revision).toBeGreaterThan(rev)
    m.dispose()
  })
})

describe('record and profiles', () => {
  it('restores pose, wheels and the coverage figure from a snapshot', () => {
    const m = new SweeperModule()
    run(m, 2)
    const snap = m.snapshot()
    const pose = { ...m.sim.pose }
    run(m, 2)
    m.restore(structuredClone(snap))
    m.update(0, SIM)
    expect(m.sim.pose).toEqual(pose)
    expect(m.getTelemetry().gauges.coverage).toBe((snap as { cov: number }).cov)
    m.restore({ x: 'nope' })
    expect(m.sim.pose).toEqual(pose)
    m.dispose()
  })

  it('round-trips the arena through serializeConfig / loadConfig', () => {
    const a = new SweeperModule()
    a.setControl('arena', 7)
    a.setControl('addBox', true)
    const cfg = JSON.parse(JSON.stringify(a.serializeConfig()))
    const b = new SweeperModule()
    b.loadConfig(cfg)
    expect(b.sim.size).toBe(7)
    expect(b.getControlValues().arena).toBe(7)
    expect(b.sim.obstacles.map((o) => o.kind)).toEqual(a.sim.obstacles.map((o) => o.kind))
    // the config keeps millimetres: rounding moves a center by at most half of one
    b.sim.obstacles.forEach((o, i) => {
      expect(Math.abs(o.x - a.sim.obstacles[i].x)).toBeLessThanOrEqual(0.0005 + 1e-9)
      expect(Math.abs(o.y - a.sim.obstacles[i].y)).toBeLessThanOrEqual(0.0005 + 1e-9)
    })
    expect(() => b.loadConfig({ size: 'big' })).toThrow()
    a.dispose()
    b.dispose()
  })
})

describe('HARDWARE source', () => {
  const HW: StepContext = { source: 'hardware', t: 0 }

  it('declares 4 wheels, joint level wired and high level wireless', () => {
    const m = new SweeperModule()
    const spec = m.getHardwareSpec()
    expect(spec.joints).toBe(4)
    expect(spec.wheels).toBe(4)
    expect(spec.defaultLevel).toEqual({ wired: 'joint', wireless: 'high' })
    expect(Object.keys(spec.geometry ?? {})).toEqual(['wheelRadius', 'halfLength', 'halfWidth', 'maxWheelSpeed'])
    m.dispose()
  })

  it('anchors the board odometry where the twin stands and follows it', () => {
    // Arrange
    const m = new SweeperModule()
    const start = { ...m.sim.pose }
    // Act: board reports from its own origin, then 0.5 m forward
    m.applyTelemetry({ t: 'tel', pose: [0, 0, 0], enc: [0, 0, 0, 0] })
    m.update(FRAME, HW)
    m.applyTelemetry({ t: 'tel', pose: [0.5, 0, 0], enc: [5, 5, 5, 5] })
    m.update(FRAME, HW)
    // Assert
    expect(m.sim.pose.x).toBeCloseTo(start.x + 0.5, 1)
    expect(m.sim.pose.y).toBeCloseTo(start.y, 2)
    expect(m.getTelemetry().channels.wFL).toBeCloseTo(5)
    m.dispose()
  })

  it('stays in HARDWARE when the recorder re-poses it with a dt = 0 sim update', () => {
    const m = new SweeperModule()
    m.applyTelemetry({ t: 'tel', pose: [0, 0, 0] })
    m.update(FRAME, HW)
    m.update(0, SIM)
    expect(m.sim.external).toBe(true)
    m.dispose()
  })

  it('stands still when the board goes silent', () => {
    const m = new SweeperModule()
    m.applyTelemetry({ t: 'tel', enc: [10, 10, 10, 10] })
    run(m, 1, HW)
    expect(Array.from(m.sim.wheel)).toEqual([0, 0, 0, 0])
    expect(m.getTelemetry().readouts.status).toBe('HW · NO TELEMETRY')
    m.dispose()
  })

  it('draws and maps a real LiDAR scan instead of the simulated one', () => {
    const m = new SweeperModule()
    m.setControl('resetMap', true)
    const r = Array.from({ length: 360 }, () => 1.5)
    m.applyTelemetry({ t: 'tel', scan: { a0: 0, da: 1, r } })
    expect(m.sim.simLidar).toBe(false)
    expect(m.sim.lidar.bins[90]).toBeCloseTo(1.5)
    expect(m.sim.grid.version).toBeGreaterThan(0)
    m.dispose()
  })

  it('never mixes stale virtual-room ranges into a real 4-degree scan', () => {
    // Arrange: the simulated LD06 has scanned the virtual room (walls 0.5 m away)
    const m = new SweeperModule()
    run(m, 0.3, SIM)
    expect(m.sim.lidar.minRange()).toBeLessThan(1)
    // Act: the firmware's 90-bin scan of a real room 3.5 m away all round
    m.applyTelemetry({ t: 'tel', scan: { a0: 2, da: 4, r: Array.from({ length: 90 }, () => 3.5) } })
    // Assert: every bin, the min range and the clearance come from the real scan
    expect(Array.from(m.sim.lidar.bins).every((r) => Math.abs(r - 3.5) < 1e-6)).toBe(true)
    expect(m.sim.lidar.minRange()).toBeCloseTo(3.5, 6)
    expect(m.getSandboxSensors().minRange).toBeCloseTo(3.5, 6)
    m.dispose()
  })

  it('streams wheel speeds at joint level and the twist + mode at high level', () => {
    const m = new SweeperModule()
    m.setControl('dir', 'f')
    run(m, 0.5, HW)
    const joint = m.buildCommand('joint')
    const high = m.buildCommand('high')
    expect(joint.w).toHaveLength(4)
    expect(joint.w?.[0]).toBeGreaterThan(0)
    expect(high.v?.[0]).toBeGreaterThan(0)
    expect(high.mode).toBe('teleop')
    const table = m.telemetryTable({ t: 'tel', enc: [1, 2, 3, 4] })
    expect(table.rows.map((row) => row.label)).toEqual(['FL', 'FR', 'RL', 'RR'])
    expect(table.rows[3].cells[1]).toBe(4)
    m.dispose()
  })
})

describe('CODE source', () => {
  const CODE: StepContext = { source: 'code', t: 0 }

  it('waits for the program, then follows drive() commands', () => {
    const m = new SweeperModule()
    const x0 = m.sim.pose.x
    run(m, 0.5, CODE)
    expect(Math.abs(m.sim.pose.x - x0)).toBeLessThan(1e-6)
    m.applySandboxCommands([{ fn: 'drive', args: [0.3, 0, 0] }])
    run(m, 1, CODE)
    expect(m.sim.pose.x - x0).toBeGreaterThan(0.15)
    m.dispose()
  })

  it('keeps a program\'s very first drive() that arrives before the first CODE frame', () => {
    const m = new SweeperModule()
    const x0 = m.sim.pose.x
    m.applySandboxCommands([{ fn: 'drive', args: [0.3, 0, 0] }])
    run(m, 1, CODE)
    expect(m.sim.pose.x - x0).toBeGreaterThan(0.15)
    m.dispose()
  })

  it('answers the sensor names the sandbox API declares', () => {
    const m = new SweeperModule()
    run(m, 0.2, CODE)
    const sensors = m.getSandboxSensors()
    for (const fn of m.getSandboxApi()) if (fn.kind === 'query' && fn.sensor) expect(sensors[fn.sensor]).toBeDefined()
    expect(sensors.lidar).toHaveLength(360)
    m.dispose()
  })

  it('mirrors setMode() in the control values and hands back on release', () => {
    const m = new SweeperModule()
    run(m, FRAME, CODE)
    m.applySandboxCommands([{ fn: 'setMode', args: [3] }])
    expect(m.getControlValues().mode).toBe('wander')
    m.applySandboxCommands([{ fn: 'setWheels', args: [1, 1, 1, 1] }])
    m.releaseSandbox()
    expect(m.sim.drive).toBe('nav')
    m.dispose()
  })
})
