import { describe, expect, it } from 'vitest'
import type { CmdMsg, TelMsg } from '../../core/protocol'
import type { HardwareSpec } from '../../core/types'
import { G } from './common'
import { createRng } from './random'
import { batteryPercent } from '../../robots/swarm/hardwareIO'
import { SwarmBody, cellVolts } from './swarmBody'

const SPEC: HardwareSpec = {
  robot: 'swarm',
  joints: 2,
  jointNames: ['D1', 'D2'],
  jointLimits: [[-180, 180], [-180, 180]],
  homePose: [0, 0],
  drones: 2,
  defaultLevel: { wired: 'high', wireless: 'high' },
}

function make(): { body: SwarmBody; warns: string[] } {
  const warns: string[] = []
  const body = new SwarmBody(SPEC, createRng(3), { warn: (_k, m) => warns.push(m) })
  body.setMode('track')
  return { body, warns }
}

function fly(body: SwarmBody, cmd: CmdMsg, seconds: number, dt = 0.01): void {
  for (let t = 0; t < seconds; t += dt) {
    body.command(cmd)
    body.step(dt)
  }
}

function sp(id: number, p: [number, number, number], yaw?: number): CmdMsg {
  return { t: 'cmd', sp: [yaw === undefined ? { id, p } : { id, p, yaw }] }
}

describe('SwarmBody: flight dynamics', () => {
  it('climbs to a setpoint and settles into a level hover', () => {
    // Arrange
    const { body } = make()
    const start = body.position(0)
    // Act
    fly(body, sp(0, [start[0], 2, start[2]]), 8)
    // Assert
    const [x, y, z] = body.position(0)
    expect(y).toBeCloseTo(2, 2)
    expect(x).toBeCloseTo(start[0], 3)
    expect(z).toBeCloseTo(start[2], 3)
    const [roll, pitch] = body.attitudeOf(0)
    expect(Math.abs(roll)).toBeLessThan(1e-3)
    expect(Math.abs(pitch)).toBeLessThan(1e-3)
  })

  it('pitches nose-down (positive REP-103 pitch) to accelerate forward at yaw 0', () => {
    // Arrange
    const { body } = make()
    const [x0, , z0] = body.position(0)
    fly(body, sp(0, [x0, 2, z0]), 6)
    // Act: step the setpoint 3 m forward (+x)
    fly(body, sp(0, [x0 + 3, 2, z0]), 0.2)
    // Assert
    const [roll, pitch] = body.attitudeOf(0)
    expect(pitch).toBeGreaterThan(0.2)
    expect(Math.abs(roll)).toBeLessThan(0.01)
  })

  it('rolls left (negative REP-103 roll) to accelerate toward its left', () => {
    // Arrange: at yaw 0, left in the Y-up wire frame is -z
    const { body } = make()
    const [x0, , z0] = body.position(0)
    fly(body, sp(0, [x0, 2, z0]), 6)
    // Act
    fly(body, sp(0, [x0, 2, z0 - 3]), 0.2)
    // Assert
    const [roll, pitch] = body.attitudeOf(0)
    expect(roll).toBeLessThan(-0.2)
    expect(Math.abs(pitch)).toBeLessThan(0.01)
  })

  it('maps the tilt through yaw: at yaw 90° forward is -z, so that move is pure pitch', () => {
    // Arrange
    const { body } = make()
    const [x0, , z0] = body.position(0)
    fly(body, sp(0, [x0, 2, z0], 90), 6)
    // Act
    fly(body, sp(0, [x0, 2, z0 - 3], 90), 0.2)
    // Assert
    const [roll, pitch] = body.attitudeOf(0)
    expect(pitch).toBeGreaterThan(0.2)
    expect(Math.abs(roll)).toBeLessThan(0.02)
  })

  it('never tilts past the 30° limit even for a huge setpoint step', () => {
    // Arrange
    const { body } = make()
    const [x0, , z0] = body.position(0)
    fly(body, sp(0, [x0, 2, z0]), 6)
    let maxTilt = 0
    // Act
    for (let i = 0; i < 300; i++) {
      body.command(sp(0, [x0 + 40, 2, z0 - 40]))
      body.step(0.01)
      const [r, p] = body.attitudeOf(0)
      maxTilt = Math.max(maxTilt, Math.acos(Math.cos(r) * Math.cos(p)))
    }
    // Assert
    expect(maxTilt).toBeLessThanOrEqual((30 * Math.PI) / 180 + 1e-6)
    expect(maxTilt).toBeGreaterThan((25 * Math.PI) / 180)
  })

  it('stays parked on the ground (no sliding) while its setpoint is on the ground', () => {
    // Arrange
    const { body } = make()
    const [x0, , z0] = body.position(1)
    // Act
    fly(body, sp(1, [x0 + 2, 0, z0 + 2]), 2)
    // Assert
    expect(body.position(1)).toEqual([x0, 0, z0])
  })
})

