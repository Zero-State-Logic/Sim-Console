import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig } from '../core/hardware'
import type { SandboxFnDef } from '../core/types'
import type { HwMap, LoadMsg, OutMsg, WorkerMsg } from './protocol'
import { fakeCompiler } from './runner/fakeCompiler'
import { GLOBALS_INTERVAL_MS, WorkerCore } from './workerCore'

const API: SandboxFnDef[] = [
  { name: 'walk', kind: 'command', params: ['vx', 'vy', 'wz'], doc: '' },
  { name: 'readImu', kind: 'query', params: ['axis'], sensor: 'imu', doc: '' },
]

function hw(): HwMap {
  const c = defaultHardwareConfig('esp32', 12)
  return {
    board: c.board,
    servoDriver: c.servoDriver,
    servoPins: c.servoPins,
    servoMinUs: c.servoMinUs,
    servoMaxUs: c.servoMaxUs,
    servoRangeDeg: c.servoRangeDeg,
    jointInvert: c.jointInvert,
    jointOffsetDeg: c.jointOffsetDeg,
    jointScale: c.jointScale,
  }
}

function load(source: string, dialect: 'cpp' | 'js' = 'js', id = 1): LoadMsg {
  return { t: 'load', id, dialect, source, api: API, hw: hw(), intBits: 32 }
}

function harness() {
  let now = 0
  const posted: WorkerMsg[] = []
  const fc = fakeCompiler()
  const core = new WorkerCore({ compiler: fc, clock: () => now }, (m) => posted.push(m))
  const tick = async (seq: number, nowMs: number, extra: Record<string, unknown> = {}): Promise<OutMsg> => {
    await core.receive({ t: 'tick', seq, nowMs, sensors: { imu: [0, 0, 9] }, ...extra })
    return posted[posted.length - 1] as OutMsg
  }
  return {
    core,
    fc,
    posted,
    tick,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('WorkerCore: load', () => {
  it('replies loaded ok with the load id and compile time', async () => {
    const h = harness()
    await h.core.receive(load('function loop() {}', 'js', 7))
    expect(h.posted[0]).toMatchObject({ t: 'loaded', id: 7, ok: true, diagnostics: [] })
  })

  it('replies loaded not ok with diagnostics for a bad JS program', async () => {
    const h = harness()
    await h.core.receive(load('function (', 'js'))
    const msg = h.posted[0]
    expect(msg.t === 'loaded' && msg.ok).toBe(false)
    expect(msg.t === 'loaded' && msg.diagnostics[0].severity).toBe('error')
  })

  it('compiles C++ through the injected compiler', async () => {
    const h = harness()
    await h.core.receive(load('void loop() {}', 'cpp'))
    expect(h.posted[0]).toMatchObject({ t: 'loaded', ok: true })
    expect(h.fc.lastOptions?.functions.some((f) => f.name === 'readImu')).toBe(true)
  })

  it('ignores malformed messages', async () => {
    const h = harness()
    await h.core.receive({ t: 'load', id: 'x' })
    await h.core.receive('garbage')
    expect(h.posted).toEqual([])
  })
})

describe('WorkerCore: tick', () => {
  it('returns the commands, serial output and status of one tick', async () => {
    const h = harness()
    await h.core.receive(load("function loop() { walk(0.1, 0, readImu(2)); Serial.print('hi') }"))
    const out = await h.tick(1, 0)
    expect(out).toMatchObject({ t: 'out', seq: 1, status: 'running', loops: 1, cmds: [{ fn: 'walk', args: [0.1, 0, 9] }], serial: ['hi'] })
  })

  it('answers halted when nothing is loaded so the main thread never waits', async () => {
    const h = harness()
    const out = await h.tick(3, 0)
    expect(out).toMatchObject({ seq: 3, status: 'halted', cmds: [] })
  })

  it('delivers console input to Serial.read()', async () => {
    const h = harness()
    await h.core.receive(load('function loop() { while (Serial.available() > 0) Serial.write(Serial.read()) }'))
    const out = await h.tick(1, 0, { input: 'ok\n' })
    expect(out.serial.join('')).toBe('ok\n')
  })

  it('sends globals at about 4 Hz, on demand, and when the status changes', async () => {
    const h = harness()
    await h.core.receive(load("let n = 0\nasync function loop() { n++; watch('n', n); if (n === 3) await delay(1000) }"))
    expect((await h.tick(1, 0)).globals).toBeDefined()
    h.advance(10)
    expect((await h.tick(2, 16)).globals).toBeUndefined()
    h.advance(10)
    expect((await h.tick(3, 32, { wantGlobals: true })).globals).toEqual([{ name: 'n', value: '3' }])
    h.advance(GLOBALS_INTERVAL_MS)
    expect((await h.tick(4, 48)).globals).toBeDefined()
  })

  it('still replies when a watched value throws while it is formatted', async () => {
    // Arrange: a watched object whose getter throws (it runs outside the user's call)
    const h = harness()
    await h.core.receive(load("const bad = { get x() { throw new Error('nope') } }\nfunction loop() { watch('bad', bad) }"))
    // Act
    const out = await h.tick(1, 0)
    // Assert: the tick is answered (no false watchdog bite) and the problem is shown
    expect(out).toMatchObject({ seq: 1, status: 'running' })
    expect(out.globals?.[0].value).toContain('nope')
  })

  it('processes messages strictly in order', async () => {
    const h = harness()
    void h.core.receive(load("function loop() { Serial.print('x') }"))
    void h.core.receive({ t: 'tick', seq: 1, nowMs: 0, sensors: {} })
    await h.core.receive({ t: 'tick', seq: 2, nowMs: 16, sensors: {} })
    expect(h.posted.map((m) => m.t)).toEqual(['loaded', 'out', 'out'])
  })
})

describe('WorkerCore: reset and stop', () => {
  it('reset runs setup() again with fresh JS globals', async () => {
    const h = harness()
    await h.core.receive(load("let n = 0\nfunction setup() { Serial.print('S') }\nfunction loop() { n++; Serial.print(n) }"))
    await h.tick(1, 0)
    await h.tick(2, 16)
    await h.core.receive({ t: 'reset' })
    const out = await h.tick(3, 32)
    expect(out.serial.join('')).toBe('S1')
  })

  it('reset rewinds the C++ VM', async () => {
    const h = harness()
    await h.core.receive(load('void loop() {}', 'cpp'))
    await h.tick(1, 0)
    await h.core.receive({ t: 'reset' })
    expect(h.fc.resets).toBe(1)
  })

  it('stop unloads the program', async () => {
    const h = harness()
    await h.core.receive(load("function loop() { Serial.print('x') }"))
    await h.core.receive({ t: 'stop' })
    expect((await h.tick(1, 0)).status).toBe('halted')
  })
})
