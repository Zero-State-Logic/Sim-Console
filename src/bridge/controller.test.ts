import { beforeEach, describe, expect, it } from 'vitest'
import { defaultHardwareConfig, type HardwareConfig } from '../core/hardware'
import type { CmdMsg, TelMsg, TransportId } from '../core/protocol'
import type { CommandLevel, HardwareSpec, RobotModule } from '../core/types'
import { ESTOP_MAX_SENDS, ESTOP_RESEND_MS, HANDSHAKE_TIMEOUT_MS, HOME_TIMEOUT_MS, LinkController } from './controller'
import type { LinkStatus, LogDir, Transport, TransportEventState } from './types'

/* ---------------- fakes ---------------- */

class FakeTransport implements Transport {
  written: string[] = []
  supported = true
  full = false
  disconnected = false
  reflashCount = 0
  connectImpl: () => Promise<void> = async () => {}
  private lineFns = new Set<(l: string) => void>()
  private stateFns = new Set<(s: TransportEventState, d?: string) => void>()
  reflash?: () => void

  constructor(readonly id: TransportId = 'serial', withReflash = false) {
    if (withReflash) this.reflash = () => void this.reflashCount++
  }

  isSupported(): boolean {
    return this.supported
  }
  connect(): Promise<void> {
    return this.connectImpl()
  }
  async disconnect(): Promise<void> {
    this.disconnected = true
  }
  write(line: string, critical?: boolean): boolean {
    if (this.full && !critical) return false
    this.written.push(line)
    return true
  }
  onLine(fn: (l: string) => void): () => void {
    this.lineFns.add(fn)
    return () => this.lineFns.delete(fn)
  }
  onState(fn: (s: TransportEventState, d?: string) => void): () => void {
    this.stateFns.add(fn)
    return () => this.stateFns.delete(fn)
  }
  emit(msg: object | string): void {
    const line = typeof msg === 'string' ? msg : JSON.stringify(msg)
    for (const fn of this.lineFns) fn(line)
  }
  drop(detail?: string): void {
    for (const fn of this.stateFns) fn('closed', detail)
  }
  private dropFns = new Set<(b: number) => void>()
  onDrop(fn: (b: number) => void): () => void {
    this.dropFns.add(fn)
    return () => this.dropFns.delete(fn)
  }
  oversize(bytes: number): void {
    for (const fn of this.dropFns) fn(bytes)
  }
  sent(t: string): Record<string, unknown>[] {
    return this.written.map((l) => JSON.parse(l) as Record<string, unknown>).filter((m) => m.t === t)
  }
}

function spec(joints = 18, legs = 6): HardwareSpec {
  return {
    robot: 'walker',
    joints,
    jointNames: Array.from({ length: joints }, (_, i) => `J${i}`),
    jointLimits: Array.from({ length: joints }, () => [-90, 90] as [number, number]),
    homePose: new Array(joints).fill(0),
    legs,
    defaultLevel: { wired: 'joint', wireless: 'high' },
  }
}

interface FakeModule {
  revision: number
  spec: HardwareSpec
  applied: TelMsg[]
  levels: CommandLevel[]
  nextCmd: CmdMsg | null
}

function fakeModule(s = spec()): { m: RobotModule; f: FakeModule } {
  const f: FakeModule = { revision: 0, spec: s, applied: [], levels: [], nextCmd: null }
  const m = {
    get revision() {
      return f.revision
    },
    getHardwareSpec: () => f.spec,
    buildCommand: (level: CommandLevel): CmdMsg => {
      f.levels.push(level)
      return f.nextCmd ?? { t: 'cmd', q: new Array(f.spec.joints).fill(1.5) }
    },
    applyTelemetry: (tel: TelMsg) => void f.applied.push(tel),
  } as unknown as RobotModule
  return { m, f }
}

const HELLO = { t: 'hello', proto: 1, board: 'esp32', robot: 'walker', legs: 6, joints: 18, fw: 'kiyobridge-1.0' }

interface Rig {
  c: LinkController
  t: FakeTransport
  m: RobotModule
  f: FakeModule
  clock: { now: number }
  cfg: { current: HardwareConfig }
  statuses: { s: LinkStatus; urgent: boolean }[]
  logs: { dir: LogDir; text: string }[]
  sentCmds: CmdMsg[]
  last: () => LinkStatus
  advance: (ms: number) => void
}

