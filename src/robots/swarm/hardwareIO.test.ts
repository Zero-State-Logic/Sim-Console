import { describe, expect, it } from 'vitest'
import type { TelMsg } from '../../core/protocol'
import {
  CELL_MAX_V,
  applySwarmTelemetry,
  batteryPercent,
  buildSwarmCommand,
  cellPercent,
  hardwareSpec,
  simDroneTel,
  swarmTable,
} from './hardwareIO'
import { SwarmSim, defaultSettings } from './sim/swarmSim'

function sim(n = 4): SwarmSim {
  return new SwarmSim(n, defaultSettings())
}

describe('swarm hardware spec', () => {
  it('declares one joint per drone, high-level setpoints on every transport and the firmware geometry', () => {
    // Arrange
    const s = sim(5)
    // Act
    const spec = hardwareSpec(s)
    // Assert
    expect(spec.robot).toBe('swarm')
    expect(spec.joints).toBe(5)
    expect(spec.drones).toBe(5)
    expect(spec.jointNames).toEqual(['D1', 'D2', 'D3', 'D4', 'D5'])
    expect(spec.jointLimits).toHaveLength(5)
    expect(spec.homePose).toEqual([0, 0, 0, 0, 0])
    expect(spec.defaultLevel).toEqual({ wired: 'high', wireless: 'high' })
    expect(spec.geometry).toEqual({ armLength: 0.12, mass: 0.6, cruiseAlt: 3 })
  })
})

describe('battery on the wire', () => {
  it('reads the firmware percentage, clamped to 100', () => {
    expect(batteryPercent(25)).toBe(25)
    expect(batteryPercent(9)).toBe(9)
    expect(batteryPercent(100)).toBe(100)
    expect(batteryPercent(140)).toBe(100)
  })

  it('reads a Virtual Device cell voltage through the LiPo discharge curve', () => {
    expect(batteryPercent(4.2)).toBe(100)
    expect(batteryPercent(3.8)).toBeCloseTo(55, 9)
    expect(batteryPercent(3.77)).toBeCloseTo(47.5, 9)
    expect(batteryPercent(3.3)).toBe(0)
    expect(batteryPercent(3.1)).toBe(0)
    expect(batteryPercent(CELL_MAX_V)).toBe(100)
    expect(cellPercent(4)).toBeCloseTo(85, 9)
  })

  it('treats negative, non-finite and non-numeric readings as unknown', () => {
    expect(batteryPercent(-1)).toBeNaN()
    expect(batteryPercent(Number.NaN)).toBeNaN()
    expect(batteryPercent(Number.POSITIVE_INFINITY)).toBeNaN()
    expect(batteryPercent('80')).toBeNaN()
    expect(batteryPercent(undefined)).toBeNaN()
  })

  it('never reads a full virtual cell as a near-empty percentage (no false low-battery landing)', () => {
    // Arrange: every virtual drone reports a full 4.2 V cell
    const s = sim(3)
    const drones = s.drones.map((d) => ({ id: d.id, p: [0, 3, 0] as [number, number, number], att: [0, 0, 0] as [number, number, number], bat: 4.2 }))
    // Act
    applySwarmTelemetry(s, { t: 'tel', drones })
    // Assert
    for (const d of s.drones) expect(d.battery.percent).toBe(100)
  })
})

describe('outbound setpoints', () => {
  it('maps sim targets (REP-103, z up) to wire meters (y up) with yaw in degrees', () => {
    // Arrange
    const s = sim(3)
    s.takeoff()
    const d = s.drones[1]
    d.target.set([1.5, 2, 3])
    d.yawSp = Math.PI / 2
    // Act
    const cmd = buildSwarmCommand(s, false)
    // Assert
    expect(cmd.t).toBe('cmd')
    expect(cmd.mode).toBe('takeoff')
    expect(cmd.sp).toHaveLength(3)
    expect(cmd.sp?.[1]).toEqual({ id: 1, p: [1.5, 3, -2], yaw: 90 })
  })

  it('sends nothing for a mirrored drone until its first telemetry sample', () => {
    // Arrange
    const s = sim(4)
    s.enterMirror()
    s.mirrorDrone(2, 0, 0, 1, 0, 0, 0)
    // Act
    const cmd = buildSwarmCommand(s, true)
    // Assert
    expect(cmd.sp?.map((p) => p.id)).toEqual([2])
  })

  it('commands landing and parked drones down to the ground (y = 0) so a real board disarms', () => {
    // Arrange
    const s = sim(3)
    s.takeoff()
    s.drones[0].beginLanding()
    s.drones[0].target[2] = s.params.gearHeight
    s.drones[2].disarm()
    s.drones[2].target[2] = s.params.gearHeight
    s.drones[1].target[2] = 3
    // Act
    const sp = buildSwarmCommand(s, false).sp ?? []
    // Assert
    expect(sp[0].p[1]).toBe(0)
    expect(sp[1].p[1]).toBe(3)
    expect(sp[2].p[1]).toBe(0)
  })
})

