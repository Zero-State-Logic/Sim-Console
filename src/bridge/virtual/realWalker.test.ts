import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig } from '../../core/hardware'
import type { CmdMsg, TelMsg } from '../../core/protocol'
import type { HardwareSpec } from '../../core/types'
import { WalkerModule } from '../../robots/walker/WalkerModule'
import { HOME_MS, VirtualDevice } from './device'
import type { WalkerBody } from './walkerBody'

/*
 * The virtual board flashed for the REAL walker module (not a test fixture): its
 * HardwareSpec, home pose, geometry, gait names and commands. Pins that the walker's
 * joint conventions and the HardwareSpec contract agree, so the HARDWARE demo stands,
 * reads level and walks like the generated firmware would.
 */

interface Rig {
  m: WalkerModule
  spec: HardwareSpec
  dev: VirtualDevice
  body: WalkerBody
  msgs: (t: string) => Record<string, unknown>[]
  logs: () => string[]
}

function rig(legs: '4' | '6' | '8'): Rig {
  const m = new WalkerModule()
  m.setControl('legs', legs)
  const spec = m.getHardwareSpec()
  const cfg = defaultHardwareConfig('esp32', spec.joints)
  const out: string[] = []
  const dev = new VirtualDevice({ spec, getConfig: () => cfg, emit: (l) => out.push(l), miscalibrate: false, seed: 11 })
  dev.start()
  dev.step(400)
  dev.receive('{"t":"home"}')
  dev.step(HOME_MS + 600)
  const msgs = (t: string) =>
    out.flatMap((l) => {
      try {
        const o = JSON.parse(l) as Record<string, unknown>
        return o.t === t ? [o] : []
      } catch {
        return []
      }
    })
  return { m, spec, dev, body: dev.physical as WalkerBody, msgs, logs: () => msgs('log').map((o) => String(o.msg)) }
}

function lastTel(r: Rig): TelMsg {
  return r.msgs('tel').pop() as unknown as TelMsg
}

function drive(r: Rig, cmd: CmdMsg, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.02) {
    r.dev.receive(JSON.stringify(cmd))
    r.dev.step(20)
  }
}

describe.each(['4', '6', '8'] as const)('virtual board flashed for the real %s-leg walker', (legs) => {
  it('announces on-board IK and load sensing from the real geometry', () => {
    const r = rig(legs)
    const hello = r.msgs('hello').pop() as { joints: number; legs: number; caps: string[] }
    expect(hello.joints).toBe(Number(legs) * 3)
    expect(hello.legs).toBe(Number(legs))
    expect(hello.caps).toEqual(expect.arrayContaining(['onboard-ik', 'load']))
  })

  it('stands at the spec stand height on all feet, level, with the weight shared and Σ load = 1', () => {
    // Arrange / Act
    const r = rig(legs)
    r.dev.step(200)
    const tel = lastTel(r)
    const st = r.body.statics
    // Assert: the module's home pose and its HardwareSpec geometry describe the same stance
    expect(st?.supported).toBe(true)
    expect(Array.from(st?.stance ?? [])).toEqual(new Array(Number(legs)).fill(1))
    const stand = r.spec.geometry?.standHeight as number
    for (let i = 0; i < Number(legs); i++) expect(st?.feet[3 * i + 2] ?? 0).toBeCloseTo(-stand, 2)
    expect(Math.abs(tel.imu?.[0] ?? 99)).toBeLessThan(1.5)
    expect(Math.abs(tel.imu?.[1] ?? 99)).toBeLessThan(1.5)
    const load = tel.load ?? []
    expect(load).toHaveLength(Number(legs))
    expect(load.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2)
    for (const f of load) expect(f).toBeGreaterThan(0)
  })

  it('tracks the module JOINT command: measured ang matches the commanded q', () => {
    const r = rig(legs)
    const cmd = r.m.buildCommand('joint')
    drive(r, cmd, 1)
    const ang = lastTel(r).ang ?? []
    expect(ang).toHaveLength(r.spec.joints)
    ang.forEach((a, j) => expect(Math.abs(a - (cmd.q?.[j] ?? 0))).toBeLessThan(1.5))
    expect(r.logs().some((l) => /clamped|mechanical stop/.test(l))).toBe(false)
  })

  it('walks from the module HIGH command (its gait name is known to the firmware) without IK misses or drift in yaw', () => {
    // Arrange: the module's own high-level command, with a forward twist
    const r = rig(legs)
    const base = r.m.buildCommand('high')
    const cmd: CmdMsg = { ...base, v: [0.04, 0, 0] }
    const q0 = Array.from(r.body.angles())
    // Act
    drive(r, cmd, 4)
    const tel = lastTel(r)
    // Assert
    expect(r.body.gait?.active).toBe(true)
    expect(r.logs().filter((l) => /unknown gait|IK:|clamped/.test(l))).toEqual([])
    const moved = Array.from(r.body.angles()).some((q, j) => Math.abs(q - q0[j]) > 3)
    expect(moved).toBe(true)
    expect(Math.abs(tel.imu?.[2] ?? 99)).toBeLessThan(3)
    expect((tel.load ?? []).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2)
    // the module takes the virtual board's telemetry as it would a real one
    expect(() => r.m.applyTelemetry(tel)).not.toThrow()
  })
})
