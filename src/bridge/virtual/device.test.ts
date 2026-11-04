import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig, type HardwareConfig } from '../../core/hardware'
import type { HardwareSpec } from '../../core/types'
import { HOME_MS, VIRTUAL_FW, VirtualDevice } from './device'
import { SwarmBody, SweeperBody, WalkerBody } from './bodies'

function walkerSpec(legs = 2): HardwareSpec {
  const joints = legs * 3
  return {
    robot: 'walker',
    joints,
    jointNames: Array.from({ length: joints }, (_, i) => `L${Math.floor(i / 3) + 1} ${['coxa', 'femur', 'tibia'][i % 3]}`),
    jointLimits: Array.from({ length: joints }, () => [-60, 60] as [number, number]),
    homePose: Array.from({ length: joints }, (_, i) => [0, 10, -10][i % 3]),
    legs,
    defaultLevel: { wired: 'joint', wireless: 'high' },
  }
}

const SWEEPER: HardwareSpec = {
  robot: 'sweeper',
  joints: 4,
  jointNames: ['FL', 'FR', 'RL', 'RR'],
  jointLimits: [[-1, 1], [-1, 1], [-1, 1], [-1, 1]],
  homePose: [0, 0, 0, 0],
  wheels: 4,
  defaultLevel: { wired: 'joint', wireless: 'high' },
  geometry: { wheelRadius: 0.05, halfLength: 0.1, halfWidth: 0.1, maxWheelSpeed: 20 },
}

const SWARM: HardwareSpec = {
  robot: 'swarm',
  joints: 3,
  jointNames: ['D1', 'D2', 'D3'],
  jointLimits: [[0, 1], [0, 1], [0, 1]],
  homePose: [0, 0, 0],
  drones: 3,
  defaultLevel: { wired: 'joint', wireless: 'joint' },
}

interface Harness {
  dev: VirtualDevice
  out: string[]
  cfg: { current: HardwareConfig }
  msgs: (t?: string) => Record<string, unknown>[]
  logs: () => string[]
}

function boot(spec: HardwareSpec = walkerSpec(), opts: { miscalibrate?: boolean; cfg?: Partial<HardwareConfig> } = {}): Harness {
  const out: string[] = []
  const cfg = { current: { ...defaultHardwareConfig('esp32', spec.joints), ...opts.cfg } }
  const dev = new VirtualDevice({ spec, getConfig: () => cfg.current, emit: (l) => out.push(l), miscalibrate: opts.miscalibrate ?? false, seed: 7 })
  dev.start()
  const msgs = (t?: string) =>
    out.flatMap((l) => {
      try {
        const m = JSON.parse(l) as Record<string, unknown>
        return !t || m.t === t ? [m] : []
      } catch {
        return []
      }
    })
  return { dev, out, cfg, msgs, logs: () => msgs('log').map((m) => String(m.msg)) }
}

function homed(spec?: HardwareSpec, opts?: { miscalibrate?: boolean; cfg?: Partial<HardwareConfig> }): Harness {
  const h = boot(spec, opts)
  h.dev.step(400)
  h.dev.receive('{"t":"home"}')
  h.dev.step(HOME_MS + 20)
  return h
}

describe('VirtualDevice: handshake', () => {
  it('prints a non-JSON boot banner, then sends hello for the active module once booted', () => {
    // Arrange
    const h = boot()
    // Act
    const beforeBoot = h.msgs('hello').length
    h.dev.step(350)
    // Assert
    expect(h.out[0]).toMatch(/booting/)
    expect(beforeBoot).toBe(0)
    expect(h.msgs('hello')).toEqual([
      { t: 'hello', proto: 1, board: 'esp32', robot: 'walker', legs: 2, joints: 6, fw: VIRTUAL_FW, caps: ['virtual', 'feedback', 'imu', 'virtual-servo'] },
    ])
  })

  it('answers hello? with hello and ping with a matching pong', () => {
    const h = boot()
    h.dev.step(350)
    h.dev.receive('{"t":"hello?"}')
    h.dev.receive('{"t":"ping","id":42}')
    expect(h.msgs('hello')).toHaveLength(2)
    expect(h.msgs('pong')).toEqual([{ t: 'pong', id: 42 }])
  })

  it('ignores hello? while still booting and refuses home with ok=false', () => {
    const h = boot()
    h.dev.receive('{"t":"hello?"}')
    h.dev.receive('{"t":"home"}')
    expect(h.msgs('hello')).toHaveLength(0)
    expect(h.msgs('ack')).toEqual([{ t: 'ack', of: 'home', ok: false, msg: 'booting' }])
  })

  it('logs unknown messages and bad JSON instead of crashing', () => {
    const h = boot()
    h.dev.step(350)
    h.dev.receive('{"t":"warp"}')
    h.dev.receive('{oops')
    expect(h.logs()).toContain("unknown message 'warp'")
    expect(h.logs()).toContain('bad json')
  })
})

