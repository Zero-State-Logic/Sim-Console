import { describe, expect, it } from 'vitest'
import { nextRandom } from '../arith'
import { createVM, type Program, type VMRunResult } from '../index'
import { compileOk, RecordingHost } from './harness'

function vmFor(src: string, maxLoopsPerRun = 1, maxCallDepth?: number) {
  const r = compileOk(src)
  const host = new RecordingHost()
  const vm = createVM(r.program!, host, { maxLoopsPerRun, maxCallDepth })
  return { vm, host, program: r.program! }
}

describe('virtual time: delay, millis, micros', () => {
  it('sleeps in delay() and resumes once the clock reaches wakeAtMs', () => {
    // Arrange
    const { vm, host } = vmFor('void setup() {\n  Serial.println(millis());\n  delay(100);\n  Serial.println(millis());\n}\nvoid loop() {}')
    // Act
    const a = vm.run(10000, 0)
    const b = vm.run(10000, 50)
    const c = vm.run(10000, 120)
    // Assert
    expect(a.status).toBe('sleeping')
    expect(a.wakeAtMs).toBe(100)
    expect(a.line).toBe(3)
    expect(b).toMatchObject({ status: 'sleeping', executed: 0 })
    expect(c.status).toBe('running')
    // delay() returns at exactly 100 ms of virtual time, not at the frame time
    expect(host.serial).toBe('0\n100\n')
  })

  it('counts millis() from the first run, whatever the host clock origin', () => {
    const { vm, host } = vmFor('void setup() { delay(250); Serial.println(millis()); Serial.println(micros()); }\nvoid loop() {}')
    vm.run(1000, 5000)
    vm.run(1000, 5300)
    expect(host.serial).toBe('250\n250000\n')
  })

  it('catches up delay-paced loops within one run() (exact timing at a coarse frame rate)', () => {
    const { vm, host } = vmFor('int n = 0;\nvoid setup() {}\nvoid loop() { n++; if (n % 50 == 1) Serial.println(millis()); delay(10); }', 100000)
    vm.run(1_000_000, 0)
    const r = vm.run(1_000_000, 1000)
    expect(r.status).toBe('sleeping')
    expect(r.wakeAtMs).toBe(1010)
    expect(vm.getGlobals().n).toBe(101)
    expect(host.serial).toBe('0\n500\n1000\n')
  })

  it('treats delay(0), negative and microsecond delays sensibly', () => {
    const { vm, host } = vmFor('void setup() { delay(0); delayMicroseconds(1500); Serial.println(micros()); }\nvoid loop() {}')
    expect(vm.run(1000, 0).status).toBe('sleeping')
    expect(vm.run(1000, 1).status).toBe('sleeping')
    vm.run(1000, 2)
    expect(host.serial).toBe('1500\n')
  })

  it('lets a millis() busy-wait finish as the host clock advances', () => {
    const { vm, host } = vmFor('void setup() { unsigned long t0 = millis(); while (millis() - t0 < 30) { } Serial.print(millis()); }\nvoid loop() {}')
    let r: VMRunResult = vm.run(500, 0)
    expect(r.status).toBe('running')
    for (let t = 16; t <= 48 && host.serial === ''; t += 16) r = vm.run(1_000_000, t)
    expect(host.serial).toBe('32')
  })

  it('returns from run() at yield()', () => {
    const { vm } = vmFor('int spins = 0;\nvoid setup() { while (true) { spins++; yield(); } }\nvoid loop() {}')
    vm.run(1_000_000, 0)
    vm.run(1_000_000, 1)
    expect(vm.getGlobals().spins).toBe(2)
  })
})

describe('scheduling: budget, loops, halting', () => {
  it('returns running when the budget runs out, then continues', () => {
    const { vm } = vmFor('long i = 0;\nvoid setup() { while (true) i++; }\nvoid loop() {}')
    const r = vm.run(1000, 0)
    expect(r.status).toBe('running')
    expect(r.executed).toBe(1000)
    const before = vm.getGlobals().i as number
    vm.run(1000, 1)
    expect(vm.getGlobals().i).toBeGreaterThan(before)
  })

  it('stops after maxLoopsPerRun loop() iterations and reports loopCompleted', () => {
    const { vm } = vmFor('int n = 0;\nvoid setup() {}\nvoid loop() { n++; }', 5)
    const r = vm.run(1_000_000, 0)
    expect(r.loopCompleted).toBe(true)
    expect(vm.getGlobals().n).toBe(5)
    vm.run(1_000_000, 1)
    expect(vm.getGlobals().n).toBe(10)
  })

  it('runs setup() once and halts without loop()', () => {
    const { vm, host, program } = vmFor('void setup() { Serial.print("once"); }')
    expect(program.hasSetup).toBe(true)
    expect(program.hasLoop).toBe(false)
    expect(vm.run(1000, 0).status).toBe('halted')
    expect(vm.run(1000, 1)).toMatchObject({ status: 'halted', executed: 0 })
    expect(host.serial).toBe('once')
  })

  it('treats a zero budget as a no-op', () => {
    const { vm } = vmFor('void setup() {}\nvoid loop() {}')
    expect(vm.run(0, 0).executed).toBe(0)
  })
})

