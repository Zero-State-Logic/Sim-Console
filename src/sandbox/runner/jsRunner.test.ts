import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig } from '../../core/hardware'
import type { SandboxFnDef } from '../../core/types'
import { ArduinoShim } from '../shim/arduino'
import { JsProgram, errorDiagnostic, lineFromStack } from './jsRunner'

const API: SandboxFnDef[] = [
  { name: 'walk', kind: 'command', params: ['vx', 'vy', 'wz'], doc: '' },
  { name: 'readImu', kind: 'query', params: ['axis'], sensor: 'imu', doc: '' },
]

function setup(source: string): { shim: ArduinoShim; prog: JsProgram } {
  const shim = new ArduinoShim({ ...defaultHardwareConfig('esp32', 12) }, API)
  const res = JsProgram.load(source, shim)
  if (!res.program) throw new Error(`load failed: ${res.diagnostics.map((d) => d.message).join('; ')}`)
  return { shim, prog: res.program }
}

async function tickAt(shim: ArduinoShim, prog: JsProgram, ms: number) {
  shim.beginTick(ms, { imu: [1, 2, 3] })
  const out = await prog.tick(ms)
  return { out, io: shim.takeOutput() }
}

describe('JS runner: setup / loop order', () => {
  it('runs setup once, then loop once per tick', async () => {
    // Arrange
    const { shim, prog } = setup(`
      let n = 0
      function setup() { Serial.println('setup') }
      function loop() { n++; Serial.println('loop ' + n) }
    `)
    // Act
    const a = await tickAt(shim, prog, 0)
    const b = await tickAt(shim, prog, 16)
    // Assert
    expect(a.io.serial.join('')).toBe('setup\r\nloop 1\r\n')
    expect(a.out).toMatchObject({ status: 'running', loops: 1 })
    expect(b.io.serial.join('')).toBe('loop 2\r\n')
  })

  it('halts after setup when there is no loop()', async () => {
    const { shim, prog } = setup('function setup() { Serial.print("only") }')
    expect((await tickAt(shim, prog, 0)).out.status).toBe('halted')
  })

  it('collects robot commands and answers queries from the snapshot', async () => {
    const { shim, prog } = setup('function loop() { walk(0.1, 0, readImu(2)) }')
    const { io } = await tickAt(shim, prog, 0)
    expect(io.cmds).toEqual([{ fn: 'walk', args: [0.1, 0, 3] }])
  })
})