function rig(transport = new FakeTransport()): Rig {
  const clock = { now: 0 }
  const cfg = { current: defaultHardwareConfig('esp32', 18) }
  const statuses: Rig['statuses'] = []
  const logs: Rig['logs'] = []
  const sentCmds: CmdMsg[] = []
  const c = new LinkController({
    now: () => clock.now,
    getConfig: () => cfg.current,
    onStatus: (s, urgent) => void statuses.push({ s, urgent }),
    log: (dir, text) => void logs.push({ dir, text }),
    onCommandSent: (cmd) => void sentCmds.push(cmd),
  })
  const { m, f } = fakeModule()
  c.attachModule(m)
  const r: Rig = {
    c, t: transport, m, f, clock, cfg, statuses, logs, sentCmds,
    last: () => c.status(),
    advance: (ms) => {
      clock.now += ms
      c.pump(clock.now)
    },
  }
  return r
}

/** Connect, answer hello, ack home: ends LIVE with the source active. */
async function toLive(r: Rig): Promise<void> {
  r.c.sourceEnter(r.m)
  await r.c.connect(r.t)
  r.t.emit(HELLO)
  r.t.emit({ t: 'ack', of: 'home', ok: true })
}

/* ---------------- tests ---------------- */

describe('LinkController: happy path', () => {
  let r: Rig
  beforeEach(() => {
    r = rig()
  })

  it('walks connecting → handshake → homing → live and asks for hello and home', async () => {
    // Arrange
    r.c.sourceEnter(r.m)
    r.statuses.length = 0
    // Act
    await r.c.connect(r.t)
    const afterConnect = r.c.linkState
    r.t.emit(HELLO)
    const afterHello = r.c.linkState
    r.t.emit({ t: 'ack', of: 'home', ok: true })
    // Assert
    expect(afterConnect).toBe('handshake')
    expect(r.t.sent('hello?')).toHaveLength(1)
    expect(afterHello).toBe('homing')
    expect(r.t.sent('home')).toHaveLength(1)
    expect(r.c.linkState).toBe('live')
    expect(r.statuses.filter((s) => s.urgent).map((s) => s.s.state)).toEqual(['connecting', 'handshake', 'verify', 'homing', 'live'])
    expect(r.last().hello).toMatchObject({ board: 'esp32', joints: 18 })
  })

  it('rests in ready when the drive source is not HARDWARE, and homes on source enter', async () => {
    await r.c.connect(r.t)
    r.t.emit(HELLO)
    expect(r.c.linkState).toBe('ready')
    expect(r.t.sent('home')).toHaveLength(0)
    r.c.sourceEnter(r.m)
    expect(r.c.linkState).toBe('homing')
    r.t.emit({ t: 'ack', of: 'home', ok: true })
    expect(r.c.linkState).toBe('live')
  })

  it('streams buildCommand at commandHz with increasing seq and feeds new tel to the module', async () => {
    await toLive(r)
    r.t.emit({ t: 'tel', ms: 1, ang: [1, 2] })
    for (let f = 0; f < 60; f++) {
      r.clock.now += 1000 / 60
      r.c.tick(r.m, 1 / 60, r.clock.now)
    }
    const cmds = r.t.sent('cmd')
    expect(cmds.length).toBeGreaterThanOrEqual(49)
    expect(cmds.length).toBeLessThanOrEqual(51)
    expect(cmds.slice(0, 3).map((c) => c.seq)).toEqual([0, 1, 2])
    expect(cmds[0].q).toHaveLength(18)
    expect(r.f.applied).toHaveLength(1)
    expect(r.last().cmdCount).toBe(cmds.length)
    expect(r.last().cmdBytes).toBeGreaterThan(0)
    expect(r.sentCmds).toHaveLength(cmds.length)
  })

  it('does not stream while paused (dt = 0) but keeps pinging', async () => {
    await toLive(r)
    for (let f = 0; f < 150; f++) {
      r.clock.now += 1000 / 60
      r.c.tick(r.m, 0, r.clock.now)
    }
    expect(r.t.sent('cmd')).toHaveLength(0)
    expect(r.t.sent('ping').length).toBeGreaterThanOrEqual(2)
  })

  it('re-homes instead of streaming after a pause past a relax watchdog (the board went idle)', async () => {
    // Arrange
    r.cfg.current = { ...r.cfg.current, watchdogMs: 500, watchdogAction: 'relax' }
    await toLive(r)
    r.clock.now += 20
    r.c.tick(r.m, 0.02, r.clock.now)
    const homesBefore = r.t.sent('home').length
    // Act: paused for 1 s, then resumed
    r.clock.now += 1000
    r.c.tick(r.m, 0, r.clock.now)
    r.clock.now += 16
    r.c.tick(r.m, 0.016, r.clock.now)
    // Assert
    expect(r.t.sent('cmd')).toHaveLength(1)
    expect(r.c.linkState).toBe('homing')
    expect(r.t.sent('home')).toHaveLength(homesBefore + 1)
    expect(r.logs.some((l) => /re-homing before streaming/.test(l.text))).toBe(true)
    r.t.emit({ t: 'ack', of: 'home', ok: true })
    r.clock.now += 20
    r.c.tick(r.m, 0.02, r.clock.now)
    expect(r.c.linkState).toBe('live')
    expect(r.t.sent('cmd')).toHaveLength(2)
  })

  it('resumes streaming after a pause with a hold watchdog (the board kept accepting cmd)', async () => {
    r.cfg.current = { ...r.cfg.current, watchdogMs: 500, watchdogAction: 'hold' }
    await toLive(r)
    r.clock.now += 2000
    r.c.tick(r.m, 0.016, r.clock.now)
    expect(r.c.linkState).toBe('live')
    expect(r.t.sent('cmd')).toHaveLength(1)
  })

  it('does not re-home at the normal command rate with a relax watchdog', async () => {
    r.cfg.current = { ...r.cfg.current, watchdogMs: 200, watchdogAction: 'relax', commandHz: 10 }
    await toLive(r)
    for (let f = 0; f < 120; f++) {
      r.clock.now += 1000 / 60
      r.c.tick(r.m, 1 / 60, r.clock.now)
    }
    expect(r.c.linkState).toBe('live')
    expect(r.t.sent('home')).toHaveLength(1)
    expect(r.t.sent('cmd').length).toBeGreaterThanOrEqual(19)
  })

  it('measures RTT from ping/pong', async () => {
    await toLive(r)
    r.advance(10)
    const ping = r.t.sent('ping')[0]
    r.clock.now += 12
    r.t.emit({ t: 'pong', id: ping.id as number })
    expect(r.last().rttMs).toBe(12)
  })

  it('uses the wired level on serial and the wireless level on BLE, with a manual override', async () => {
    await toLive(r)
    expect(r.last().level).toBe('joint')
    r.c.setLevelOverride('high')
    r.clock.now += 100
    r.c.tick(r.m, 0.016, r.clock.now)
    expect(r.f.levels.pop()).toBe('high')
    const b = rig(new FakeTransport('ble'))
    await toLive(b)
    expect(b.last().level).toBe('high')
  })

  it('disconnects cleanly back to idle', async () => {
    await toLive(r)
    await r.c.disconnect()
    expect(r.c.linkState).toBe('idle')
    expect(r.t.disconnected).toBe(true)
    expect(r.last().hello).toBeNull()
  })
})

