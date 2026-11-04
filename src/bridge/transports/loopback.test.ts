import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultHardwareConfig, type HardwareConfig } from '../../core/hardware'
import type { CmdMsg, TelMsg } from '../../core/protocol'
import type { CommandLevel, HardwareSpec, RobotModule } from '../../core/types'
import { LinkController } from '../controller'
import type { LogDir } from '../types'
import { LoopbackTransport } from './loopback'

function walker(legs: number): HardwareSpec {
  const joints = legs * 3
  return {
    robot: 'walker',
    joints,
    jointNames: Array.from({ length: joints }, (_, i) => `J${i}`),
    jointLimits: Array.from({ length: joints }, () => [-80, 80] as [number, number]),
    homePose: Array.from({ length: joints }, (_, i) => [0, 20, -40][i % 3]),
    legs,
    defaultLevel: { wired: 'joint', wireless: 'high' },
  }
}

function makeModule(spec: { current: HardwareSpec }) {
  const applied: TelMsg[] = []
  const m = {
    revision: 0,
    getHardwareSpec: () => spec.current,
    buildCommand: (_l: CommandLevel): CmdMsg => ({ t: 'cmd', q: spec.current.homePose.map((q) => q + 5) }),
    applyTelemetry: (tel: TelMsg) => void applied.push(tel),
  } as unknown as RobotModule
  return { m, applied }
}

describe('controller + loopback virtual device (fake timers)', () => {
  let cfg: HardwareConfig
  let spec: { current: HardwareSpec }
  let logs: { dir: LogDir; text: string }[]
  let c: LinkController
  let t: LoopbackTransport
  let mod: ReturnType<typeof makeModule>
  let frame: ReturnType<typeof setInterval>
  let pump: ReturnType<typeof setInterval>
  let dt: number

  beforeEach(() => {
    vi.useFakeTimers()
    cfg = { ...defaultHardwareConfig('esp32', 6), watchdogMs: 300 }
    spec = { current: walker(2) }
    logs = []
    dt = 1 / 60
    c = new LinkController({
      now: () => Date.now(),
      getConfig: () => cfg,
      onStatus: () => undefined,
      log: (dir, text) => void logs.push({ dir, text }),
    })
    mod = makeModule(spec)
    c.attachModule(mod.m)
    t = new LoopbackTransport({ spec: () => spec.current, config: () => cfg, miscalibrate: false, now: () => Date.now() })
    // the host: a 50 ms pump plus a 60 fps frame loop in HARDWARE
    pump = setInterval(() => c.pump(Date.now()), 50)
    frame = setInterval(() => c.tick(mod.m, dt, Date.now()), 1000 / 60)
  })

  afterEach(() => {
    clearInterval(frame)
    clearInterval(pump)
    vi.useRealTimers()
  })

  async function connectLive(): Promise<void> {
    c.sourceEnter(mod.m)
    const p = c.connect(t)
    await vi.advanceTimersByTimeAsync(200)
    await p
    await vi.advanceTimersByTimeAsync(1500)
  }

  it('reaches LIVE through boot, hello, verify and home, then streams and receives telemetry', async () => {
    // Act
    await connectLive()
    const cmdsBefore = logs.filter((l) => l.dir === 'tx' && l.text.includes('"cmd"')).length
    await vi.advanceTimersByTimeAsync(1000)
    // Assert
    expect(c.linkState).toBe('live')
    const st = c.status()
    expect(st.hello).toMatchObject({ robot: 'walker', joints: 6, fw: 'kiyobridge-1.0-virtual' })
    const cmds = logs.filter((l) => l.dir === 'tx' && l.text.includes('"cmd"')).length - cmdsBefore
    expect(cmds).toBeGreaterThan(40)
    expect(mod.applied.length).toBeGreaterThan(15)
    expect(mod.applied[mod.applied.length - 1].ang?.[1]).toBeCloseTo(25, 0)
    expect(st.rttMs).toBeGreaterThan(2)
    expect(st.rttMs).toBeLessThan(30)
    expect(st.stale).toBe(false)
    expect(logs.some((l) => l.dir === 'rx' && l.text.includes('booting'))).toBe(true)
  })

  it('E-STOP freezes the virtual board and HOME re-arms it', async () => {
    await connectLive()
    c.estop()
    await vi.advanceTimersByTimeAsync(300)
    expect(c.linkState).toBe('estopped')
    expect(t.virtual?.state).toBe('estopped')
    c.home()
    await vi.advanceTimersByTimeAsync(1200)
    expect(c.linkState).toBe('live')
  })

  it('pausing the sim stops commands and the board watchdog reports it', async () => {
    await connectLive()
    dt = 0
    await vi.advanceTimersByTimeAsync(800)
    expect(logs.some((l) => l.dir === 'rx' && l.text.includes('watchdog: no cmd for 300 ms'))).toBe(true)
    expect(c.linkState).toBe('live')
  })

  it('after a pause past a relax watchdog, re-homes the limp board and streams into an accepting board again', async () => {
    // Arrange
    cfg = { ...cfg, watchdogAction: 'relax' }
    await connectLive()
    // Act: pause long enough for the board to go limp and idle, then resume
    dt = 0
    await vi.advanceTimersByTimeAsync(800)
    const boardWhilePaused = t.virtual?.state
    dt = 1 / 60
    await vi.advanceTimersByTimeAsync(1500)
    const mark = logs.length
    await vi.advanceTimersByTimeAsync(1500)
    // Assert
    expect(boardWhilePaused).toBe('idle')
    expect(logs.some((l) => l.dir === 'rx' && l.text.includes('outputs relaxed; send home to resume'))).toBe(true)
    expect(logs.some((l) => l.dir === 'sys' && l.text.includes('re-homing before streaming'))).toBe(true)
    expect(c.linkState).toBe('live')
    expect(t.virtual?.state).toBe('ready')
    expect(logs.slice(mark).some((l) => l.text.includes('cmd ignored'))).toBe(false)
  })

  it('re-flashes for a reshaped robot and goes live again', async () => {
    await connectLive()
    spec.current = walker(4)
    ;(mod.m as unknown as { revision: number }).revision = 1
    await vi.advanceTimersByTimeAsync(2000)
    expect(c.status().hello?.joints).toBe(12)
    expect(c.linkState).toBe('live')
  })

  it('disconnect stops the device', async () => {
    await connectLive()
    await c.disconnect()
    expect(t.virtual).toBeNull()
    expect(c.linkState).toBe('idle')
  })
})
