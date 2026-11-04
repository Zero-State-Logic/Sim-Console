import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig, type HardwareConfig } from '../core/hardware'
import type { CmdMsg, TelMsg, TransportId } from '../core/protocol'
import type { CommandLevel, HardwareSpec, RobotModule } from '../core/types'
import { BridgeHost, PUMP_MS } from './host'
import { LogRing } from './link/logRing'
import type { BridgeState } from './store'
import type { TransportContext } from './transports'
import type { Transport, TransportEventState } from './types'

/* ---------------- fakes ---------------- */

class FakeTransport implements Transport {
  written: string[] = []
  private lineFns = new Set<(l: string) => void>()
  private stateFns = new Set<(s: TransportEventState, d?: string) => void>()
  constructor(readonly id: TransportId) {}
  isSupported(): boolean {
    return true
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  write(line: string): boolean {
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
  emit(msg: object): void {
    for (const fn of this.lineFns) fn(JSON.stringify(msg))
  }
  lost(): void {
    for (const fn of this.stateFns) fn('closed', 'cable')
  }
  sent(t: string): Record<string, unknown>[] {
    return this.written.map((l) => JSON.parse(l) as Record<string, unknown>).filter((m) => m.t === t)
  }
}

function walkerSpec(): HardwareSpec {
  return {
    robot: 'walker',
    joints: 6,
    jointNames: Array.from({ length: 6 }, (_, i) => `J${i}`),
    jointLimits: Array.from({ length: 6 }, () => [-90, 90] as [number, number]),
    homePose: new Array<number>(6).fill(0),
    legs: 2,
    defaultLevel: { wired: 'joint', wireless: 'high' },
  }
}

function fakeModule(): RobotModule {
  const spec = walkerSpec()
  return {
    revision: 0,
    getHardwareSpec: () => spec,
    buildCommand: (_level: CommandLevel): CmdMsg => ({ t: 'cmd', q: [1, 2, 3, 4, 5, 6] }),
    applyTelemetry: (_tel: TelMsg) => undefined,
  } as unknown as RobotModule
}

interface Rig {
  host: BridgeHost
  clock: { now: number }
  cfg: { current: HardwareConfig }
  state: Partial<BridgeState>
  transports: FakeTransport[]
  contexts: TransportContext[]
  timer: { fn: (() => void) | null; ms: number; stops: number }
  log: LogRing
  m: RobotModule
  pump: (ms: number) => void
}

function rig(transport: TransportId = 'loopback'): Rig {
  const clock = { now: 0 }
  const cfg = { current: { ...defaultHardwareConfig('esp32', 6), transport } }
  const state: Partial<BridgeState> = {}
  const transports: FakeTransport[] = []
  const contexts: TransportContext[] = []
  const timer: Rig['timer'] = { fn: null, ms: 0, stops: 0 }
  const log = new LogRing(100)
  const host = new BridgeHost({
    now: () => clock.now,
    startTimer: (fn, ms) => {
      timer.fn = fn
      timer.ms = ms
      return () => {
        timer.fn = null
        timer.stops++
      }
    },
    getConfig: () => cfg.current,
    setConfig: (patch) => void (cfg.current = { ...cfg.current, ...patch }),
    publish: (patch) => void Object.assign(state, patch),
    log,
    makeTransport: (id, ctx) => {
      contexts.push(ctx)
      const t = new FakeTransport(id)
      transports.push(t)
      return t
    },
    miscalibrate: true,
  })
  const m = fakeModule()
  return {
    host, clock, cfg, state, transports, contexts, timer, log, m,
    pump: (ms) => {
      clock.now += ms
      timer.fn?.()
    },
  }
}

const HELLO = { t: 'hello', proto: 1, board: 'esp32', robot: 'walker', legs: 2, joints: 6, fw: 'kiyobridge-1.0' }

async function live(r: Rig): Promise<FakeTransport> {
  r.host.onSourceEnter(r.m)
  await r.host.connect(r.m)
  const t = r.transports[r.transports.length - 1]
  t.emit(HELLO)
  t.emit({ t: 'ack', of: 'home', ok: true })
  return t
}

/* ---------------- tests ---------------- */

describe('BridgeHost: lifecycle', () => {
  it('builds the transport the profile selects and starts the 20 Hz pump only once a link is attached', async () => {
    // Arrange
    const r = rig('ble')
    expect(r.timer.fn).toBeNull()
    // Act
    await r.host.connect(r.m)
    // Assert
    expect(r.transports[0].id).toBe('ble')
    expect(r.timer.ms).toBe(PUMP_MS)
    expect(r.timer.fn).not.toBeNull()
    expect(r.state.state).toBe('handshake')
    expect(r.contexts[0].miscalibrate).toBe(true)
    expect(r.contexts[0].spec().joints).toBe(6)
  })

  it('reaches LIVE through the runtime hooks and streams on tick', async () => {
    // Arrange
    const r = rig()
    const t = await live(r)
    // Act
    r.clock.now += 100
    r.host.tick(r.m, 0.016, 0)
    // Assert
    expect(r.state.state).toBe('live')
    expect(t.sent('cmd')).toHaveLength(1)
    expect(r.state.sourceActive).toBe(true)
  })

  it('times out the handshake from the pump even while the drive source is not HARDWARE', async () => {
    // Arrange
    const r = rig()
    await r.host.connect(r.m)
    // Act
    for (let i = 0; i < 70; i++) r.pump(PUMP_MS)
    // Assert
    expect(r.state.state).toBe('error')
    expect(r.state.error?.code).toBe('hello-timeout')
    expect(r.state.canRetry).toBe(true)
  })

  it('stops the pump once the link is gone, and parks the robot when the source exits', async () => {
    // Arrange
    const r = rig()
    const t = await live(r)
    // Act
    r.host.onSourceExit(r.m)
    const homes = t.sent('home').length
    t.lost()
    r.pump(PUMP_MS)
    // Assert
    expect(homes).toBe(2)
    expect(r.state.state).toBe('disconnected')
    expect(r.timer.fn).toBeNull()
    expect(r.timer.stops).toBe(1)
  })

  it('takes the virtual mounting error option into the next connection', async () => {
    // Arrange
    const r = rig()
    // Act
    r.host.setMiscalibrate(false)
    await r.host.connect(r.m)
    // Assert
    expect(r.state.miscalibrate).toBe(false)
    expect(r.host.miscalibrate).toBe(false)
    expect(r.contexts[0].miscalibrate).toBe(false)
  })
})

describe('BridgeHost: serial monitor send line', () => {
  it('refuses invalid JSON and anything while disconnected', () => {
    // Arrange
    const r = rig()
    // Act / Assert
    expect(r.host.sendLine('{"t":')).toMatchObject({ ok: false })
    expect(r.host.sendLine('[1,2]')).toEqual({ ok: false, message: 'must be a JSON object' })
    expect(r.host.sendLine('{"t":"ping","id":1}')).toEqual({ ok: false, message: 'not connected' })
  })

  it('routes estop and home through the state machine so the UI and the board agree', async () => {
    // Arrange
    const r = rig()
    const t = await live(r)
    // Act
    const stop = r.host.sendLine('{"t":"estop"}')
    const stateAfterStop = r.state.state
    const home = r.host.sendLine(' {"t": "home"} ')
    // Assert
    expect(stop.ok).toBe(true)
    expect(stateAfterStop).toBe('estopped')
    expect(home).toEqual({ ok: true, message: 'sent' })
    expect(r.state.state).toBe('homing')
    expect(t.sent('estop')).toHaveLength(1)
  })

  it('renumbers typed pings away from the controller ids and notes non-protocol types', async () => {
    // Arrange
    const r = rig()
    const t = await live(r)
    // Act
    r.host.sendLine('{"t":"ping","id":1}')
    const custom = r.host.sendLine('{"t":"blink","n":3}')
    // Assert
    const pings = t.sent('ping').map((p) => p.id as number)
    expect(pings[pings.length - 1]).toBeGreaterThanOrEqual(900_000)
    expect(custom).toEqual({ ok: true, message: "sent ('blink' is not a protocol v1 message)" })
    expect(t.written[t.written.length - 1]).toBe('{"t":"blink","n":3}')
  })

  it('refuses HOME before the board is verified', async () => {
    // Arrange
    const r = rig()
    await r.host.connect(r.m)
    // Act
    const res = r.host.sendLine('{"t":"home"}')
    // Assert
    expect(res).toEqual({ ok: false, message: 'HOME needs a verified board' })
  })
})

describe('BridgeHost: log publishing', () => {
  it('publishes the log revision, clears and exports NDJSON', async () => {
    // Arrange
    const r = rig()
    await live(r)
    // Act
    const exported = r.host.exportLog()
    const revBefore = r.state.logRev
    r.host.clearLog()
    // Assert
    expect(revBefore).toBeGreaterThan(0)
    const lines = exported.trim().split('\n').map((l) => JSON.parse(l) as { dir: string; text: string })
    expect(lines.some((l) => l.dir === 'rx' && l.text.includes('"hello"'))).toBe(true)
    expect(lines.some((l) => l.dir === 'tx' && l.text === '{"t":"home"}')).toBe(true)
    expect(r.log.length).toBe(0)
    expect(r.state.logRev).toBeGreaterThan(revBefore ?? 0)
  })

  it('throttles log revisions from the pump to the publish interval', async () => {
    // Arrange
    const r = rig()
    const t = await live(r)
    let publishes = 0
    let last = r.state.logRev
    // Act: 20 lines arrive within 50 ms, pumped every 5 ms
    for (let i = 0; i < 10; i++) {
      t.emit({ t: 'log', lvl: 'info', msg: `m${i}` })
      t.emit({ t: 'log', lvl: 'info', msg: `n${i}` })
      r.pump(5)
      if (r.state.logRev !== last) publishes++
      last = r.state.logRev
    }
    // Assert
    expect(publishes).toBeLessThanOrEqual(1)
  })
})

describe('BridgeHost: calibration wiring', () => {
  it('explains why calibration cannot start until LIVE', async () => {
    // Arrange
    const r = rig()
    // Act
    const before = r.host.calibBlocker()
    await live(r)
    const after = r.host.calibBlocker()
    // Assert
    expect(before).toMatch(/LIVE link/)
    expect(after).toBeNull()
  })

  it('records commands and telemetry, and a robot change drops the take', async () => {
    // Arrange
    const r = rig()
    const t = await live(r)
    r.host.calibRecord()
    // Act
    for (let i = 0; i < 5; i++) {
      r.clock.now += 20
      r.host.tick(r.m, 0.016, 0)
      t.emit({ t: 'tel', ms: i, ang: [1, 2, 3, 4, 5, 6] })
    }
    r.pump(300)
    const recorded = { ...r.state.calib }
    r.host.onRobotChange(r.m)
    // Assert
    expect(recorded.recording).toBe(true)
    expect(recorded.cmdSamples).toBe(5)
    expect(recorded.telSamples).toBe(5)
    expect(r.state.calib?.recording).toBe(false)
    expect(r.state.calib?.cmdSamples).toBe(0)
  })

  it('E-STOP ends a running step sweep', async () => {
    // Arrange
    const r = rig()
    await live(r)
    r.host.calibSweep()
    const sweeping = r.state.calib?.sweeping
    // Act
    r.host.estop()
    // Assert
    expect(sweeping).toBe(true)
    expect(r.state.calib?.sweeping).toBe(false)
    expect(r.state.state).toBe('estopped')
  })

  it('RESET CALIBRATION writes the identity mapping into the profile', async () => {
    // Arrange
    const r = rig()
    await live(r)
    r.cfg.current = { ...r.cfg.current, jointScale: [1.1, 1, 1, 1, 1, 0.9], jointOffsetDeg: [2, 0, 0, 0, 0, -3] }
    // Act
    r.host.calibReset()
    // Assert
    expect(r.cfg.current.jointScale).toEqual([1, 1, 1, 1, 1, 1])
    expect(r.cfg.current.jointOffsetDeg).toEqual([0, 0, 0, 0, 0, 0])
  })
})
