import type { CompileOptions, NativeFnSig, ValueType, VMHost, VMValue } from '../../compiler/api'
import type { BoardId } from '../../core/protocol'
import type { SandboxFnDef } from '../../core/types'
import type { ArduinoShim } from './arduino'
import { KNOWN_INCLUDES, WIFI_CONSTANTS, boardConstants } from './boards'
import { formatPrint, formatPrintf } from './format'
import { reservedNames, shimClassSigs, shimFunctionSigs, SHIM_OBJECTS } from './reference'

/* ============================================================
   C++ BINDING — CompileOptions for the Arduino subset compiler and
   the VMHost that serves every native call from the shim.
   ============================================================ */

type Handler = (args: VMValue[], types: ValueType[], self: number | null) => VMValue | void

/** Robot API as natives: commands take floats and return void, queries return float. */
export function robotSigs(api: readonly SandboxFnDef[]): NativeFnSig[] {
  const reserved = reservedNames()
  const seen = new Set<string>()
  const out: NativeFnSig[] = []
  for (const f of api) {
    if (reserved.has(f.name) || seen.has(f.name)) continue
    seen.add(f.name)
    out.push({
      name: f.name,
      params: f.params.map((): ValueType => 'float'),
      returns: f.kind === 'command' ? 'void' : 'float',
      doc: f.doc,
    })
  }
  return out
}

export function buildCompileOptions(api: readonly SandboxFnDef[], board: BoardId, intBits: 16 | 32): CompileOptions {
  return {
    functions: [...shimFunctionSigs(), ...robotSigs(api)],
    classes: shimClassSigs(),
    objects: SHIM_OBJECTS.map((name) => ({ name })),
    constants: boardConstants(board),
    intBits,
    knownIncludes: [...KNOWN_INCLUDES],
  }
}

function num(v: VMValue | undefined): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') return Number(v) || 0
  return 0
}

function str(v: VMValue | undefined): string {
  return typeof v === 'string' ? v : v === undefined ? '' : String(v)
}

function optNum(args: VMValue[], i: number): number | undefined {
  return i < args.length ? num(args[i]) : undefined
}

function serialHandlers(shim: ArduinoShim): Record<string, Handler> {
  const s = shim.serial
  const print = (args: VMValue[], types: ValueType[]): number =>
    args.length === 0 ? 0 : s.write(formatPrint(args[0], types[0] ?? 'any', optNum(args, 1)))
  return {
    'Serial.begin': (a) => {
      s.baud = num(a[0])
    },
    'Serial.end': () => {},
    'Serial.print': (a, t) => print(a, t),
    'Serial.println': (a, t) => print(a, t) + s.write('\r\n'),
    'Serial.printf': (a) => s.write(formatPrintf(str(a[0]), a.slice(1))),
    'Serial.write': (a) => s.write(typeof a[0] === 'string' ? a[0] : String.fromCharCode(num(a[0]) & 0xff)),
    'Serial.available': () => s.available(),
    'Serial.read': () => s.read(),
    'Serial.peek': () => s.peek(),
    'Serial.readString': () => s.readString(),
    'Serial.readStringUntil': (a) => s.readStringUntil(typeof a[0] === 'string' ? a[0] : String.fromCharCode(num(a[0]) & 0xff)),
    'Serial.parseInt': () => s.parseInt(),
    'Serial.parseFloat': () => s.parseFloat(),
    'Serial.flush': () => {},
    'Serial.setTimeout': () => {},
  }
}

function pinHandlers(shim: ArduinoShim): Record<string, Handler> {
  const p = shim.pins
  return {
    pinMode: (a) => p.pinMode(num(a[0]), num(a[1])),
    digitalWrite: (a) => p.digitalWrite(num(a[0]), num(a[1])),
    digitalRead: (a) => p.digitalRead(num(a[0])),
    analogRead: (a) => p.analogRead(num(a[0]), shim.now),
    analogWrite: (a) => p.analogWrite(num(a[0]), num(a[1])),
    analogReadResolution: (a) => p.analogReadResolution(num(a[0])),
    analogWriteResolution: (a) => p.analogWriteResolution(num(a[0])),
    tone: () => {},
    noTone: () => {},
  }
}

