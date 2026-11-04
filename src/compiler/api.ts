/* ============================================================
   ARDUINO C++ SUBSET COMPILER — public contract between
   src/compiler (implements) and src/sandbox (consumes).
   Pure TypeScript: no DOM, no eval, runs in a Web Worker or Node.

   Pipeline: source → lexer → parser (AST) → semantic checks →
   bytecode → stack VM. `delay()` really pauses the VM in virtual time.
   ============================================================ */

export type ValueType =
  | 'void'
  | 'int'      // width = CompileOptions.intBits
  | 'long'     // 32-bit signed
  | 'unsigned' // unsigned int / unsigned long / uint32_t
  | 'float'
  | 'double'
  | 'bool'
  | 'char'
  | 'string'   // Arduino String and string literals
  | 'any'      // natives only: accept anything (e.g. Serial.print)

export interface NativeFnSig {
  /**
   * Free function ('pinMode', 'setJoint'), method on a native object ('Serial.println'),
   * or method on a native class ('Servo.write' — the VM passes the instance handle as `self`).
   */
  name: string
  params: ValueType[]
  /** Number of trailing params that may be omitted (e.g. Serial.print(x [, format])). */
  optional?: number
  returns: ValueType
  doc?: string
}

export interface NativeClassSig {
  /** e.g. 'Servo', 'Adafruit_PWMServoDriver'. Declared as `Servo s;` or `Servo s = Servo(...)`. */
  name: string
  ctorParams: ValueType[]
  ctorOptional?: number
  /** Method sigs with the bare method name ('attach', 'write'). */
  methods: NativeFnSig[]
}

export interface NativeObjectSig {
  /** Global object name, e.g. 'Serial', 'Wire'. Methods are listed in `functions` as 'Serial.println'. */
  name: string
}

export interface CompileOptions {
  functions: NativeFnSig[]
  classes: NativeClassSig[]
  objects: NativeObjectSig[]
  /** HIGH, LOW, INPUT, OUTPUT, LED_BUILTIN, A0.., HEX, DEC, BIN, PA8.. etc. */
  constants: Record<string, number>
  /** Width of `int`: 16 on AVR, 32 on ESP32 / RP2040 / STM32. Default 32. */
  intBits?: 16 | 32
  /** Headers accepted silently by #include ('Arduino.h', 'Servo.h', 'Wire.h', ...). Others warn. */
  knownIncludes: string[]
}

export interface Diagnostic {
  severity: 'error' | 'warning'
  message: string
  /** 1-based. */
  line: number
  /** 1-based. */
  col: number
  endLine?: number
  endCol?: number
}

/** Opaque compiled program. Structured-clonable so it can be posted to a worker. */
export interface Program {
  readonly kind: 'kiyo-bytecode'
  readonly version: number
  /** True when the source defines setup() / loop(). */
  readonly hasSetup: boolean
  readonly hasLoop: boolean
}

export interface CompileResult {
  ok: boolean
  diagnostics: Diagnostic[]
  program: Program | null
}

/** Runtime values. Structs are plain objects, arrays are JS arrays. */
export type VMValue = number | boolean | string | VMValue[] | { [field: string]: VMValue }

export interface VMHost {
  /**
   * Every native call lands here. `self` is the instance handle for native-class methods
   * (null otherwise). `argTypes` are the static types of the arguments, so the host can
   * format Serial.print(3) as "3" but Serial.print(3.0) as "3.00".
   * Throwing an Error turns into a runtime diagnostic at the call site.
   */
  callNative(name: string, args: VMValue[], argTypes: ValueType[], self: number | null): VMValue | void
  /** Native-class construction. Return a numeric instance handle. */
  constructNative(className: string, args: VMValue[]): number
}

export type VMStatus = 'ready' | 'running' | 'sleeping' | 'halted' | 'error'

export interface VMRunResult {
  status: VMStatus
  /** Instructions executed during this run() call. */
  executed: number
  /** loop() returned at least once during this run() call. */
  loopCompleted: boolean
  /** When status = 'sleeping': virtual time (ms) at which delay() ends. */
  wakeAtMs?: number
  /** 1-based source line currently executing (for highlighting / stepping). */
  line: number
  /** When status = 'error'. */
  error?: Diagnostic
}

export interface VMOptions {
  /** Stop a run() after this many loop() completions (default 1). */
  maxLoopsPerRun?: number
  /** Max call depth before a stack-overflow runtime error (default 256). */
  maxCallDepth?: number
}

export interface VM {
  /**
   * Execute until `budget` instructions are spent, a delay() puts the VM to sleep,
   * maxLoopsPerRun loop() iterations complete, or the program halts / errors.
   * `nowMs` is the virtual clock: millis() / micros() read it. A sleeping VM wakes
   * once nowMs >= wakeAtMs. Runs setup() first, then loop() forever.
   */
  run(budget: number, nowMs: number): VMRunResult
  readonly status: VMStatus
  readonly currentLine: number
  /** Back to 'ready' with fresh globals (setup() runs again). */
  reset(): void
  /** Snapshot of global variables for the watch panel. */
  getGlobals(): Record<string, VMValue>
}

/*
 * Builtins the VM implements itself (NOT routed to the host), always available:
 *   delay, delayMicroseconds, millis, micros, yield
 *   abs, min, max, constrain, map, sq, sqrt, pow, sin, cos, tan, asin, acos, atan, atan2,
 *   exp, log, log10, floor, ceil, round, fabs, fmod, radians, degrees, random, randomSeed,
 *   bitRead, bitWrite, bitSet, bitClear, bit, highByte, lowByte, isnan, isinf
 *   String: length, charAt, substring, indexOf, toInt, toFloat, toUpperCase, toLowerCase,
 *           trim, equals, startsWith, endsWith, concat, + operator, String(x[, base|digits])
 *   constants: PI, HALF_PI, TWO_PI, DEG_TO_RAD, RAD_TO_DEG, true, false
 * Everything else (pinMode, digitalWrite, Serial.*, Servo.*, the robot API ...) is a
 * native supplied through CompileOptions and served by VMHost.
 *
 * The implementation lives in src/compiler/index.ts and must export:
 *   export function compile(source: string, opts: CompileOptions): CompileResult
 *   export function createVM(program: Program, host: VMHost, opts?: VMOptions): VM
 */