describe('VirtualDevice: home, cmd, estop', () => {
  it('acks home only after about 0.8 s while easing to the home pose', () => {
    const h = boot()
    h.dev.step(350)
    h.dev.receive('{"t":"home"}')
    h.dev.step(HOME_MS - 20)
    const early = h.msgs('ack').length
    h.dev.step(40)
    expect(early).toBe(0)
    expect(h.msgs('ack')).toEqual([{ t: 'ack', of: 'home', ok: true }])
    expect(h.dev.state).toBe('ready')
  })

  it('ends homing near the home pose', () => {
    const h = homed()
    h.dev.step(300)
    const ang = (h.dev.physical as WalkerBody).angles()
    expect(Array.from(ang).map((a) => Math.round(a))).toEqual([0, 10, -10, 0, 10, -10])
  })

  it('ignores cmd before home with a warning', () => {
    const h = boot()
    h.dev.step(350)
    h.dev.receive('{"t":"cmd","seq":0,"q":[0,0,0,0,0,0]}')
    expect(h.logs()).toContain('cmd ignored: send home first')
  })

  it('tracks a joint command with a first-order lag', () => {
    const h = homed()
    const q = [5, 20, -30, -5, 20, -30]
    h.dev.receive(JSON.stringify({ t: 'cmd', seq: 1, q }))
    h.dev.step(20)
    const partial = (h.dev.physical as WalkerBody).angles()[2]
    for (let i = 0; i < 20; i++) {
      h.dev.receive(JSON.stringify({ t: 'cmd', seq: 2 + i, q }))
      h.dev.step(20)
    }
    const final = Array.from((h.dev.physical as WalkerBody).angles())
    expect(partial).toBeGreaterThan(-30)
    expect(partial).toBeLessThan(-10)
    final.forEach((a, i) => expect(a).toBeCloseTo(q[i], 1))
  })

  it('clamps a command beyond the joint limits and logs a warning naming the joint', () => {
    const h = homed()
    h.dev.receive('{"t":"cmd","seq":1,"q":[0,95,0,0,0,0]}')
    for (let i = 0; i < 30; i++) h.dev.step(20)
    expect(h.logs().some((m) => /servo 1 clamped \(L1 femur 95\.0° outside -60\.\.60°\)/.test(m))).toBe(true)
    expect((h.dev.physical as WalkerBody).angles()[1]).toBeLessThanOrEqual(60.01)
  })

  it('rate-limits repeated clamp warnings to one per second', () => {
    const h = homed()
    for (let i = 0; i < 10; i++) {
      h.dev.receive('{"t":"cmd","seq":1,"q":[0,95,0,0,0,0]}')
      h.dev.step(20)
    }
    expect(h.logs().filter((m) => m.includes('clamped'))).toHaveLength(1)
  })

  it('acks estop, freezes, ignores cmd, and re-arms after home', () => {
    const h = homed()
    h.dev.receive('{"t":"estop"}')
    const frozen = Array.from((h.dev.physical as WalkerBody).angles())
    h.dev.receive('{"t":"cmd","seq":1,"q":[30,30,30,30,30,30]}')
    h.dev.step(500)
    expect(h.msgs('ack')).toContainEqual({ t: 'ack', of: 'estop', ok: true })
    expect(h.dev.state).toBe('estopped')
    expect(h.logs()).toContain('cmd ignored: E-STOP active, send home to re-arm')
    Array.from((h.dev.physical as WalkerBody).angles()).forEach((a, i) => expect(a).toBeCloseTo(frozen[i], 6))
    h.dev.receive('{"t":"home"}')
    h.dev.step(HOME_MS + 20)
    expect(h.dev.state).toBe('ready')
  })

  it('rejects a cmd with malformed fields', () => {
    const h = homed()
    h.dev.receive('{"t":"cmd","q":[1,"x"]}')
    expect(h.logs()).toContain('cmd ignored: malformed fields')
  })
})