describe('LinkController: handshake failures', () => {
  it('retries hello? every second and fails after 3 s without hello', async () => {
    const r = rig()
    await r.c.connect(r.t)
    r.advance(1000)
    r.advance(1000)
    const beforeTimeout = r.c.linkState
    r.advance(HANDSHAKE_TIMEOUT_MS - 2000)
    expect(beforeTimeout).toBe('handshake')
    expect(r.t.sent('hello?')).toHaveLength(3)
    expect(r.c.linkState).toBe('error')
    expect(r.last().error).toMatchObject({ code: 'hello-timeout', detail: expect.stringMatching(/baud/) })
  })

  it('recovers from a hello timeout when a late hello arrives', async () => {
    const r = rig()
    await r.c.connect(r.t)
    r.advance(HANDSHAKE_TIMEOUT_MS)
    r.t.emit(HELLO)
    expect(r.c.linkState).toBe('ready')
    expect(r.last().error).toBeNull()
  })

  it('RETRY restarts the handshake', async () => {
    const r = rig()
    await r.c.connect(r.t)
    r.advance(HANDSHAKE_TIMEOUT_MS)
    expect(r.c.canRetry).toBe(true)
    r.c.retry()
    expect(r.c.linkState).toBe('handshake')
  })

  it('explains a robot mismatch and offers what the board announced', async () => {
    const r = rig()
    await r.c.connect(r.t)
    r.t.emit({ ...HELLO, legs: 4, joints: 12 })
    expect(r.c.linkState).toBe('error')
    const err = r.last().error
    expect(err?.code).toBe('mismatch')
    expect(err?.message).toBe('Board is a WALKER (12 joints, 4 legs); the active robot is a WALKER (18 joints, 6 legs).')
    expect(err?.suggest).toEqual({ robot: 'walker', joints: 12, legs: 4, wheels: undefined, drones: undefined })
  })

  it('re-verifies when the robot is reshaped to match the board after a mismatch', async () => {
    const r = rig()
    r.c.sourceEnter(r.m)
    await r.c.connect(r.t)
    r.t.emit({ ...HELLO, legs: 4, joints: 12 })
    r.f.spec = spec(12, 4)
    r.f.revision++
    r.c.tick(r.m, 0.016, r.clock.now)
    expect(r.c.linkState).toBe('homing')
  })

  it('rejects a different robot kind', async () => {
    const r = rig()
    await r.c.connect(r.t)
    r.t.emit({ t: 'hello', proto: 1, board: 'esp32', robot: 'sweeper', wheels: 4, joints: 4 })
    expect(r.last().error?.suggest?.robot).toBe('sweeper')
  })

  it('rejects another protocol version', async () => {
    const r = rig()
    await r.c.connect(r.t)
    r.t.emit({ ...HELLO, proto: 2 })
    expect(r.last().error?.code).toBe('proto')
  })

  it('returns to idle without an error when the user cancels the chooser', async () => {
    const r = rig()
    r.t.connectImpl = async () => {
      const e = new Error('No port selected by the user.')
      e.name = 'NotFoundError'
      throw e
    }
    await r.c.connect(r.t)
    expect(r.c.linkState).toBe('idle')
    expect(r.last().error).toBeNull()
  })

  it('reports a failed open and an unsupported transport as errors', async () => {
    const r = rig()
    r.t.connectImpl = async () => {
      const e = new Error('Failed to open serial port.')
      e.name = 'NetworkError'
      throw e
    }
    await r.c.connect(r.t)
    expect(r.last().error?.code).toBe('connect-failed')
    const u = rig()
    u.t.supported = false
    await u.c.connect(u.t)
    expect(u.last().error?.code).toBe('unsupported')
  })
})

