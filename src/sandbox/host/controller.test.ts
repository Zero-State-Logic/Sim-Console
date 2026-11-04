import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultHardwareConfig } from '../../core/hardware'
import type { HardwareSpec, RobotModule, SandboxCommand, SandboxFnDef, SensorSnapshot } from '../../core/types'
import type { LoadMsg, MainMsg, TickMsg } from '../protocol'
import { createSandboxStore } from '../store'
import { ConsoleBuffer } from './consoleBuffer'
import { LOAD_LIMIT_MS, SandboxController, TICK_LIMIT_MS, type WorkerLike } from './controller'
import { SourceStore, type KV } from './persist'
import { realTimers } from './watchdog'

const API: SandboxFnDef[] = [
  { name: 'walk', kind: 'command', params: ['vx', 'vy', 'wz'], doc: '' },
  { name: 'setJoint', kind: 'command', params: ['joint', 'deg'], doc: '' },
  { name: 'readImu', kind: 'query', params: ['axis'], sensor: 'imu', doc: '' },
]

class FakeWorker implements WorkerLike {
  posted: MainMsg[] = []
  terminated = false
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  postMessage(msg: MainMsg): void {
    this.posted.push(msg)
  }
  terminate(): void {
    this.terminated = true
  }
  reply(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }
  last<T extends MainMsg['t']>(t: T): Extract<MainMsg, { t: T }> {
    const m = [...this.posted].reverse().find((x) => x.t === t)
    if (!m) throw new Error(`no ${t} posted`)
    return m as Extract<MainMsg, { t: T }>
  }
  count(t: MainMsg['t']): number {
    return this.posted.filter((x) => x.t === t).length
  }
}

interface FakeModule {
  module: RobotModule
  applied: SandboxCommand[][]
  releases: number
}

function fakeModule(): FakeModule {
  const spec: HardwareSpec = {
    robot: 'walker',
    joints: 18,
    jointNames: [],
    jointLimits: [],
    homePose: [],
    legs: 6,
    defaultLevel: { wired: 'joint', wireless: 'high' },
  }
  const fm: FakeModule = { module: null as unknown as RobotModule, applied: [], releases: 0 }
  const partial = {
    kind: 'walker',
    label: 'WALKER',
    getSandboxApi: () => API,
    getSandboxSensors: (): SensorSnapshot => ({ imu: [1, 2, 3] }),
    applySandboxCommands: (c: SandboxCommand[]) => fm.applied.push(c),
    releaseSandbox: () => {
      fm.releases++
    },
    getHardwareSpec: () => spec,
  }
  // only the CODE-source surface of RobotModule is exercised here
  fm.module = partial as unknown as RobotModule
  return fm
}