describe('VirtualDevice: watchdog and telemetry', () => {
  it('trips the watchdog after watchdogMs without cmd, holds, then logs when commands resume', () => {
    const h = homed(walkerSpec(), { cfg: { watchdogMs: 200, watchdogAction: 'hold' } })
    h.dev.receive('{"t":"cmd","seq":1,"q":[0,10,-10,0,10,-10]}')
    h.dev.step(150)
    const before = h.logs().filter((m) => m.startsWith('watchdog')).length
    h.dev.step(100)
    h.dev.receive('{"t":"cmd","seq":2,"q":[0,10,-10,0,10,-10]}')
    expect(before).toBe(0)
    expect(h.logs()).toContain('watchdog: no cmd for 200 ms, holding the last pose')
    expect(h.logs()).toContain('watchdog cleared, commands resumed')
    expect(h.dev.state).toBe('ready')
  })

  it('relaxes the servos and drops to idle on a relax watchdog, so cmd needs a new HOME (firmware kIdle)', () => {
    // Arrange
    const h = homed(walkerSpec(), { cfg: { watchdogMs: 100, watchdogAction: 'relax' } })
    h.dev.receive('{"t":"cmd","seq":1,"q":[0,10,-10,0,10,-10]}')
    // Act
    h.dev.step(4000)
    const limp = (h.dev.physical as WalkerBody).angles()[1]
    h.dev.receive('{"t":"cmd","seq":2,"q":[0,10,-10,0,10,-10]}')
    h.dev.step(500)
    // Assert
    expect(h.logs()).toContain('watchdog: no cmd for 100 ms, outputs relaxed; send home to resume')
    expect(h.dev.state).toBe('idle')
    // rest pose = home + [0, 25, -20], clamped to ±60; the refused cmd does not pull it back
    expect(limp).toBeGreaterThan(30)
    expect((h.dev.physical as WalkerBody).angles()[1]).toBeGreaterThan(30)
    expect(h.logs()).toContain('cmd ignored: send home first')
    h.dev.receive('{"t":"home"}')
    h.dev.step(HOME_MS + 20)
    expect(h.dev.state).toBe('ready')
  })

  it('arms the watchdog when homing completes, before any cmd, like the firmware', () => {
    // Arrange
    const h = homed(walkerSpec(), { cfg: { watchdogMs: 100, watchdogAction: 'hold' } })
    // Act
    h.dev.step(1000)
    // Assert
    expect(h.logs().filter((m) => m.startsWith('watchdog'))).toEqual(['watchdog: no cmd for 100 ms, holding the last pose'])
    expect(h.dev.state).toBe('ready')
  })

  it('streams tel at telemetryHz with ms, ang, imu and vbat', () => {
    const h = homed(walkerSpec(), { cfg: { telemetryHz: 25 } })
    const n0 = h.msgs('tel').length
    h.dev.step(1000)
    const tels = h.msgs('tel').slice(n0)
    expect(tels.length).toBeGreaterThanOrEqual(24)
    expect(tels.length).toBeLessThanOrEqual(26)
    const last = tels[tels.length - 1]
    expect(last.ang).toHaveLength(6)
    expect(last.imu).toHaveLength(3)
    expect(typeof last.vbat).toBe('number')
    expect(typeof last.ms).toBe('number')
  })
})

describe('VirtualDevice: hidden miscalibration', () => {
  it('reads back an affine error that the true offset/scale config cancels', () => {
    // Arrange: miscalibrated board, command a held pose
    const h = homed(walkerSpec(1), { miscalibrate: true })
    const body = h.dev.physical as WalkerBody
    const q = [20, -15, 30]
    const settle = () => {
      for (let i = 0; i < 40; i++) {
        h.dev.receive(JSON.stringify({ t: 'cmd', seq: i, q }))
        h.dev.step(20)
      }
      return Array.from(body.angles())
    }
    // Act
    const wrong = settle()
    h.cfg.current = { ...h.cfg.current, jointOffsetDeg: Array.from(body.trueOffset), jointScale: Array.from(body.trueScale) }
    const right = settle()
    // Assert
    expect(Math.max(...wrong.map((a, i) => Math.abs(a - q[i])))).toBeGreaterThan(0.3)
    right.forEach((a, i) => expect(a).toBeCloseTo(q[i], 2))
  })
})