describe('LinkController: homing, estop, stale, link loss', () => {
  it('fails after 5 s without a home ack, and RETRY re-sends home', async () => {
    const r = rig()
    r.c.sourceEnter(r.m)
    await r.c.connect(r.t)
    r.t.emit(HELLO)
    r.advance(HOME_TIMEOUT_MS)
    expect(r.last().error?.code).toBe('home-timeout')
    r.c.retry()
    expect(r.c.linkState).toBe('homing')
    expect(r.t.sent('home')).toHaveLength(2)
  })

  it('reports a refused home', async () => {
    const r = rig()
    r.c.sourceEnter(r.m)
    await r.c.connect(r.t)
    r.t.emit(HELLO)
    r.t.emit({ t: 'ack', of: 'home', ok: false, msg: 'servo power low' })
    expect(r.last().error).toMatchObject({ code: 'home-failed', message: 'The board refused HOME: servo power low.' })
  })

  it('E-STOP sends estop, stops streaming and needs HOME to go live again', async () => {
    const r = rig()
    await toLive(r)
    r.c.estop()
    r.t.emit({ t: 'ack', of: 'estop', ok: true })
    for (let f = 0; f < 30; f++) {
      r.clock.now += 16
      r.c.tick(r.m, 0.016, r.clock.now)
    }
    expect(r.t.sent('estop')).toHaveLength(1)
    expect(r.c.linkState).toBe('estopped')
    expect(r.t.sent('cmd')).toHaveLength(0)
    expect(r.c.home()).toBe(true)
    r.t.emit({ t: 'ack', of: 'home', ok: true })
    expect(r.c.linkState).toBe('live')
  })

  it('re-sends an unconfirmed E-STOP every 250 ms and stops once the board acks it', async () => {
    // Arrange
    const r = rig()
    await toLive(r)
    // Act: the first estop line is "lost" (no ack)
    r.c.estop()
    r.advance(ESTOP_RESEND_MS)
    r.advance(ESTOP_RESEND_MS)
    const beforeAck = r.t.sent('estop').length
    r.t.emit({ t: 'ack', of: 'estop', ok: true })
    r.advance(ESTOP_RESEND_MS * 4)
    // Assert
    expect(beforeAck).toBe(3)
    expect(r.t.sent('estop')).toHaveLength(3)
    expect(r.logs.some((l) => l.text === 'board confirmed E-STOP')).toBe(true)
  })

  it('gives up re-sending after a bounded number of tries and says so loudly', async () => {
    const r = rig()
    await toLive(r)
    r.c.estop()
    for (let i = 0; i < ESTOP_MAX_SENDS * 3; i++) r.advance(ESTOP_RESEND_MS)
    expect(r.t.sent('estop')).toHaveLength(ESTOP_MAX_SENDS)
    expect(r.logs.some((l) => /never confirmed E-STOP/.test(l.text))).toBe(true)
    expect(r.c.linkState).toBe('estopped')
  })

  it('allows E-STOP from an error with the link open (a home that timed out may still be moving)', async () => {
    const r = rig()
    r.c.sourceEnter(r.m)
    await r.c.connect(r.t)
    r.t.emit(HELLO)
    r.advance(HOME_TIMEOUT_MS)
    r.c.estop()
    expect(r.c.linkState).toBe('estopped')
    expect(r.t.sent('estop')).toHaveLength(1)
    expect(r.c.home()).toBe(true)
  })

  it('keeps E-STOP latched when the board re-announces itself', async () => {
    const r = rig()
    await toLive(r)
    r.c.estop()
    r.t.emit(HELLO)
    expect(r.c.linkState).toBe('estopped')
  })

  it('flags telemetry STALE after 500 ms of silence and clears it on the next tel', async () => {
    const r = rig()
    await toLive(r)
    r.t.emit({ t: 'tel', ms: 1 })
    r.advance(400)
    const fresh = r.last().stale
    r.advance(200)
    const stale = r.last().stale
    r.t.emit({ t: 'tel', ms: 2 })
    expect(fresh).toBe(false)
    expect(stale).toBe(true)
    expect(r.last().stale).toBe(false)
  })

  it('leaving HARDWARE while live homes the robot and rests in ready', async () => {
    const r = rig()
    await toLive(r)
    r.c.sourceExit()
    expect(r.c.linkState).toBe('homing')
    expect(r.t.sent('home')).toHaveLength(2)
    r.t.emit({ t: 'ack', of: 'home', ok: true })
    expect(r.c.linkState).toBe('ready')
  })

  it('re-homes when the board resets mid-stream (a new hello while live)', async () => {
    const r = rig()
    await toLive(r)
    r.t.emit(HELLO)
    expect(r.c.linkState).toBe('homing')
  })

  it('goes to disconnected with an explanation when the link drops', async () => {
    const r = rig()
    await toLive(r)
    r.t.drop('device lost')
    expect(r.c.linkState).toBe('disconnected')
    expect(r.last().error).toMatchObject({ code: 'transport-lost' })
    r.c.tick(r.m, 0.016, r.clock.now + 100)
    expect(r.t.sent('cmd')).toHaveLength(0)
  })
})