describe('runtime errors', () => {
  it('stops at an out-of-bounds index with the line, column and array name', () => {
    const { vm } = vmFor('int a[5];\nvoid setup() {\n  for (int i = 0; i <= 5; i++)\n    a[i] = i;\n}\nvoid loop() {}')
    const r = vm.run(10000, 0)
    expect(r.status).toBe('error')
    expect(r.error).toMatchObject({ severity: 'error', line: 4, col: 7, message: "Index 5 is out of bounds for 'a' (size 5, valid 0..4)" })
    expect(vm.run(10000, 1)).toMatchObject({ status: 'error', executed: 0 })
  })

  it('checks every dimension of a 2D array', () => {
    const { vm } = vmFor('int m[2][3];\nvoid setup() { int j = 3;\n  m[1][j] = 1; }\nvoid loop() {}')
    expect(vm.run(1000, 0).error?.message).toMatch(/Index 3 is out of bounds for 'm\[\]' \(size 3/)
  })

  it('reports integer division and remainder by zero at the operator', () => {
    const { vm } = vmFor('void setup() { int z = 0;\n  int q = 10 / z; }\nvoid loop() {}')
    expect(vm.run(1000, 0).error).toMatchObject({ line: 2, message: 'Integer division by zero' })
    const { vm: vm2 } = vmFor('void setup() { long z = 0;\n  long q = 10 % z; }\nvoid loop() {}')
    expect(vm2.run(1000, 0).error?.message).toBe('Integer remainder (%) by zero')
  })

  it('does not fault on float division by zero (IEEE inf)', () => {
    const { vm, host } = vmFor('void setup() { float z = 0; Serial.print(1 / z); }\nvoid loop() {}')
    expect(vm.run(1000, 0).status).toBe('running')
    expect(host.callsTo('Serial.print')[0].args[0]).toBe(Infinity)
  })

  it('reports a stack overflow for runaway recursion', () => {
    const { vm } = vmFor('int down(int n) {\n  return down(n + 1) + 1;\n}\nvoid setup() { down(0); }\nvoid loop() {}', 1, 64)
    const r = vm.run(1_000_000, 0)
    expect(r.status).toBe('error')
    expect(r.error?.message).toMatch(/Stack overflow: more than 64 nested calls .*'down'/)
    expect(r.error?.line).toBe(2)
  })
})

describe('state: reset, globals, current line, cloning', () => {
  it('reset() restores fresh globals and runs setup() again', () => {
    const { vm, host } = vmFor('int count = 5;\nServo s;\nvoid setup() { count++; }\nvoid loop() {}')
    vm.run(1000, 0)
    expect(vm.getGlobals().count).toBe(6)
    vm.reset()
    expect(vm.status).toBe('ready')
    vm.run(1000, 10)
    expect(vm.getGlobals().count).toBe(6)
    expect(host.constructed).toHaveLength(2)
  })

  it('exports globals for the watch panel', () => {
    const src = `struct P { int x; float y; };
int i = -3; float f = 1.5; bool on = true; char c = 'k'; String s = "hi"; char label[8] = "abc";
int grid[2][2] = {{1, 2}, {3, 4}}; P p = {7, 2.5}; Servo sv;
void setup() {}
void loop() { static int calls = 0; calls++; }`
    const { vm, host } = vmFor(src)
    vm.run(10000, 0)
    vm.run(10000, 1)
    expect(vm.getGlobals()).toEqual({
      i: -3, f: 1.5, on: true, c: 'k', s: 'hi', label: 'abc', grid: [[1, 2], [3, 4]], p: { x: 7, y: 2.5 },
      sv: host.constructed[0].handle, 'loop::calls': 2,
    })
  })

  it('reports the line being executed', () => {
    const { vm } = vmFor('void setup() {}\nvoid loop() {\n  int a = 1;\n  delay(5);\n}')
    vm.run(1000, 0)
    expect(vm.currentLine).toBe(4)
  })

  it('compiles to a structured-clonable program that runs the same after cloning', () => {
    const { program } = vmFor('int t[3] = {1, 2, 3};\nvoid setup() { Serial.print(t[0] + t[1] + t[2]); }\nvoid loop() {}')
    const copy = structuredClone(program)
    const host = new RecordingHost()
    createVM(copy, host).run(1000, 0)
    expect(host.serial).toBe('6')
  })

  it('rejects something that is not a compiled program', () => {
    // a forged object that only looks like a Program (the sandbox could receive anything via postMessage)
    const fake = { kind: 'nope', version: 1, hasSetup: false, hasLoop: false } as unknown as Program
    expect(() => createVM(fake, new RecordingHost())).toThrow(/Not a compiled program/)
    const { program } = vmFor('void setup() {}')
    const stale = { ...program, version: 99 } as Program
    expect(() => createVM(stale, new RecordingHost())).toThrow(/Recompile it/)
  })

  it('produces avr-libc random() numbers (7, 49, 73 for random(100) on a fresh board)', () => {
    const { vm, host } = vmFor('void setup() { for (int i = 0; i < 3; i++) { Serial.print(random(100)); Serial.print(" "); } randomSeed(42); Serial.print(random(10, 20)); }\nvoid loop() {}')
    vm.run(10000, 0)
    const expected = (nextRandom(42) % 10) + 10
    expect(host.serial).toBe(`7 49 73 ${expected}`)
  })
})