describe('JS runner: await delay() on the virtual clock', () => {
  it('suspends across ticks until the virtual deadline', async () => {
    // Arrange: loop prints, waits 50 ms of sim time, prints again
    const { shim, prog } = setup(`
      async function loop() {
        Serial.println('a ' + millis())
        await delay(50)
        Serial.println('b ' + millis())
      }
    `)
    // Act / Assert
    const t0 = await tickAt(shim, prog, 0)
    expect(t0.io.serial.join('')).toBe('a 0\r\n')
    expect(t0.out).toMatchObject({ status: 'sleeping', wakeAtMs: 50, loops: 0 })

    const t1 = await tickAt(shim, prog, 30)
    expect(t1.io.serial.join('')).toBe('')
    expect(t1.out.status).toBe('sleeping')

    // the continuation runs at its deadline (50, as on a board), and the next loop()
    // starts right away instead of idling until the next frame
    const t2 = await tickAt(shim, prog, 60)
    expect(t2.io.serial.join('')).toBe('b 50\r\na 50\r\n')
    expect(t2.out).toMatchObject({ status: 'sleeping', loops: 1, wakeAtMs: 100 })

    const t3 = await tickAt(shim, prog, 76)
    expect(t3.io.serial.join('')).toBe('')
    const t4 = await tickAt(shim, prog, 104)
    expect(t4.io.serial.join('')).toBe('b 100\r\na 100\r\n')
  })

  it('starts loop() at most once per tick, even when the previous one resumed', async () => {
    // Arrange: a loop that never sleeps
    const { shim, prog } = setup(`
      let n = 0
      async function loop() { n++; watch('n', n) }
    `)
    // Act
    await tickAt(shim, prog, 0)
    await tickAt(shim, prog, 16)
    const { out } = await tickAt(shim, prog, 32)
    // Assert
    expect(out.loops).toBe(1)
    expect(prog.globals()).toEqual([{ name: 'n', value: '3' }])
  })

  it('keeps an exact delay() period across frames (delay(20) = 50 Hz at 60 fps)', async () => {
    // Arrange
    const { shim, prog } = setup(`
      let n = 0
      async function loop() { n++; watch('n', n); await delay(20) }
    `)
    // Act: one second of 60 Hz frames
    let loops = 0
    for (let i = 0; i <= 60; i++) loops += (await tickAt(shim, prog, (i * 1000) / 60)).out.loops
    // Assert: 50 completed periods in 1000 ms (+-1 for the edges)
    expect(loops).toBeGreaterThanOrEqual(49)
    expect(loops).toBeLessThanOrEqual(50)
  })

  it('keeps the program clock within a frame of sim time when delay() is shorter than a frame', async () => {
    const { shim, prog } = setup(`
      async function loop() { watch('t', millis()); await delay(1) }
    `)
    for (let i = 0; i <= 120; i++) await tickAt(shim, prog, (i * 1000) / 60)
    const t = Number(prog.globals().find((g) => g.name === 't')?.value)
    expect(2000 - t).toBeLessThanOrEqual(21)
  })

  it('releases timers of un-awaited delay() calls instead of piling them up', async () => {
    // Arrange: a sync loop that fires and forgets a delay every frame
    const { shim, prog } = setup(`
      let fired = 0
      function loop() { delay(5).then(() => { fired++; watch('fired', fired) }) }
    `)
    // Act
    for (let i = 0; i < 10; i++) await tickAt(shim, prog, i * 16)
    // Assert: every one past its deadline resolved; at most the newest is still pending
    const fired = Number(prog.globals().find((g) => g.name === 'fired')?.value)
    expect(fired).toBe(9)
  })

  it('lets an async setup() delay before loop() starts', async () => {
    const { shim, prog } = setup(`
      async function setup() { await delay(100); Serial.print('ready ') }
      function loop() { Serial.print('L') }
    `)
    expect((await tickAt(shim, prog, 0)).io.serial.join('')).toBe('')
    expect((await tickAt(shim, prog, 100)).io.serial.join('')).toBe('ready L')
  })

  it('resolves delay(0) within the same tick', async () => {
    const { shim, prog } = setup(`
      async function loop() { Serial.print('x'); await delay(0); Serial.print('y') }
    `)
    const { io, out } = await tickAt(shim, prog, 0)
    expect(io.serial.join('')).toBe('xy')
    expect(out.loops).toBe(1)
  })

  it('caps delay(0) wake-ups so a busy async loop cannot hold the tick', async () => {
    const { shim, prog } = setup(`
      let n = 0
      async function loop() { while (true) { n++; watch('n', n); await delay(0) } }
    `)
    const { out } = await tickAt(shim, prog, 0)
    expect(out.status).toBe('sleeping')
    const n = Number(prog.globals().find((g) => g.name === 'n')?.value)
    expect(n).toBeGreaterThan(10)
    expect(n).toBeLessThan(200)
  })

  it('warns when delay() is called without await', async () => {
    const { shim, prog } = setup('function loop() { delay(10) }')
    const { io } = await tickAt(shim, prog, 0)
    expect(io.log.some((l) => l.text.includes('await delay'))).toBe(true)
  })
})

