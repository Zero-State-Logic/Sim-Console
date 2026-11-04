import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig } from '../core/hardware'
import { commandNameSet, MAX_CMDS_PER_TICK, MAX_SERIAL_PER_TICK, parseMainMsg, parseWorkerMsg, sanitizeCommands } from './protocol'

const hw = (() => {
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
})()

const api = [
  { name: 'walk', kind: 'command', params: ['vx', 'vy', 'wz'], doc: 'walk' },
  { name: 'readImu', kind: 'query', params: ['axis'], sensor: 'imu', doc: 'imu' },
]

const NAMES = new Set(['walk', 'setJoint'])

describe('parseMainMsg (worker side)', () => {
  it('accepts a well-formed load', () => {
    const msg = parseMainMsg({ t: 'load', id: 1, dialect: 'cpp', source: 'void loop(){}', api, hw, intBits: 32 })
    expect(msg).toMatchObject({ t: 'load', id: 1, dialect: 'cpp', intBits: 32 })
  })

  it('rejects loads with a bad dialect, api name, board or pulse range', () => {
    const base = { t: 'load', id: 1, dialect: 'cpp', source: '', api, hw, intBits: 32 }
    expect(parseMainMsg({ ...base, dialect: 'python' })).toBeNull()
    expect(parseMainMsg({ ...base, api: [{ ...api[0], name: 'bad name' }] })).toBeNull()
    expect(parseMainMsg({ ...base, hw: { ...hw, board: 'uno' } })).toBeNull()
    expect(parseMainMsg({ ...base, hw: { ...hw, servoMaxUs: 100 } })).toBeNull()
    expect(parseMainMsg({ ...base, intBits: 8 })).toBeNull()
    expect(parseMainMsg({ ...base, source: 'x'.repeat(300_000) })).toBeNull()
  })

  it('accepts a tick, zeroing non-finite sensor values', () => {
    const msg = parseMainMsg({ t: 'tick', seq: 3, nowMs: 16.7, sensors: { imu: [1, Number.NaN, 3], legs: 6 }, input: 'hi\n', wantGlobals: true })
    expect(msg).toEqual({ t: 'tick', seq: 3, nowMs: 16.7, sensors: { imu: [1, 0, 3], legs: 6 }, input: 'hi\n', wantGlobals: true })
  })

  it('rejects ticks with a bad clock or no sensor object', () => {
    expect(parseMainMsg({ t: 'tick', seq: 1.5, nowMs: 0, sensors: {} })).toBeNull()
    expect(parseMainMsg({ t: 'tick', seq: 1, nowMs: -1, sensors: {} })).toBeNull()
    expect(parseMainMsg({ t: 'tick', seq: 1, nowMs: 0, sensors: [1, 2] })).toBeNull()
  })

  it('keeps a tick with odd sensors (a dropped tick would look like a hung loop to the watchdog)', () => {
    // Arrange: a string, a typed array, an oversized array and too many keys
    const sensors: Record<string, unknown> = { a: 'x', f: new Float64Array([1.5, 2]), big: new Array(5000).fill(1) }
    for (let i = 0; i < 80; i++) sensors[`k${i}`] = i
    // Act
    const msg = parseMainMsg({ t: 'tick', seq: 1, nowMs: 0, sensors })
    // Assert
    const s = msg?.t === 'tick' ? msg.sensors : {}
    expect(s.a).toBeUndefined()
    expect(s.f).toEqual([1.5, 2])
    expect((s.big as number[]).length).toBe(4096)
    expect(Object.keys(s)).toHaveLength(64)
  })

  it('accepts reset / stop and rejects everything else', () => {
    expect(parseMainMsg({ t: 'reset' })).toEqual({ t: 'reset' })
    expect(parseMainMsg({ t: 'stop' })).toEqual({ t: 'stop' })
    expect(parseMainMsg({ t: 'eval' })).toBeNull()
    expect(parseMainMsg(null)).toBeNull()
    expect(parseMainMsg([1])).toBeNull()
  })
})

describe('parseWorkerMsg (main side)', () => {
  it('accepts an out message and clamps its fields', () => {
    const msg = parseWorkerMsg({ t: 'out', seq: 2, cmds: [{ fn: 'walk', args: [1, 0, 0] }], serial: ['a'], log: [{ level: 'warn', text: 'w' }], status: 'sleeping', line: 4, led: 3, executed: 12.4, loops: 1, wakeAtMs: 200 }, NAMES)
    expect(msg).toEqual({ t: 'out', seq: 2, cmds: [{ fn: 'walk', args: [1, 0, 0] }], serial: ['a'], log: [{ level: 'warn', text: 'w' }], status: 'sleeping', line: 4, led: 1, executed: 12, loops: 1, wakeAtMs: 200 })
  })

  it('rejects out messages with an unknown status or bad seq', () => {
    expect(parseWorkerMsg({ t: 'out', seq: 1, status: 'pwned' }, NAMES)).toBeNull()
    expect(parseWorkerMsg({ t: 'out', seq: 'x', status: 'running' }, NAMES)).toBeNull()
    expect(parseWorkerMsg({ t: 'nope' }, NAMES)).toBeNull()
  })

  it('keeps only declared commands with finite numeric args', () => {
    const cmds = sanitizeCommands(
      [
        { fn: 'walk', args: [1, 2, 3] },
        { fn: 'eval', args: [1] },
        { fn: 'walk', args: [Number.NaN] },
        { fn: 'setJoint', args: ['1', 2] },
        { fn: 'setJoint', args: new Array(20).fill(0) },
        'junk',
      ],
      NAMES,
    )
    expect(cmds).toEqual([{ fn: 'walk', args: [1, 2, 3] }])
  })

  it('caps the commands and serial characters of one reply', () => {
    const many = Array.from({ length: MAX_CMDS_PER_TICK + 10 }, () => ({ fn: 'walk', args: [0, 0, 0] }))
    const msg = parseWorkerMsg({ t: 'out', seq: 1, status: 'running', cmds: many, serial: ['x'.repeat(MAX_SERIAL_PER_TICK), 'more'] }, NAMES)
    expect(msg?.t === 'out' && msg.cmds.length).toBe(MAX_CMDS_PER_TICK)
    expect(msg?.t === 'out' && msg.serial.join('').length).toBe(MAX_SERIAL_PER_TICK)
  })

  it('accepts a loaded message and filters its diagnostics', () => {
    const msg = parseWorkerMsg({ t: 'loaded', id: 4, ok: false, compileMs: 2.5, diagnostics: [{ severity: 'error', message: 'x', line: 0, col: 2 }, { severity: 'fatal' }] }, NAMES)
    expect(msg).toEqual({ t: 'loaded', id: 4, ok: false, compileMs: 2.5, diagnostics: [{ severity: 'error', message: 'x', line: 1, col: 2 }], log: [] })
  })

  it('validates globals and errors', () => {
    const msg = parseWorkerMsg({ t: 'out', seq: 1, status: 'error', globals: [{ name: 'n', value: '3' }, { name: 5 }], error: { severity: 'error', message: 'boom', line: 3, col: 1 } }, NAMES)
    expect(msg?.t === 'out' && msg.globals).toEqual([{ name: 'n', value: '3' }])
    expect(msg?.t === 'out' && msg.error?.message).toBe('boom')
  })
})

describe('commandNameSet', () => {
  it('lists command functions only', () => {
    expect([...commandNameSet([{ name: 'a', kind: 'command', params: [], doc: '' }, { name: 'b', kind: 'query', params: [], doc: '' }])]).toEqual(['a'])
  })
})