function memoryKV(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

function harness() {
  const workers: FakeWorker[] = []
  const store = createSandboxStore()
  const kv = memoryKV()
  const ctl = new SandboxController({
    spawn: () => {
      const w = new FakeWorker()
      workers.push(w)
      return w
    },
    store,
    console: new ConsoleBuffer(),
    persist: new SourceStore(kv),
    hardware: () => defaultHardwareConfig('esp32', 12),
    timers: realTimers,
    clock: () => Date.now(),
  })
  const fm = fakeModule()
  ctl.onRobotChange(fm.module)
  ctl.onSourceEnter(fm.module)
  const worker = (): FakeWorker => workers[workers.length - 1]
  const st = () => store.getState()
  /** RUN and answer the load. */
  const start = (ok = true): LoadMsg => {
    ctl.run()
    const load = worker().last('load')
    worker().reply({ t: 'loaded', id: load.id, ok, diagnostics: ok ? [] : [{ severity: 'error', message: "expected ';'", line: 2, col: 5 }], compileMs: 1.5, log: [] })
    return load
  }
  const out = (seq: number, extra: Record<string, unknown> = {}) =>
    worker().reply({ t: 'out', seq, cmds: [], serial: [], log: [], status: 'running', line: 3, led: 0, executed: 10, loops: 1, ...extra })
  return { ctl, store, kv, fm, workers, worker, st, start, out }
}

describe('SandboxController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads the robot API, examples and the first example as the buffer', () => {
    const h = harness()
    expect(h.st().kind).toBe('walker')
    expect(h.st().api.map((f) => f.name)).toEqual(['walk', 'setJoint', 'readImu'])
    expect(h.st().examples.length).toBeGreaterThanOrEqual(3)
    expect(h.st().source).toContain('walk(')
    expect(h.st().state).toBe('idle')
  })

  it('RUN posts a load with the API and the profile fitted to the robot', () => {
    // Arrange
    const h = harness()
    // Act
    h.ctl.run()
    // Assert
    const load = h.worker().last('load')
    expect(h.st().state).toBe('compiling')
    expect(load.dialect).toBe('cpp')
    expect(load.api).toEqual(API)
    expect(load.hw.servoPins).toHaveLength(18)
    expect(load.hw.servoDriver).toBe('pca9685')
    expect(load.intBits).toBe(32)
  })

  it('goes running on a good load and error with diagnostics on a bad one', () => {
    const good = harness()
    good.start(true)
    expect(good.st().state).toBe('running')
    expect(good.st().stats.compileMs).toBe(1.5)

    const bad = harness()
    bad.start(false)
    expect(bad.st().state).toBe('error')
    expect(bad.st().diagnostics[0].message).toBe("expected ';'")
    expect(bad.st().error?.line).toBe(2)
  })

  it('posts one tick at a time with nowMs = t * 1000 and the sensor snapshot', () => {
    const h = harness()
    h.start()
    h.ctl.tick(h.fm.module, 1 / 60, 2.5)
    h.ctl.tick(h.fm.module, 1 / 60, 2.6)
    expect(h.worker().count('tick')).toBe(1)
    const tick = h.worker().last('tick') as TickMsg
    expect(tick.nowMs).toBe(2500)
    expect(tick.sensors).toEqual({ imu: [1, 2, 3] })
  })

  it('applies the returned commands on the next frame (one frame of latency)', () => {
    // Arrange
    const h = harness()
    h.start()
    h.ctl.tick(h.fm.module, 0.016, 0.016)
    const seq = h.worker().last('tick').seq
    // Act
    h.out(seq, { cmds: [{ fn: 'walk', args: [0.1, 0, 0] }, { fn: 'evil', args: [1] }] })
    // Assert: nothing is applied when the reply lands, only on the following frame
    expect(h.fm.applied).toEqual([])
    h.ctl.tick(h.fm.module, 0.016, 0.032)
    expect(h.fm.applied).toEqual([[{ fn: 'walk', args: [0.1, 0, 0] }]])
    expect(h.worker().count('tick')).toBe(2)
  })

  it('does nothing while the sim is paused (dt = 0)', () => {
    const h = harness()
    h.start()
    h.ctl.tick(h.fm.module, 0, 1)
    expect(h.worker().count('tick')).toBe(0)
  })

  it('drops stale replies', () => {
    const h = harness()
    h.start()
    h.ctl.tick(h.fm.module, 0.016, 0.016)
    h.out(999, { cmds: [{ fn: 'walk', args: [1, 0, 0] }] })
    h.ctl.tick(h.fm.module, 0.016, 0.032)
    expect(h.fm.applied).toEqual([])
    expect(h.worker().count('tick')).toBe(1)
  })

  it('PAUSE stops ticks, STEP runs exactly one even with the sim paused, RUN resumes', () => {
    const h = harness()
    h.start()
    h.ctl.pause()
    h.ctl.tick(h.fm.module, 0.016, 0.016)
    expect(h.worker().count('tick')).toBe(0)
    h.ctl.step()
    h.ctl.tick(h.fm.module, 0, 0.016)
    expect(h.worker().count('tick')).toBe(1)
    expect(h.worker().last('tick').wantGlobals).toBe(true)
    h.out(h.worker().last('tick').seq)
    h.ctl.tick(h.fm.module, 0.016, 0.032)
    expect(h.worker().count('tick')).toBe(1)
    h.ctl.run()
    expect(h.st().state).toBe('running')
    h.ctl.tick(h.fm.module, 0.016, 0.048)
    expect(h.worker().count('tick')).toBe(2)
  })

  it('STEP from idle loads paused and then runs one tick', () => {
    const h = harness()
    h.ctl.step()
    const load = h.worker().last('load')
    h.worker().reply({ t: 'loaded', id: load.id, ok: true, diagnostics: [], compileMs: 1, log: [] })
    expect(h.st().state).toBe('paused')
    h.ctl.tick(h.fm.module, 0.016, 0.016)
    h.ctl.tick(h.fm.module, 0.016, 0.032)
    expect(h.worker().count('tick')).toBe(1)
  })

  it('maps worker run status onto the program state', () => {
    const h = harness()
    h.start()
    h.ctl.tick(h.fm.module, 0.016, 0.016)
    h.out(h.worker().last('tick').seq, { status: 'sleeping', wakeAtMs: 500 })
    expect(h.st().state).toBe('sleeping')
    // a sleeping program is not ticked before its wake time
    h.ctl.tick(h.fm.module, 0.016, 0.2)
    expect(h.worker().count('tick')).toBe(1)
    h.ctl.tick(h.fm.module, 0.016, 0.5)
    expect(h.worker().count('tick')).toBe(2)
    h.out(h.worker().last('tick').seq, { status: 'error', error: { severity: 'error', message: 'division by zero', line: 7, col: 3 } })
    expect(h.st().state).toBe('error')
    expect(h.st().error?.line).toBe(7)
    expect(h.fm.releases).toBeGreaterThan(0)
  })

  it('treats halted as finished and hands the robot back', () => {
    const h = harness()
    h.start()
    const before = h.fm.releases
    h.ctl.tick(h.fm.module, 0.016, 0.016)
    h.out(h.worker().last('tick').seq, { status: 'halted' })
    expect(h.st().state).toBe('stopped')
    expect(h.fm.releases).toBe(before + 1)
  })

  it('WATCHDOG: kills a worker that does not answer within 1 s and recreates it stopped', () => {
    // Arrange
    const h = harness()
    h.start()
    h.ctl.tick(h.fm.module, 0.016, 0.016)
    const first = h.worker()
    const releases = h.fm.releases
    // Act: frames keep rendering, the worker never replies
    for (let ms = 0; ms <= TICK_LIMIT_MS + 50; ms += 16) {
      vi.advanceTimersByTime(16)
      h.ctl.tick(h.fm.module, 0.016, 0.016 + ms / 1000)
    }
    // Assert
    expect(first.terminated).toBe(true)
    expect(h.workers).toHaveLength(2)
    expect(h.st().state).toBe('stopped')
    expect(h.st().error?.message).toBe('loop() blocked for more than 1 s (infinite loop?)')
    expect(h.fm.releases).toBe(releases + 1)
    // and the new worker can run the program again
    h.start()
    expect(h.st().state).toBe('running')
  })

  it('WATCHDOG: also guards a load that never finishes', () => {
    const h = harness()
    h.ctl.run()
    for (let ms = 0; ms <= LOAD_LIMIT_MS + 50; ms += 16) {
      vi.advanceTimersByTime(16)
      h.ctl.tick(h.fm.module, 0.016, ms / 1000)
    }
    expect(h.st().state).toBe('stopped')
    expect(h.st().error?.message).toMatch(/did not finish loading/)
  })

  it('WATCHDOG: a stuck worker abandoned by leaving CODE is still killed, without frames', () => {
    // Arrange: a tick is in flight and the worker is stuck in user code
    const h = harness()
    h.start()
    h.ctl.tick(h.fm.module, 0.016, 0.016)
    const stuck = h.worker()
    // Act: the source leaves CODE (no more frame heartbeats), time passes
    h.ctl.onSourceExit(h.fm.module)
    vi.advanceTimersByTime(TICK_LIMIT_MS + 10)
    // Assert: the worker is reclaimed, the program stays stopped (no error report)
    expect(stuck.terminated).toBe(true)
    expect(h.st().state).toBe('stopped')
    expect(h.st().error).toBeNull()
  })

  it('WATCHDOG: an abandoned request that is answered keeps its worker', () => {
    const h = harness()
    h.start()
    h.ctl.tick(h.fm.module, 0.016, 0.016)
    const seq = h.worker().last('tick').seq
    h.ctl.stop()
    h.out(seq)
    vi.advanceTimersByTime(TICK_LIMIT_MS * 3)
    expect(h.worker().terminated).toBe(false)
    expect(h.workers).toHaveLength(1)
  })

  it('RUN right after STOP never queues the new program behind an unanswered tick', () => {
    // Arrange
    const h = harness()
    h.start()
    h.ctl.tick(h.fm.module, 0.016, 0.016)
    const stuck = h.worker()
    h.ctl.stop()
    // Act
    h.ctl.run()
    // Assert: a fresh worker got the load, the old one was terminated
    expect(stuck.terminated).toBe(true)
    expect(h.workers).toHaveLength(2)
    expect(h.worker().count('load')).toBe(1)
    expect(h.st().state).toBe('compiling')
  })

  it('WATCHDOG: RESET with a stuck tick still reports loop() blocked while the sim is paused', () => {
    const h = harness()
    h.start()
    h.ctl.tick(h.fm.module, 0.016, 0.016)
    h.ctl.reset()
    // the sim is paused: frames keep coming with dt = 0, no new tick is posted
    for (let ms = 0; ms <= TICK_LIMIT_MS + 50; ms += 16) {
      vi.advanceTimersByTime(16)
      h.ctl.tick(h.fm.module, 0, 0.016)
    }
    expect(h.st().state).toBe('stopped')
    expect(h.st().error?.message).toBe('loop() blocked for more than 1 s (infinite loop?)')
    expect(h.workers).toHaveLength(2)
  })

  it('restarts the program from setup() when the sim clock goes back (sim RESET)', () => {
    // Arrange: running at t = 30 s
    const h = harness()
    h.start()
    h.ctl.tick(h.fm.module, 0.016, 30)
    h.out(h.worker().last('tick').seq, { status: 'sleeping', wakeAtMs: 30_100 })
    const releases = h.fm.releases
    // Act: the shell resets the sim, time restarts near 0
    h.ctl.tick(h.fm.module, 0.016, 0.016)
    // Assert: the worker restarts the program and gets a tick at the new time right away
    expect(h.worker().count('reset')).toBe(1)
    expect(h.worker().last('tick').nowMs).toBe(16)
    expect(h.st().state).toBe('running')
    expect(h.fm.releases).toBe(releases + 1)
  })

  it('does not treat the first frame of a new load as a clock jump', () => {
    const h = harness()
    h.start()
    h.ctl.tick(h.fm.module, 0.016, 30)
    h.out(h.worker().last('tick').seq)
    h.ctl.stop()
    h.start()
    h.ctl.tick(h.fm.module, 0.016, 0.5)
    expect(h.worker().count('reset')).toBe(0)
  })

  it('marks the editor dirty and RUN reloads the new source', () => {
    const h = harness()
    h.start()
    h.ctl.setSource('void loop() { stop(); }')
    expect(h.st().dirty).toBe(true)
    h.ctl.run()
    expect(h.worker().count('load')).toBe(2)
    expect(h.worker().last('load').source).toBe('void loop() { stop(); }')
  })

  it('persists the buffer after a short delay', () => {
    const h = harness()
    h.ctl.setSource('// mine')
    expect(h.kv.data.get('simconsole.code.walker.cpp')).toBeUndefined()
    vi.advanceTimersByTime(500)
    expect(h.kv.data.get('simconsole.code.walker.cpp')).toBe('// mine')
  })

  it('switching dialect stops the program, saves the buffer and loads the other one', () => {
    const h = harness()
    h.start()
    h.ctl.setSource('// cpp buffer')
    h.ctl.setDialect('js')
    expect(h.worker().count('stop')).toBe(1)
    expect(h.kv.data.get('simconsole.code.walker.cpp')).toBe('// cpp buffer')
    expect(h.kv.data.get('simconsole.code.dialect')).toBe('js')
    expect(h.st().dialect).toBe('js')
    expect(h.st().source).toContain('async function loop')
    expect(h.st().state).toBe('idle')
  })

  it('loads an example and can restore the replaced buffer', () => {
    const h = harness()
    h.ctl.setSource('// keep me')
    h.ctl.loadExample('walker-wave')
    expect(h.st().source).toContain('setBodyPose')
    expect(h.st().prevSource).toBe('// keep me')
    h.ctl.restorePrevious()
    expect(h.st().source).toBe('// keep me')
  })

  it('RESET restarts the program and releases the robot', () => {
    const h = harness()
    h.start()
    h.ctl.tick(h.fm.module, 0.016, 0.016)
    const releases = h.fm.releases
    h.ctl.reset()
    expect(h.worker().count('reset')).toBe(1)
    expect(h.fm.releases).toBe(releases + 1)
    expect(h.st().state).toBe('running')
    // the in-flight tick was abandoned, so the next frame ticks again
    h.ctl.tick(h.fm.module, 0.016, 0.032)
    expect(h.worker().count('tick')).toBe(2)
  })

  it('leaving CODE stops the program and releases the module', () => {
    const h = harness()
    h.start()
    const releases = h.fm.releases
    h.ctl.onSourceExit(h.fm.module)
    expect(h.st().state).toBe('stopped')
    expect(h.worker().count('stop')).toBe(1)
    expect(h.fm.releases).toBeGreaterThan(releases)
  })

  it('delivers console input with the next tick', () => {
    const h = harness()
    h.start()
    h.ctl.sendSerial('go')
    h.ctl.tick(h.fm.module, 0.016, 0.016)
    expect(h.worker().last('tick').input).toBe('go\n')
  })

  it('reports a crashed worker as an error', () => {
    const h = harness()
    h.ctl.run()
    h.worker().onerror?.({ message: 'SyntaxError in worker', preventDefault: () => {} } as unknown as ErrorEvent)
    expect(h.st().state).toBe('error')
    expect(h.st().error?.message).toContain('SyntaxError in worker')
  })

  it('writes serial output and logs to the console buffer', () => {
    const h = harness()
    h.start()
    h.ctl.tick(h.fm.module, 0.016, 1)
    h.out(h.worker().last('tick').seq, { serial: ['hello\r\n'], log: [{ level: 'warn', text: 'careful' }], led: 1, globals: [{ name: 'n', value: '1' }] })
    expect(h.st().globals).toEqual([{ name: 'n', value: '1' }])
    expect(h.st().led).toBe(1)
  })
})