describe('VirtualDevice: sweeper and swarm', () => {
  it('drives a mecanum sweeper forward from a twist and integrates odometry', () => {
    const h = homed(SWEEPER)
    for (let i = 0; i < 50; i++) {
      h.dev.receive('{"t":"cmd","seq":1,"v":[0.5,0,0]}')
      h.dev.step(20)
    }
    const body = h.dev.physical as SweeperBody
    const [x, y, th] = body.pose()
    const tel = h.msgs('tel').pop() as { enc: number[]; pose: number[] }
    expect(x).toBeGreaterThan(0.35)
    expect(Math.abs(y)).toBeLessThan(1e-6)
    expect(Math.abs(th)).toBeLessThan(1e-6)
    tel.enc.forEach((w) => expect(w).toBeCloseTo(10, 0))
    expect(tel.pose).toHaveLength(3)
  })

  it('strafes left with positive vy and limits wheel speeds past the limit', () => {
    const h = homed(SWEEPER)
    for (let i = 0; i < 25; i++) {
      h.dev.receive('{"t":"cmd","seq":1,"v":[0,5,0]}')
      h.dev.step(20)
    }
    const [, y] = (h.dev.physical as SweeperBody).pose()
    expect(y).toBeGreaterThan(0)
    expect(h.logs().some((m) => /wheel speeds limited to 20 rad\/s/.test(m))).toBe(true)
  })

  it('keeps the direction of a saturated twist like the firmware: a 2:1 diagonal stays 2:1 while ramping and capped', () => {
    // Arrange: v = [2, 1, 0] asks for 60 rad/s on two wheels (limit 20); per-wheel clipping would drive straight ahead
    const h = homed(SWEEPER)
    // Act
    for (let i = 0; i < 60; i++) {
      h.dev.receive('{"t":"cmd","seq":1,"v":[2,1,0]}')
      h.dev.step(20)
    }
    // Assert
    const [x, y, th] = (h.dev.physical as SweeperBody).pose()
    expect(y / x).toBeCloseTo(0.5, 6)
    expect(Math.abs(th)).toBeLessThan(1e-9)
    const tel = h.msgs('tel').pop() as { enc: number[] }
    expect(Math.max(...tel.enc.map(Math.abs))).toBeLessThan(20.3)
  })

  it('keeps the curvature of a saturated arc (vx and wz shrink by the same factor)', () => {
    const h = homed(SWEEPER)
    // Act: ω/v = 2 rad/m commanded, beyond the wheel limit
    for (let i = 0; i < 40; i++) {
      h.dev.receive('{"t":"cmd","seq":1,"v":[1.5,0,3]}')
      h.dev.step(20)
    }
    // Assert: a circle of radius v/ω = 0.5 m about (0, 0.5) whatever the speed reached
    const [x, y] = (h.dev.physical as SweeperBody).pose()
    expect(Math.hypot(x, y - 0.5)).toBeCloseTo(0.5, 3)
  })

  it('flies swarm drones toward their setpoints and reports per-drone telemetry', () => {
    const h = homed(SWARM)
    const sp = [{ id: 0, p: [0, 1, 0] }, { id: 1, p: [1, 1, 1] }, { id: 2, p: [-1, 2, 0], yaw: 90 }]
    for (let i = 0; i < 250; i++) {
      h.dev.receive(JSON.stringify({ t: 'cmd', seq: i, sp }))
      h.dev.step(20)
    }
    const body = h.dev.physical as SwarmBody
    expect(body.position(1)[0]).toBeCloseTo(1, 1)
    expect(body.position(2)[1]).toBeCloseTo(2, 1)
    const tel = h.msgs('tel').pop() as { drones: { id: number; att: number[]; bat: number }[] }
    expect(tel.drones).toHaveLength(3)
    expect(tel.drones[2].att[2]).toBeCloseTo(90, 0)
    // battery is the 1S cell voltage on the wire (the swarm module maps volts to percent)
    expect(tel.drones[0].bat).toBeLessThan(4.2)
    expect(tel.drones[0].bat).toBeGreaterThan(4.0)
  })

  it('re-flashes for another robot and announces it with a fresh hello', () => {
    const h = homed()
    h.dev.reflash(SWEEPER)
    h.dev.step(350)
    const hellos = h.msgs('hello')
    expect(hellos[hellos.length - 1]).toMatchObject({ robot: 'sweeper', wheels: 4, joints: 4 })
    expect(h.dev.state).toBe('idle')
  })
})
