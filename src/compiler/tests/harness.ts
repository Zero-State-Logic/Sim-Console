/* ============================================================
   TEST HARNESS — Arduino-like compile options, a recording host
   that formats Serial.print like Arduino's Print class, and
   helpers to compile + run a sketch in virtual time.
   ============================================================ */

import { expect } from 'vitest'
import { compile, createVM, type CompileOptions, type CompileResult, type ValueType, type VM, type VMHost, type VMOptions, type VMValue } from '../index'

export const OPTS: CompileOptions = {
  functions: [
    { name: 'pinMode', params: ['int', 'int'], returns: 'void' },
    { name: 'digitalWrite', params: ['int', 'int'], returns: 'void' },
    { name: 'digitalRead', params: ['int'], returns: 'int' },
    { name: 'analogRead', params: ['int'], returns: 'int' },
    { name: 'analogWrite', params: ['int', 'int'], returns: 'void' },
    { name: 'Serial.begin', params: ['unsigned'], returns: 'void' },
    { name: 'Serial.print', params: ['any', 'int'], optional: 1, returns: 'unsigned' },
    { name: 'Serial.println', params: ['any', 'int'], optional: 2, returns: 'unsigned' },
    { name: 'Serial.available', params: [], returns: 'int' },
    { name: 'setJoint', params: ['int', 'float'], returns: 'void' },
    { name: 'readLoad', params: ['int'], returns: 'float' },
    { name: 'setName', params: ['string'], returns: 'void' },
    { name: 'isReady', params: [], returns: 'bool' },
  ],
  classes: [
    {
      name: 'Servo',
      ctorParams: [],
      methods: [
        { name: 'attach', params: ['int', 'int', 'int'], optional: 2, returns: 'unsigned' },
        { name: 'write', params: ['int'], returns: 'void' },
        { name: 'writeMicroseconds', params: ['int'], returns: 'void' },
        { name: 'read', params: [], returns: 'int' },
        { name: 'detach', params: [], returns: 'void' },
        { name: 'attached', params: [], returns: 'bool' },
      ],
    },
    {
      name: 'Adafruit_PWMServoDriver',
      ctorParams: ['int'],
      ctorOptional: 1,
      methods: [
        { name: 'begin', params: [], returns: 'void' },
        { name: 'setPWMFreq', params: ['float'], returns: 'void' },
        { name: 'setPWM', params: ['int', 'int', 'int'], returns: 'void' },
      ],
    },
  ],
  objects: [{ name: 'Serial' }],
  constants: { HIGH: 1, LOW: 0, OUTPUT: 1, INPUT: 0, LED_BUILTIN: 13, A0: 14, HEX: 16, DEC: 10, OCT: 8, BIN: 2 },
  intBits: 32,
  knownIncludes: ['Arduino.h', 'Servo.h', 'Wire.h', 'Adafruit_PWMServoDriver.h'],
}

export const AVR: CompileOptions = { ...OPTS, intBits: 16 }

export interface NativeCall {
  name: string
  args: VMValue[]
  argTypes: ValueType[]
  self: number | null
}

/** Arduino Print number formatting (HEX upper-case, floats with 2 decimals). */
function printValue(v: VMValue, t: ValueType, fmt: VMValue | undefined): string {
  if (t === 'string') return String(v)
  if (t === 'char') return String.fromCharCode(Number(v) & 0xff)
  if (t === 'bool') return v ? '1' : '0'
  if (t === 'float' || t === 'double') return Number(v).toFixed(typeof fmt === 'number' ? fmt : 2)
  if (typeof fmt === 'number' && fmt !== 10) {
    const n = Number(v)
    return (n < 0 ? n + 2 ** 32 : n).toString(fmt).toUpperCase()
  }
  return String(v)
}

export class RecordingHost implements VMHost {
  readonly calls: NativeCall[] = []
  serial = ''
  private nextHandle = 100
  readonly constructed: { cls: string; args: VMValue[]; handle: number }[] = []
  /** Canned answers for query natives. */
  answers: Record<string, (args: VMValue[]) => VMValue> = {}

  callNative(name: string, args: VMValue[], argTypes: ValueType[], self: number | null): VMValue | void {
    this.calls.push({ name, args, argTypes, self })
    if (name === 'Serial.print' || name === 'Serial.println') {
      const text = args.length > 0 ? printValue(args[0], argTypes[0], args[1]) : ''
      this.serial += text + (name === 'Serial.println' ? '\n' : '')
      return text.length
    }
    const answer = this.answers[name]
    return answer ? answer(args) : undefined
  }

  constructNative(className: string, args: VMValue[]): number {
    const handle = this.nextHandle++
    this.constructed.push({ cls: className, args, handle })
    return handle
  }

  callsTo(name: string): NativeCall[] {
    return this.calls.filter((c) => c.name === name)
  }
}

export function compileOk(src: string, opts: CompileOptions = OPTS): CompileResult {
  const r = compile(src, opts)
  const errors = r.diagnostics.filter((d) => d.severity === 'error')
  expect(errors.map((d) => `${d.line}:${d.col} ${d.message}`)).toEqual([])
  expect(r.ok).toBe(true)
  return r
}

export function errorsOf(src: string, opts: CompileOptions = OPTS): string[] {
  return compile(src, opts).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)
}

export function warningsOf(src: string, opts: CompileOptions = OPTS): string[] {
  return compile(src, opts).diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message)
}

export interface Ran {
  vm: VM
  host: RecordingHost
  out: string
}

/** Compiles and runs setup() (plus `loops` loop() iterations) with a generous budget. */
export function runSketch(src: string, loops = 0, opts: CompileOptions = OPTS, vmOpts: VMOptions = {}): Ran {
  const r = compileOk(src, opts)
  const host = new RecordingHost()
  const vm = createVM(r.program!, host, { maxLoopsPerRun: 1, ...vmOpts })
  let t = 0
  let done = 0
  for (let guard = 0; guard < 100000 && vm.status !== 'halted' && vm.status !== 'error'; guard++) {
    const res = vm.run(1_000_000, t)
    if (res.loopCompleted) done++
    if (done >= loops && res.status !== 'sleeping' && (res.loopCompleted || loops === 0)) break
    t = res.status === 'sleeping' && res.wakeAtMs !== undefined ? res.wakeAtMs : t + 1
  }
  return { vm, host, out: host.serial }
}

/** Runs `body` inside setup() and returns what it printed. */
export function printed(body: string, opts: CompileOptions = OPTS, globals = ''): string {
  const src = `${globals}\nvoid setup() {\n${body}\n}\nvoid loop() {}\n`
  return runSketch(src, 0, opts).out
}