describe('JS runner: errors and isolation', () => {
  it('reports syntax errors at load', () => {
    const shim = new ArduinoShim({ ...defaultHardwareConfig('esp32', 12) }, API)
    const res = JsProgram.load('function loop( {', shim)
    expect(res.program).toBeNull()
    expect(res.diagnostics[0].severity).toBe('error')
    expect(res.diagnostics[0].message).toMatch(/SyntaxError/)
  })

  it('reports a runtime error with its source line and stays failed', async () => {
    const { shim, prog } = setup('function loop() {\n  const a = 1\n  undefinedFn(a)\n}')
    const first = await tickAt(shim, prog, 0)
    expect(first.out.status).toBe('error')
    expect(first.out.error?.message).toMatch(/ReferenceError/)
    expect(first.out.error?.line).toBe(3)
    expect((await tickAt(shim, prog, 16)).out.status).toBe('error')
  })

  it('reports a rejected async loop', async () => {
    const { shim, prog } = setup('async function loop() { await delay(1); throw new Error("boom") }')
    await tickAt(shim, prog, 0)
    const { out } = await tickAt(shim, prog, 5)
    expect(out.status).toBe('error')
    expect(out.error?.message).toBe('Error: boom')
  })

  it('hides network and messaging globals from the program', async () => {
    const { shim, prog } = setup(`
      function setup() {
        Serial.print([typeof fetch, typeof postMessage, typeof self, typeof globalThis, typeof importScripts, typeof setTimeout].join(','))
      }
    `)
    expect((await tickAt(shim, prog, 0)).io.serial.join('')).toBe('undefined,undefined,undefined,undefined,undefined,undefined')
  })

  it('lets user code reuse shim names like max / map / random for its own variables', async () => {
    // Arrange
    const { shim, prog } = setup(`
      const max = 3
      let map = new Map([['k', 4]])
      function helper() { return max + map.get('k') }
      function loop() { Serial.print(helper()) }
    `)
    // Act
    const { io, out } = await tickAt(shim, prog, 0)
    // Assert
    expect(out.status).toBe('running')
    expect(io.serial.join('')).toBe('7')
  })

  it('still reports a source error on its own line', async () => {
    const { shim, prog } = setup('function loop() {\n  nope()\n}')
    expect((await tickAt(shim, prog, 0)).out.error?.line).toBe(2)
  })

  it('runs in strict mode', () => {
    const shim = new ArduinoShim({ ...defaultHardwareConfig('esp32', 12) }, API)
    const res = JsProgram.load('undeclaredGlobal = 1', shim)
    expect(res.program).toBeNull()
    expect(res.diagnostics[0].message).toMatch(/ReferenceError/)
  })

  it('warns when neither setup() nor loop() exists', () => {
    const shim = new ArduinoShim({ ...defaultHardwareConfig('esp32', 12) }, API)
    const res = JsProgram.load('const x = 1', shim)
    expect(res.program).not.toBeNull()
    expect(res.diagnostics[0].severity).toBe('warning')
  })
})

describe('JS runner: watch() and the Arduino shim', () => {
  it('publishes watched values', async () => {
    const { shim, prog } = setup("function loop() { watch('speed', 1.5); watch('list', [1, 2]) }")
    await tickAt(shim, prog, 0)
    expect(prog.globals()).toEqual([
      { name: 'speed', value: '1.5' },
      { name: 'list', value: '[1, 2]' },
    ])
  })

  it('drives a Servo object through the hardware profile', async () => {
    const shim = new ArduinoShim({ ...defaultHardwareConfig('esp32', 12) }, [{ name: 'setJoint', kind: 'command', params: ['joint', 'deg'], doc: '' }])
    const res = JsProgram.load('const s = new Servo()\nfunction setup() { s.attach(14); s.write(60) }', shim)
    shim.beginTick(0, {})
    await res.program?.tick(0)
    expect(shim.takeOutput().cmds).toEqual([{ fn: 'setJoint', args: [1, -30] }])
  })

  it('formats numbers like Arduino: integers plain, fractions with 2 digits', async () => {
    const { shim, prog } = setup('function setup() { Serial.print(3); Serial.print(" "); Serial.print(2.5); Serial.print(" "); Serial.print(255, HEX) }')
    expect((await tickAt(shim, prog, 0)).io.serial.join('')).toBe('3 2.50 FF')
  })
})

describe('stack line helpers', () => {
  it('reads V8 and SpiderMonkey Function frames', () => {
    expect(lineFromStack('Error\n    at loop (eval at x (file.js:1:2), <anonymous>:7:11)')).toBe(5)
    expect(lineFromStack('loop@file.js line 3 > Function:9:4')).toBe(7)
    expect(lineFromStack('Error\n    at foo (file.js:1:2)')).toBe(0)
    expect(lineFromStack(undefined)).toBe(0)
  })

  it('builds a diagnostic from anything thrown', () => {
    expect(errorDiagnostic('nope').message).toBe('Uncaught nope')
    expect(errorDiagnostic(new TypeError('bad'), 4)).toMatchObject({ message: 'TypeError: bad', line: 4 })
  })
})
