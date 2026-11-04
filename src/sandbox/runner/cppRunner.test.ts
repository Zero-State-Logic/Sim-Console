import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig } from '../../core/hardware'
import type { SandboxFnDef } from '../../core/types'
import { TICK_BUDGET } from '../protocol'
import { ArduinoShim } from '../shim/arduino'
import { CppProgram, MAX_CLOCK_LAG_MS, sandboxDiagnostics } from './cppRunner'
import { fakeCompiler } from './fakeCompiler'

const API: SandboxFnDef[] = [{ name: 'walk', kind: 'command', params: ['vx', 'vy', 'wz'], doc: '' }]

function shim(): ArduinoShim {
  return new ArduinoShim({ ...defaultHardwareConfig('esp32', 12) }, API)
}

describe('CppProgram.load', () => {
  it('compiles with the shim + robot API and creates the VM with one loop per run', () => {
    // Arrange
    const fc = fakeCompiler()
    // Act
    const res = CppProgram.load('void loop() {}', shim(), 32, fc)
    // Assert
    expect(res.program).not.toBeNull()
    expect(fc.lastOptions?.functions.some((f) => f.name === 'walk')).toBe(true)
    expect(fc.lastOptions?.intBits).toBe(32)
    expect(fc.lastVMOptions?.maxLoopsPerRun).toBe(1)
  })

  it('returns the compiler diagnostics and no program on failure', () => {
    const fc = fakeCompiler({ ok: false, program: null, diagnostics: [{ severity: 'error', message: "expected ';'", line: 3, col: 9 }] })
    const res = CppProgram.load('int x', shim(), 32, fc)
    expect(res.program).toBeNull()
    expect(res.diagnostics).toEqual([{ severity: 'error', message: "expected ';'", line: 3, col: 9 }])
  })

  it('warns about WiFi.h and a missing loop()', () => {
    const fc = fakeCompiler({ program: { kind: 'kiyo-bytecode', version: 1, hasSetup: true, hasLoop: false } })
    const res = CppProgram.load('#include <WiFi.h>\nvoid setup() {}', shim(), 32, fc)
    expect(res.diagnostics.map((d) => d.severity)).toEqual(['warning', 'warning'])
    expect(res.diagnostics[0]).toMatchObject({ line: 1, col: 1 })
    expect(res.diagnostics[1].message).toMatch(/loop\(\)/)
  })

  it('turns a compiler crash into an internal-error diagnostic', () => {
    const fc = fakeCompiler()
    fc.compile = () => {
      throw new Error('stack overflow')
    }
    const res = CppProgram.load('x', shim(), 32, fc)
    expect(res.program).toBeNull()
    expect(res.diagnostics[0].message).toMatch(/Internal compiler error: stack overflow/)
  })
})

