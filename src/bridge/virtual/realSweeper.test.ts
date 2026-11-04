import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig } from '../../core/hardware'
import { buildCmd, hardwareSpec, parseTelemetry } from '../../robots/sweeper/hardwareMap'
import { mecanumForward, mecanumInverse, type Twist } from '../../robots/sweeper/mecanum'
import type { TelMsg } from '../../core/protocol'
import { HOME_MS, VirtualDevice } from './device'
import type { SweeperBody } from './sweeperBody'

/*
 * The virtual board flashed for the REAL sweeper module: its spec, its wheel mixing
 * (FL FR RL RR) and its telemetry parser. Pins the cross-module wheel order and the
 * odometry frame, at both command levels.
 */

function rig() {
  const spec = hardwareSpec()
  const cfg = defaultHardwareConfig('esp32', spec.joints)
  const out: string[] = []
  const dev = new VirtualDevice({ spec, getConfig: () => cfg, emit: (l) => out.push(l), seed: 5 })
  dev.start()
  dev.step(400)
  dev.receive('{"t":"home"}')
  dev.step(HOME_MS + 20)
  const tel = () => JSON.parse(out.filter((l) => l.includes('"tel"')).pop() as string) as TelMsg
  return { dev, body: dev.physical as SweeperBody, tel }
}

const CASES: [string, Twist][] = [
  ['forward', { vx: 0.2, vy: 0, wz: 0 }],
  ['strafe left', { vx: 0, vy: 0.15, wz: 0 }],
  ['turn CCW', { vx: 0, vy: 0, wz: 0.8 }],
  ['forward arc', { vx: 0.15, vy: 0.05, wz: 0.4 }],
]

describe.each(['joint', 'high'] as const)('virtual sweeper against the sweeper module at %s level', (level) => {
  it.each(CASES)('%s: the board moves the way the module commanded and its telemetry reads back the same twist', (_name, tw) => {
    // Arrange
    const r = rig()
    const w = new Float64Array(4)
    mecanumInverse(tw.vx, tw.vy, tw.wz, w)
    const cmd = buildCmd(level, w, tw, 'teleop')
    // Act: hold the command for 1 s (well past the wheel ramp)
    for (let i = 0; i < 50; i++) {
      r.dev.receive(JSON.stringify(cmd))
      r.dev.step(20)
    }
    // Assert: encoder speeds → the module's forward kinematics → the commanded twist
    const parsed = parseTelemetry(r.tel())
    expect(parsed.enc).not.toBeNull()
    const back = mecanumForward(parsed.enc ?? [0, 0, 0, 0], { vx: 0, vy: 0, wz: 0 })
    expect(back.vx).toBeCloseTo(tw.vx, 1)
    expect(back.vy).toBeCloseTo(tw.vy, 1)
    expect(back.wz).toBeCloseTo(tw.wz, 1)
    // odometry pose in the module's frame: x forward, y left, heading CCW
    const [x, y, th] = r.body.pose()
    if (tw.vx > 0 && tw.wz === 0) expect(x).toBeGreaterThan(0.1)
    if (tw.vy > 0 && tw.vx === 0) expect(y).toBeGreaterThan(0.05)
    if (tw.wz > 0) expect(th).toBeGreaterThan(0.3)
    expect(parsed.pose?.[2]).toBeCloseTo(th, 1)
  })
})