function busHandlers(shim: ArduinoShim): Record<string, Handler> {
  const wifi = (v: VMValue): Handler => () => {
    shim.wifiCall()
    return v
  }
  return {
    'Wire.begin': () => shim.wireBegin(),
    'Wire.setClock': () => {},
    'Wire.beginTransmission': (a) => shim.wireBeginTransmission(num(a[0])),
    'Wire.write': () => 1,
    'Wire.endTransmission': () => shim.wireEndTransmission(),
    'Wire.requestFrom': () => 0,
    'Wire.available': () => 0,
    'Wire.read': () => -1,
    'SPI.begin': () => {},
    'SPI.end': () => {},
    'SPI.transfer': () => 0,
    'Bridge.begin': () => shim.bridgeCall(),
    'Bridge.update': () => shim.bridgeCall(),
    'WiFi.begin': wifi(WIFI_CONSTANTS.WL_CONNECTED),
    'WiFi.status': wifi(WIFI_CONSTANTS.WL_CONNECTED),
    'WiFi.mode': wifi(true),
    'WiFi.softAP': wifi(true),
    'WiFi.disconnect': () => true,
    'WiFi.localIP': () => '0.0.0.0',
    'WiFi.softAPIP': () => '0.0.0.0',
    'WiFi.RSSI': () => -50,
  }
}

function classHandlers(shim: ArduinoShim): Record<string, Handler> {
  const b = shim.servos
  return {
    'Servo.attach': (a, _t, h) => b.attach(h, num(a[0]), optNum(a, 1), optNum(a, 2)),
    'Servo.write': (a, _t, h) => b.write(h, num(a[0])),
    'Servo.writeMicroseconds': (a, _t, h) => b.writeMicroseconds(h, num(a[0])),
    'Servo.read': (_a, _t, h) => b.read(h),
    'Servo.readMicroseconds': (_a, _t, h) => b.readMicroseconds(h),
    'Servo.attached': (_a, _t, h) => b.attached(h),
    'Servo.detach': (_a, _t, h) => b.detach(h),
    'Servo.setPeriodHertz': () => {},
    'Adafruit_PWMServoDriver.begin': () => true,
    'Adafruit_PWMServoDriver.setPWMFreq': (a, _t, h) => b.setPWMFreq(h, num(a[0])),
    'Adafruit_PWMServoDriver.setOscillatorFrequency': () => {},
    'Adafruit_PWMServoDriver.setPWM': (a, _t, h) => b.setPWM(h, num(a[0]), num(a[1]), num(a[2])),
    'Adafruit_PWMServoDriver.setPin': (a, _t, h) => b.setPin(h, num(a[0]), num(a[1]), Boolean(a[2])),
    'Adafruit_PWMServoDriver.writeMicroseconds': (a, _t, h) => b.pcaWriteMicroseconds(h, num(a[0]), num(a[1])),
    'Adafruit_PWMServoDriver.sleep': () => {},
    'Adafruit_PWMServoDriver.wakeup': () => {},
    'Adafruit_PWMServoDriver.reset': () => {},
  }
}

/** Dispatch table: every shim native plus the robot API. */
export function nativeHandlers(shim: ArduinoShim): Map<string, Handler> {
  const table = new Map<string, Handler>(Object.entries({
    ...pinHandlers(shim),
    ...serialHandlers(shim),
    ...busHandlers(shim),
    ...classHandlers(shim),
  }))
  for (const f of robotSigs(shim.api)) {
    const name = f.name
    const scratch: number[] = []
    table.set(name, (a) => {
      scratch.length = a.length
      for (let i = 0; i < a.length; i++) scratch[i] = num(a[i])
      const r = shim.callRobot(name, scratch)
      return f.returns === 'void' ? undefined : r
    })
  }
  return table
}

/** VMHost over the shim. Unknown natives throw, which the VM reports at the call site. */
export function createCppHost(shim: ArduinoShim): VMHost {
  const table = nativeHandlers(shim)
  return {
    callNative(name, args, argTypes, self) {
      const h = table.get(name)
      if (!h) throw new Error(`${name}() is not available in the sandbox`)
      return h(args, argTypes, self)
    },
    constructNative(className, args) {
      if (className === 'Servo') return shim.servos.createServo()
      if (className === 'Adafruit_PWMServoDriver') return shim.servos.createPca(args.length > 0 ? num(args[0]) : undefined)
      throw new Error(`${className} is not available in the sandbox`)
    },
  }
}