describe('inbound telemetry', () => {
  it('mirrors wire positions and attitudes into the sim frame', () => {
    // Arrange
    const s = sim(3)
    const tel: TelMsg = { t: 'tel', drones: [{ id: 1, p: [2, 4, -3], att: [10, -5, 90], bat: 61.5 }] }
    // Act
    const applied = applySwarmTelemetry(s, tel)
    // Assert
    const st = s.drones[1].s
    expect(applied).toBe(1)
    expect([st[0], st[1], st[2]]).toEqual([2, 3, 4])
    expect(s.drones[1].battery.percent).toBeCloseTo(61.5, 9)
    expect(simDroneTel(s)[1].att[0]).toBeCloseTo(10, 6)
    expect(simDroneTel(s)[1].att[1]).toBeCloseTo(-5, 6)
    expect(simDroneTel(s)[1].att[2]).toBeCloseTo(90, 6)
  })

  it('round-trips the sim state through the wire format', () => {
    // Arrange: a flying swarm in gusty air, mirrored into a second sim
    const a = sim(4)
    a.takeoff()
    for (let i = 0; i < 300; i++) a.advance(1 / 60)
    const b = sim(4)
    // Act
    applySwarmTelemetry(b, { t: 'tel', drones: simDroneTel(a) })
    // Assert
    for (let i = 0; i < 4; i++) {
      for (let k = 0; k < 3; k++) expect(b.drones[i].s[k]).toBeCloseTo(a.drones[i].s[k], 9)
      // q and -q are the same rotation
      const dot = [6, 7, 8, 9].reduce((acc, k) => acc + a.drones[i].s[k] * b.drones[i].s[k], 0)
      expect(Math.abs(dot)).toBeCloseTo(1, 9)
      // the wire carries the charge to 0.1 %
      expect(Math.abs(b.drones[i].battery.percent - a.drones[i].battery.percent)).toBeLessThanOrEqual(0.05 + 1e-9)
    }
  })

  it('skips malformed, out-of-range and non-finite entries', () => {
    // Arrange
    const s = sim(3)
    const before = Array.from(s.drones[0].s)
    const drones = [
      { id: 0, p: [1, 1], att: [0, 0, 0] },
      { id: 0, p: [1, 1, 1] },
      { id: 7, p: [1, 1, 1], att: [0, 0, 0] },
      { id: 0.5, p: [1, 1, 1], att: [0, 0, 0] },
      { id: 0, p: [Number.NaN, 1, 1], att: [0, 0, 0] },
      'junk',
      null,
    ]
    // Act
    const applied = applySwarmTelemetry(s, { t: 'tel', drones } as unknown as TelMsg)
    // Assert
    expect(applied).toBe(0)
    expect(Array.from(s.drones[0].s)).toEqual(before)
    expect(applySwarmTelemetry(s, { t: 'tel' })).toBe(0)
  })

  it('holds a drone that reports its feet on the ground at gear height (no sinking)', () => {
    const s = sim(3)
    applySwarmTelemetry(s, { t: 'tel', drones: [{ id: 0, p: [0, 0, 0], att: [0, 0, 0] }] })
    expect(s.drones[0].s[2]).toBe(s.params.gearHeight)
  })
})

describe('telemetry table', () => {
  it('lists x, y, z, roll, pitch, yaw and battery per drone, with dashes for silent drones', () => {
    // Arrange
    const s = sim(3)
    const tel: TelMsg = { t: 'tel', drones: [{ id: 2, p: [1.234, 2.346, 3.456], att: [1.26, 2.34, -179.96], bat: 48.6 }] }
    // Act
    const table = swarmTable(s, tel)
    // Assert
    expect(table.cols).toEqual(['x', 'y', 'z', 'roll', 'pitch', 'yaw', 'battery'])
    expect(table.rows.map((r) => r.label)).toEqual(['D1', 'D2', 'D3'])
    expect(table.rows[0].cells).toEqual(['—', '—', '—', '—', '—', '—', '—'])
    expect(table.rows[2].cells).toEqual([1.23, 2.35, 3.46, 1.3, 2.3, -180, 49])
    expect(swarmTable(s, null).rows).toHaveLength(3)
  })

  it('shows an unknown battery as a dash', () => {
    const s = sim(3)
    const table = swarmTable(s, { t: 'tel', drones: [{ id: 0, p: [0, 1, 0], att: [0, 0, 0], bat: -1 }] })
    expect(table.rows[0].cells[6]).toBe('—')
  })
})