describe('CppProgram.tick', () => {
  it('runs the VM with the instruction budget at the virtual clock', () => {
    const fc = fakeCompiler()
    const prog = CppProgram.load('', shim(), 32, fc).program
    const out = prog?.tick(1234.5)
    expect(fc.runs).toEqual([{ budget: TICK_BUDGET, nowMs: 1234.5 }])
    expect(out).toEqual({ status: 'running', line: 5, executed: 100, loops: 1 })
  })

  it('maps sleeping, halted and error results', () => {
    const fc = fakeCompiler()
    fc.script = [
      { status: 'sleeping', wakeAtMs: 500, line: 9, executed: 12 },
      { status: 'halted', line: 0 },
      { status: 'error', line: 4, error: { severity: 'error', message: 'division by zero', line: 4, col: 7 } },
    ]
    const prog = CppProgram.load('', shim(), 32, fc).program
    expect(prog?.tick(0)).toMatchObject({ status: 'sleeping', wakeAtMs: 500, line: 9, loops: 0 })
    expect(prog?.tick(16)).toMatchObject({ status: 'halted' })
    expect(prog?.tick(32)).toMatchObject({ status: 'error', error: { message: 'division by zero', line: 4 } })
  })

  it('chains the next loop() after an iteration resumed from delay(), at the wake time', () => {
    // Arrange: loop 1 completes, loop 2 sleeps until 50, wakes and completes at 60, loop 3 sleeps
    const fc = fakeCompiler()
    fc.script = [
      { status: 'running', loopCompleted: true, executed: 10 },
      { status: 'sleeping', wakeAtMs: 50, executed: 5 },
      { status: 'running', loopCompleted: true, executed: 4 },
      { status: 'sleeping', wakeAtMs: 70, executed: 5 },
    ]
    const prog = CppProgram.load('', shim(), 32, fc).program
    // Act
    prog?.tick(0)
    prog?.tick(16)
    const resumed = prog?.tick(60)
    // Assert: tick 60 ran the woken remainder, then loop 3 from the wake time (50)
    expect(fc.runs.map((r) => r.nowMs)).toEqual([0, 16, 60, 50])
    expect(fc.runs[3].budget).toBe(TICK_BUDGET - 4)
    expect(resumed).toMatchObject({ status: 'sleeping', wakeAtMs: 70, loops: 1, executed: 9 })
  })

  it('starts loop() only once in a tick that began at a loop boundary', () => {
    const fc = fakeCompiler()
    fc.script = [{ status: 'running', loopCompleted: true, executed: 10 }]
    const prog = CppProgram.load('', shim(), 32, fc).program
    prog?.tick(0)
    prog?.tick(16)
    expect(fc.runs).toHaveLength(2)
  })

  it('bounds how far the chained loop() may trail sim time', () => {
    const fc = fakeCompiler()
    fc.script = [
      { status: 'running', loopCompleted: true },
      { status: 'sleeping', wakeAtMs: 100 },
      { status: 'running', loopCompleted: true },
      { status: 'sleeping', wakeAtMs: 2000 },
    ]
    const prog = CppProgram.load('', shim(), 32, fc).program
    prog?.tick(0)
    prog?.tick(16)
    // the program was paused for a long time: restart MAX_CLOCK_LAG_MS before now, not at 100
    prog?.tick(1000)
    expect(fc.runs[3].nowMs).toBe(1000 - MAX_CLOCK_LAG_MS)
  })

  it('does not chain right after setup() slept (loop() has not returned yet)', () => {
    const fc = fakeCompiler()
    fc.script = [
      { status: 'sleeping', wakeAtMs: 30 },
      { status: 'running', loopCompleted: true },
    ]
    const prog = CppProgram.load('', shim(), 32, fc).program
    prog?.tick(0)
    prog?.tick(32)
    expect(fc.runs).toHaveLength(2)
  })

  it('reports a VM exception as an error outcome', () => {
    const fc = fakeCompiler()
    const prog = CppProgram.load('', shim(), 32, fc).program
    fc.script = []
    const vm = (prog as unknown as { vm: { run: () => never } }).vm
    vm.run = () => {
      throw new Error('bad opcode')
    }
    expect(prog?.tick(0)).toMatchObject({ status: 'error', error: { message: 'Internal VM error: bad opcode' } })
  })

  it('formats globals sorted by name and resets the VM', () => {
    const fc = fakeCompiler()
    const prog = CppProgram.load('', shim(), 32, fc).program
    expect(prog?.globals()).toEqual([
      { name: 'arr', value: '[1, 2, 3]' },
      { name: 'speed', value: '1.25' },
    ])
    prog?.reset()
    expect(fc.resets).toBe(1)
  })
})

describe('sandboxDiagnostics', () => {
  it('only flags headers that are accepted but not simulated', () => {
    expect(sandboxDiagnostics('#include <Servo.h>\n#include <Wire.h>')).toEqual([])
    expect(sandboxDiagnostics('#include <WiFi.h>')).toHaveLength(1)
  })
})