describe('LinkController: robot changes and hostile lines', () => {
  it('re-flashes a loopback device when the robot changes and redoes the handshake', async () => {
    const r = rig(new FakeTransport('loopback', true))
    await toLive(r)
    const { m: next } = fakeModule(spec(12, 4))
    r.c.robotChanged(next)
    expect(r.t.reflashCount).toBe(1)
    expect(r.c.linkState).toBe('handshake')
  })

  it('re-verifies real hardware against the new robot and reports a mismatch', async () => {
    const r = rig()
    await toLive(r)
    const { m: next } = fakeModule({ ...spec(4, 0), robot: 'sweeper', legs: undefined, wheels: 4 })
    r.c.robotChanged(next)
    expect(r.last().error?.code).toBe('mismatch')
  })

  it('detects a leg-count change on the same module through its revision', async () => {
    const r = rig(new FakeTransport('loopback', true))
    await toLive(r)
    r.f.spec = spec(12, 4)
    r.f.revision++
    r.c.tick(r.m, 0.016, 100)
    expect(r.t.reflashCount).toBe(1)
  })

  it('counts invalid lines, logs boot text as rx, and never crashes on garbage', async () => {
    const r = rig()
    await toLive(r)
    r.t.emit('rst:0x1 (POWERON_RESET),boot:0x13')
    r.t.emit('{"t":"tel","ang":[1e999]}')
    r.t.emit('{"t":"warp"}')
    expect(r.last().droppedLines).toBe(1)
    expect(r.logs.filter((l) => l.dir === 'sys').map((l) => l.text).join('\n')).toMatch(/dropped 'tel'.*finite[\s\S]*unknown message type 'warp'/)
    expect(r.c.linkState).toBe('live')
  })

  it('counts lines the framer dropped as oversized and warns once about the baud rate', async () => {
    // Arrange
    const r = rig()
    await toLive(r)
    // Act
    r.t.oversize(9000)
    r.t.oversize(12000)
    // Assert
    expect(r.last().droppedLines).toBe(2)
    const warns = r.logs.filter((l) => /dropped a \d+-byte line/.test(l.text))
    expect(warns).toHaveLength(1)
    expect(warns[0].text).toMatch(/9000-byte line .*check the baud rate/)
  })

  it('stops listening for dropped lines after disconnect', async () => {
    // Arrange
    const r = rig()
    await toLive(r)
    await r.c.disconnect()
    // Act
    r.t.oversize(9000)
    // Assert
    expect(r.last().droppedLines).toBe(0)
  })

  it('refuses to send a command with NaN', async () => {
    const r = rig()
    await toLive(r)
    r.f.nextCmd = { t: 'cmd', q: [NaN] }
    r.clock.now += 100
    r.c.tick(r.m, 0.016, r.clock.now)
    expect(r.t.sent('cmd')).toHaveLength(0)
    expect(r.logs.some((l) => /non-finite/.test(l.text))).toBe(true)
  })

  it('logs a backlog warning when the transport drops a command', async () => {
    const r = rig()
    await toLive(r)
    r.t.full = true
    r.clock.now += 100
    r.c.tick(r.m, 0.016, r.clock.now)
    expect(r.logs.some((l) => /backlog/.test(l.text))).toBe(true)
  })

  it('sends override commands while set, falls back to the module when it returns null, and E-STOP clears it', async () => {
    const r = rig()
    await toLive(r)
    let left = 2
    r.c.setCommandOverride(() => (left-- > 0 ? { t: 'cmd', q: [7] } : null))
    for (let f = 0; f < 4; f++) {
      r.clock.now += 25
      r.c.tick(r.m, 0.025, r.clock.now)
    }
    const qs = r.t.sent('cmd').map((c) => (c.q as number[])[0])
    expect(qs.slice(0, 2)).toEqual([7, 7])
    expect(qs[2]).toBe(1.5)
    expect(r.c.overriding).toBe(false)
    r.c.setCommandOverride(() => ({ t: 'cmd', q: [7] }))
    r.c.estop()
    expect(r.c.overriding).toBe(false)
  })

  it('keeps its rate-limit memory bounded against a stream of distinct unknown types', async () => {
    // Arrange
    const r = rig()
    await toLive(r)
    // Act: more distinct hostile 't' values than the memory holds, then the first one again at once
    for (let i = 0; i < 300; i++) r.t.emit({ t: `x${i}` })
    r.t.emit({ t: 'x0' })
    // Assert: every new type warned once; the map was reset, so x0 warns again instead of growing forever
    const warns = r.logs.filter((l) => /unknown message type 'x/.test(l.text))
    expect(warns).toHaveLength(301)
    expect(r.c.linkState).toBe('live')
  })

  it('sends raw serial-monitor lines only while connected', async () => {
    const r = rig()
    expect(r.c.sendRaw('{"t":"ping","id":1}')).toBe(false)
    await r.c.connect(r.t)
    expect(r.c.sendRaw('{"t":"ping","id":1}')).toBe(true)
  })
})