describe('SwarmBody: safety behaviours', () => {
  it('E-STOP cuts the motors: the drone falls under gravity and stops on the ground', () => {
    // Arrange
    const { body } = make()
    const [x0, , z0] = body.position(0)
    fly(body, sp(0, [x0, 3, z0]), 8)
    // Act
    body.setMode('frozen')
    const dt = 0.001
    for (let t = 0; t < 0.3; t += dt) body.step(dt)
    // Assert: close to free fall (drag only takes a little off g·t²/2 = 0.44 m)
    const drop = 3 - body.position(0)[1]
    expect(drop).toBeGreaterThan(0.4)
    expect(drop).toBeLessThan((G * 0.3 * 0.3) / 2 + 0.01)
    for (let t = 0; t < 2; t += dt) body.step(dt)
    expect(body.position(0)[1]).toBe(0)
  })

  it('HOME holds each drone where it is, like the firmware (kPktHold), until setpoints stream', () => {
    // Arrange
    const { body } = make()
    const [x0, , z0] = body.position(0)
    fly(body, sp(0, [x0 + 1, 2, z0 + 1]), 8)
    // Act
    body.setMode('hold')
    body.beginHome()
    for (let t = 0; t < 10; t += 0.01) body.step(0.01)
    // Assert
    const [x, y, z] = body.position(0)
    expect(y).toBeCloseTo(2, 2)
    expect(x).toBeCloseTo(x0 + 1, 2)
    expect(z).toBeCloseTo(z0 + 1, 2)
  })

  it('HOME on the ground keeps a parked drone parked', () => {
    const { body } = make()
    body.setMode('hold')
    body.beginHome()
    for (let t = 0; t < 2; t += 0.01) body.step(0.01)
    expect(body.position(0)[1]).toBe(0)
  })

  it('watchdog relax descends gently instead of dropping', () => {
    // Arrange
    const { body } = make()
    const [x0, , z0] = body.position(0)
    fly(body, sp(0, [x0, 2, z0]), 8)
    // Act
    body.setMode('relax')
    for (let t = 0; t < 1; t += 0.01) body.step(0.01)
    // Assert: the setpoint ramps down at LAND_SPEED (0.4 m/s); a type-1 loop trails a ramp
    // by 2·v/wn ≈ 0.36 m, so after 1 s the drone is between the ramp and its start
    const y = body.position(0)[1]
    expect(y).toBeGreaterThan(1.6)
    expect(y).toBeLessThan(1.95)
    for (let t = 0; t < 9; t += 0.01) body.step(0.01)
    expect(body.position(0)[1]).toBe(0)
  })
})

describe('SwarmBody: battery and telemetry', () => {
  it('drains about 100 % per 8 min in hover and faster under higher thrust', () => {
    // Arrange
    const a = make().body
    const b = make().body
    const [x0, , z0] = a.position(0)
    fly(a, sp(0, [x0, 2, z0]), 6)
    fly(b, sp(0, [x0, 2, z0]), 6)
    const a0 = a.battery(0)
    const b0 = b.battery(0)
    // Act: a hovers, b climbs hard (more thrust) for the same 10 s
    fly(a, sp(0, [x0, 2, z0]), 10)
    for (let i = 0; i < 1000; i++) {
      b.command(sp(0, [x0, 2 + (i % 200 < 100 ? 6 : 0), z0]))
      b.step(0.01)
    }
    // Assert
    const hoverDrain = (a0 - a.battery(0)) / 10
    expect(hoverDrain).toBeCloseTo(100 / 480, 2)
    expect(b0 - b.battery(0)).toBeGreaterThan(a0 - a.battery(0))
  })

  it('reports per-drone position, attitude in degrees and the cell voltage, with a 1S pack voltage', () => {
    // Arrange
    const { body } = make()
    const tel: TelMsg = { t: 'tel' }
    // Act
    body.telemetry(tel)
    // Assert
    expect(tel.drones).toHaveLength(2)
    expect(tel.drones?.[0].bat).toBe(4.2)
    expect(tel.drones?.[0].p[1]).toBe(0)
    expect(tel.vbat).toBeCloseTo(4.2, 2)
  })

  it('forces a landing and refuses climbs when a battery runs flat', () => {
    // Arrange
    const { body, warns } = make()
    const [x0, , z0] = body.position(0)
    fly(body, sp(0, [x0, 2, z0]), 6)
    // Act: fly until empty (8 min of hover), then try to climb
    fly(body, sp(0, [x0, 2, z0]), 500, 0.05)
    fly(body, sp(0, [x0, 4, z0]), 10, 0.05)
    // Assert
    expect(body.battery(0)).toBe(0)
    expect(body.position(0)[1]).toBe(0)
    expect(warns.some((w) => /battery empty/.test(w))).toBe(true)
  })
})

describe('SwarmBody: battery on the wire', () => {
  it('maps charge to a monotonic 1S cell voltage from 3.3 V (empty) to 4.2 V (full)', () => {
    // Act
    const volts = [0, 5, 20, 40, 55, 70, 80, 90, 100].map(cellVolts)
    // Assert
    expect(volts[0]).toBeCloseTo(3.3, 9)
    expect(volts[volts.length - 1]).toBeCloseTo(4.2, 9)
    for (let i = 1; i < volts.length; i++) expect(volts[i]).toBeGreaterThan(volts[i - 1])
    expect(cellVolts(-5)).toBeCloseTo(3.3, 9)
    expect(cellVolts(150)).toBeCloseTo(4.2, 9)
  })

  it('round-trips through the swarm module, which reads the cell voltage back as percent', () => {
    // Act / Assert: low charge too, where a percentage on the wire would be misread as volts
    for (const pct of [3, 12, 25, 47, 63, 88, 99]) expect(batteryPercent(cellVolts(pct))).toBeCloseTo(pct, 6)
  })
})
