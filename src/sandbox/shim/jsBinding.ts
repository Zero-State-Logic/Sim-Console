import type { VMValue } from '../../compiler/api'
import type { ArduinoShim } from './arduino'
import { WIFI_CONSTANTS, boardConstants } from './boards'
import { formatPrint, formatPrintf } from './format'
import { reservedNames } from './reference'

/* ============================================================
   JS BINDING — the Arduino shim as plain JS names, handed to the
   user program as `new Function` parameters.

   SECURITY NOTE: the isolation boundary is the dedicated Web
   Worker (no DOM, no app state, killable by the watchdog), NOT the
   shadowing below. Shadowing the network / messaging globals only
   removes the obvious footguns; a determined program can still
   reach the worker global (e.g. through a constructor chain).
   That is acceptable: the worker holds nothing worth stealing, and
   everything it posts back is validated on the main thread.
   ============================================================ */

/** Worker globals hidden from user code (bound as undefined parameters). */
export const SHADOWED_GLOBALS: readonly string[] = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'importScripts',
  'postMessage',
  'self',
  'globalThis',
  'indexedDB',
  'caches',
  'navigator',
  'close',
  'Worker',
  'SharedWorker',
  'EventSource',
  'BroadcastChannel',
  'location',
  'onmessage',
  'onmessageerror',
  'onerror',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'requestAnimationFrame',
]

/** Words that cannot be parameter names in strict-mode code. */
const STRICT_RESERVED = new Set([
  'eval', 'arguments', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'await',
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
  'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
])

export interface JsHooks {
  delay(ms: number): Promise<void>
  watch(name: string, value: unknown): void
}

/** A JS value as a VM value for the shared print formatter. */
export function jsToVM(v: unknown): VMValue {
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.map(jsToVM)
  if (v === null || v === undefined) return String(v)
  if (typeof v === 'object') {
    const o: { [k: string]: VMValue } = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = jsToVM(x)
    return o
  }
  return String(v)
}

function n(v: unknown): number {
  return typeof v === 'number' ? v : Number(v) || 0
}

function optN(v: unknown): number | undefined {
  return v === undefined ? undefined : n(v)
}

function serialObject(shim: ArduinoShim): Record<string, (...a: unknown[]) => unknown> {
  const s = shim.serial
  const print = (v: unknown, fmt?: unknown): number => (v === undefined ? 0 : s.write(formatPrint(jsToVM(v), 'any', optN(fmt))))
  return Object.freeze({
    begin: (baud: unknown) => {
      s.baud = n(baud)
    },
    end: () => {},
    print,
    println: (v?: unknown, fmt?: unknown) => print(v, fmt) + s.write('\r\n'),
    printf: (fmt: unknown, ...args: unknown[]) => s.write(formatPrintf(String(fmt), args.map(jsToVM))),
    write: (v: unknown) => s.write(typeof v === 'string' ? v : String.fromCharCode(n(v) & 0xff)),
    available: () => s.available(),
    read: () => s.read(),
    peek: () => s.peek(),
    readString: () => s.readString(),
    readStringUntil: (t: unknown) => s.readStringUntil(typeof t === 'string' ? t : String.fromCharCode(n(t) & 0xff)),
    parseInt: () => s.parseInt(),
    parseFloat: () => s.parseFloat(),
    flush: () => {},
    setTimeout: () => {},
  })
}

