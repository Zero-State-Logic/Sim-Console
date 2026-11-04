import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig, type HardwareConfig } from '../../core/hardware'
import type { HardwareSpec } from '../../core/types'
import { HOME_MS, VirtualDevice } from './device'
import { walkerGeometrySpec } from './fixtures'
import type { WalkerBody } from './walkerBody'

/* The virtual walker through the device, the way the loopback transport drives it. */

interface Rig {
  dev: VirtualDevice
  body: WalkerBody
  cfg: { current: HardwareConfig }
  tel: () => Record<string, unknown>[]
  logs: () => string[]
}

function rig(spec: HardwareSpec = walkerGeometrySpec(6), cfg: Partial<HardwareConfig> = {}): Rig {
  const out: string[] = []
  const c = { current: { ...defaultHardwareConfig('esp32', spec.joints), ...cfg } }
  const dev = new VirtualDevice({ spec, getConfig: () => c.current, emit: (l) => out.push(l), miscalibrate: false, seed: 11 })
  dev.start()
  dev.step(400)
  dev.receive('{"t":"home"}')
  dev.step(HOME_MS + 400)
  const msgs = (t: string) =>
    out.flatMap((l) => {
      try {
        const m = JSON.parse(l) as Record<string, unknown>
        return m.t === t ? [m] : []
      } catch {
        return []
      }
    })
  return { dev, body: dev.physical as WalkerBody, cfg: c, tel: () => msgs('tel'), logs: () => msgs('log').map((m) => String(m.msg)) }
}

function drive(r: Rig, line: object, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.02) {
    r.dev.receive(JSON.stringify(line))
    r.dev.step(20)
  }
}

function range(values: number[]): number {
  return Math.max(...values) - Math.min(...values)
}

describe('WalkerBody: announces and reports its physics', () => {
  it('announces on-board IK and load sensing when the spec carries geometry', () => {
    // Arrange
    const out: string[] = []
    const spec = walkerGeometrySpec(6)
    const dev = new VirtualDevice({ spec, getConfig: () => defaultHardwareConfig('esp32', 18), emit: (l) => out.push(l), seed: 1 })
    // Act
    dev.start()
    dev.step(400)
    // Assert
    const hello = JSON.parse(out.find((l) => l.includes('"hello"')) as string) as { caps: string[] }
    expect(hello.caps).toEqual(['virtual', 'feedback', 'imu', 'virtual-servo', 'onboard-ik', 'load'])
  })

  it('reports a level IMU and equal leg loads while standing in the home pose', () => {
    // Arrange
    const r = rig()
    // Act
    r.dev.step(500)
    // Assert
    const last = r.tel().pop() as { imu: number[]; load: number[] }
    expect(Math.abs(last.imu[0])).toBeLessThan(1.5)
    expect(Math.abs(last.imu[1])).toBeLessThan(1.5)
    expect(last.load).toHaveLength(6)
    const total = last.load.reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(1, 2)
    for (const f of last.load) expect(f).toBeCloseTo(1 / 6, 2)
  })
})

describe('WalkerBody: HIGH level drives the on-board gait', () => {
  it('walks from cmd v: the joints cycle and swing legs unload', () => {
    // Arrange
    const r = rig()
    const before = r.tel().length
    // Act
    drive(r, { t: 'cmd', v: [0.05, 0, 0], mode: 'tripod' }, 4)
    // Assert
    const tel = r.tel().slice(before + 25) as { ang: number[]; load: number[] }[]
    const coxa = tel.map((m) => m.ang[0])
    expect(range(coxa)).toBeGreaterThan(5)
    expect(tel.some((m) => m.load[0] === 0)).toBe(true)
    expect(r.body.gait?.active).toBe(true)
    expect(r.body.gait?.gaitName).toBe('tripod')
  })

  it('logs an unknown gait name and keeps walking with the current gait', () => {
    // Arrange
    const r = rig()
    // Act
    drive(r, { t: 'cmd', v: [0.03, 0, 0], mode: 'moonwalk' }, 0.5)
    // Assert
    expect(r.logs().some((m) => /unknown gait 'moonwalk', keeping tripod/.test(m))).toBe(true)
    expect(r.body.gait?.active).toBe(true)
  })

  it('hands control back to joint streaming as soon as a cmd q arrives', () => {
    // Arrange
    const r = rig()
    const home = walkerGeometrySpec(6).homePose
    drive(r, { t: 'cmd', v: [0.05, 0, 0.2] }, 1)
    // Act
    drive(r, { t: 'cmd', q: home }, 1)
    // Assert
    expect(r.body.gait?.active).toBe(false)
    const q = r.body.angles()
    for (let j = 0; j < 18; j++) expect(q[j]).toBeCloseTo(home[j], 1)
  })

  it('halts the gait when the watchdog trips with action hold, so the feet settle', () => {
    // Arrange
    const r = rig(walkerGeometrySpec(6), { watchdogMs: 200, watchdogAction: 'hold' })
    drive(r, { t: 'cmd', v: [0.05, 0, 0] }, 1)
    // Act
    r.dev.step(2000)
    // Assert
    expect(r.logs().some((m) => /watchdog: no cmd for 200 ms, holding the last pose/.test(m))).toBe(true)
    expect(r.body.gait?.vx).toBe(0)
    expect(Math.abs(r.body.gait?.sx ?? 1)).toBeLessThan(1e-3)
  })

  it('stops the gait on E-STOP and on HOME', () => {
    // Arrange
    const r = rig()
    drive(r, { t: 'cmd', v: [0.05, 0, 0] }, 0.5)
    // Act
    r.dev.receive('{"t":"estop"}')
    const afterEstop = r.body.gait?.active
    r.dev.receive('{"t":"home"}')
    r.dev.step(HOME_MS + 20)
    drive(r, { t: 'cmd', v: [0.05, 0, 0] }, 0.2)
    r.dev.receive('{"t":"home"}')
    // Assert
    expect(afterEstop).toBe(false)
    expect(r.body.gait?.active).toBe(false)
  })

  it('holds its pose with a warning when the spec has no geometry for on-board IK', () => {
    // Arrange
    const { geometry: _g, ...bare } = walkerGeometrySpec(6)
    const r = rig(bare)
    // Act
    drive(r, { t: 'cmd', v: [0.05, 0, 0] }, 0.2)
    // Assert
    expect(r.body.gait).toBeNull()
    expect(r.logs().some((m) => /needs the walker geometry/.test(m))).toBe(true)
  })
})