function servoClass(shim: ArduinoShim): unknown {
  const b = shim.servos
  return class Servo {
    readonly #h = b.createServo()
    attach(pin: unknown, min?: unknown, max?: unknown): number {
      return b.attach(this.#h, n(pin), optN(min), optN(max))
    }
    write(v: unknown): void {
      b.write(this.#h, Math.trunc(n(v)))
    }
    writeMicroseconds(us: unknown): void {
      b.writeMicroseconds(this.#h, n(us))
    }
    read(): number {
      return b.read(this.#h)
    }
    readMicroseconds(): number {
      return b.readMicroseconds(this.#h)
    }
    attached(): boolean {
      return b.attached(this.#h)
    }
    detach(): void {
      b.detach(this.#h)
    }
    setPeriodHertz(): void {}
  }
}

function pcaClass(shim: ArduinoShim): unknown {
  const b = shim.servos
  return class Adafruit_PWMServoDriver {
    readonly #h: number
    constructor(addr?: unknown) {
      this.#h = b.createPca(optN(addr))
    }
    begin(): boolean {
      return true
    }
    setPWMFreq(hz: unknown): void {
      b.setPWMFreq(this.#h, n(hz))
    }
    setOscillatorFrequency(): void {}
    setPWM(ch: unknown, on: unknown, off: unknown): void {
      b.setPWM(this.#h, n(ch), n(on), n(off))
    }
    setPin(ch: unknown, v: unknown, invert?: unknown): void {
      b.setPin(this.#h, n(ch), n(v), Boolean(invert))
    }
    writeMicroseconds(ch: unknown, us: unknown): void {
      b.pcaWriteMicroseconds(this.#h, n(ch), n(us))
    }
    sleep(): void {}
    wakeup(): void {}
    reset(): void {}
  }
}

function busObjects(shim: ArduinoShim): Record<string, unknown> {
  const wifi = <T>(v: T) => (): T => {
    shim.wifiCall()
    return v
  }
  return {
    Wire: Object.freeze({
      begin: () => shim.wireBegin(),
      setClock: () => {},
      beginTransmission: (a: unknown) => shim.wireBeginTransmission(n(a)),
      write: () => 1,
      endTransmission: () => shim.wireEndTransmission(),
      requestFrom: () => 0,
      available: () => 0,
      read: () => -1,
    }),
    SPI: Object.freeze({ begin: () => {}, end: () => {}, transfer: () => 0 }),
    Bridge: Object.freeze({ begin: () => shim.bridgeCall(), update: () => shim.bridgeCall() }),
    WiFi: Object.freeze({
      begin: wifi(WIFI_CONSTANTS.WL_CONNECTED),
      status: wifi(WIFI_CONSTANTS.WL_CONNECTED),
      mode: wifi(true),
      softAP: wifi(true),
      disconnect: () => true,
      localIP: () => '0.0.0.0',
      softAPIP: () => '0.0.0.0',
      RSSI: () => -50,
    }),
  }
}

/** Arduino map(): long arithmetic, truncating toward zero. */
export function arduinoMap(x: number, inLo: number, inHi: number, outLo: number, outHi: number): number {
  const a = Math.trunc(x)
  const il = Math.trunc(inLo)
  const ih = Math.trunc(inHi)
  if (ih === il) return Math.trunc(outLo)
  return Math.trunc(((a - il) * (Math.trunc(outHi) - Math.trunc(outLo))) / (ih - il)) + Math.trunc(outLo)
}

function helpers(shim: ArduinoShim, hooks: JsHooks): Record<string, unknown> {
  const p = shim.pins
  return {
    pinMode: (pin: unknown, mode: unknown) => p.pinMode(n(pin), n(mode)),
    digitalWrite: (pin: unknown, v: unknown) => p.digitalWrite(n(pin), typeof v === 'boolean' ? (v ? 1 : 0) : n(v)),
    digitalRead: (pin: unknown) => p.digitalRead(n(pin)),
    analogRead: (pin: unknown) => p.analogRead(n(pin), shim.now),
    analogWrite: (pin: unknown, v: unknown) => p.analogWrite(n(pin), n(v)),
    analogReadResolution: (b: unknown) => p.analogReadResolution(n(b)),
    analogWriteResolution: (b: unknown) => p.analogWriteResolution(n(b)),
    tone: () => {},
    noTone: () => {},
    millis: () => shim.millis(),
    micros: () => shim.micros(),
    delay: (ms: unknown) => hooks.delay(n(ms)),
    delayMicroseconds: (us: unknown) => hooks.delay(n(us) / 1000),
    watch: (name: unknown, v: unknown) => hooks.watch(String(name), v),
    map: (x: unknown, a: unknown, b: unknown, c: unknown, d: unknown) => arduinoMap(n(x), n(a), n(b), n(c), n(d)),
    constrain: (x: unknown, lo: unknown, hi: unknown) => Math.min(Math.max(n(x), n(lo)), n(hi)),
    min: (a: unknown, b: unknown) => Math.min(n(a), n(b)),
    max: (a: unknown, b: unknown) => Math.max(n(a), n(b)),
    abs: (a: unknown) => Math.abs(n(a)),
    sq: (a: unknown) => n(a) * n(a),
    radians: (d: unknown) => (n(d) * Math.PI) / 180,
    degrees: (r: unknown) => (n(r) * 180) / Math.PI,
    random: (a: unknown, b?: unknown) => shim.random(n(a), optN(b)),
    randomSeed: (s: unknown) => shim.randomSeed(n(s)),
    PI: Math.PI,
    HALF_PI: Math.PI / 2,
    TWO_PI: Math.PI * 2,
    DEG_TO_RAD: Math.PI / 180,
    RAD_TO_DEG: 180 / Math.PI,
  }
}

function robotFns(shim: ArduinoShim): Record<string, unknown> {
  const reserved = reservedNames()
  const out: Record<string, unknown> = {}
  for (const f of shim.api) {
    if (reserved.has(f.name) || STRICT_RESERVED.has(f.name)) continue
    const name = f.name
    out[name] = f.kind === 'command'
      ? (...args: unknown[]): void => {
          shim.callRobot(name, args.map(n))
        }
      : (...args: unknown[]): number => shim.callRobot(name, args.map(n))
  }
  return out
}

export interface JsScope {
  names: string[]
  values: unknown[]
}

/** Parameter names and values for `new Function(...names, body)(...values)`. */
export function buildJsScope(shim: ArduinoShim, hooks: JsHooks): JsScope {
  const scope: Record<string, unknown> = {
    ...boardConstants(shim.hw.board),
    ...helpers(shim, hooks),
    ...busObjects(shim),
    Serial: serialObject(shim),
    Servo: servoClass(shim),
    Adafruit_PWMServoDriver: pcaClass(shim),
    ...robotFns(shim),
  }
  for (const g of SHADOWED_GLOBALS) scope[g] = undefined
  const names = Object.keys(scope).filter((k) => !STRICT_RESERVED.has(k))
  return { names, values: names.map((k) => scope[k]) }
}
