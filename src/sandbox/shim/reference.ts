import type { NativeClassSig, NativeFnSig, ValueType } from '../../compiler/api'

/* ============================================================
   SHIM SIGNATURES — one table feeds the compiler's native list
   (C++), the API reference pane (both dialects) and the tests.
   ============================================================ */

export type Param = readonly [name: string, type: ValueType]

export interface ShimFn {
  /** Free function, or 'Object.method' for Serial / Wire / SPI / Bridge / WiFi. */
  name: string
  params: readonly Param[]
  /** Trailing params that may be omitted. */
  optional?: number
  returns: ValueType
  doc: string
  group: string
}

export interface ShimClass {
  name: string
  ctor: readonly Param[]
  ctorOptional?: number
  methods: readonly ShimFn[]
  doc: string
}

const PRINTF_ARGS = 8
const printfParams: Param[] = [['format', 'string'], ...Array.from({ length: PRINTF_ARGS }, (_, i): Param => [`a${i + 1}`, 'any'])]

export const SHIM_FUNCTIONS: readonly ShimFn[] = [
  { group: 'PINS', name: 'pinMode', params: [['pin', 'int'], ['mode', 'int']], returns: 'void', doc: 'INPUT, OUTPUT, INPUT_PULLUP or INPUT_PULLDOWN.' },
  { group: 'PINS', name: 'digitalWrite', params: [['pin', 'int'], ['value', 'int']], returns: 'void', doc: 'HIGH or LOW. LED_BUILTIN lights the indicator in the CODE panel.' },
  { group: 'PINS', name: 'digitalRead', params: [['pin', 'int']], returns: 'int', doc: 'OUTPUT pins read back their level, INPUT_PULLUP reads HIGH, floating inputs read LOW.' },
  { group: 'PINS', name: 'analogRead', params: [['pin', 'int']], returns: 'int', doc: 'Deterministic pseudo-noise around a per-pin level (0..1023, ESP32 0..4095).' },
  { group: 'PINS', name: 'analogWrite', params: [['pin', 'int'], ['duty', 'int']], returns: 'void', doc: 'PWM duty 0..255. On LED_BUILTIN it sets the brightness.' },
  { group: 'PINS', name: 'analogReadResolution', params: [['bits', 'int']], returns: 'void', doc: 'ADC resolution, 1..16 bits.' },
  { group: 'PINS', name: 'analogWriteResolution', params: [['bits', 'int']], returns: 'void', doc: 'PWM resolution, 1..16 bits.' },
  { group: 'PINS', name: 'tone', params: [['pin', 'int'], ['hz', 'unsigned'], ['ms', 'unsigned']], optional: 1, returns: 'void', doc: 'Accepted, silent.' },
  { group: 'PINS', name: 'noTone', params: [['pin', 'int']], returns: 'void', doc: 'Accepted, silent.' },

  { group: 'SERIAL', name: 'Serial.begin', params: [['baud', 'any'], ['config', 'any']], optional: 1, returns: 'void', doc: 'Any baud works; output goes to CONSOLE.' },
  { group: 'SERIAL', name: 'Serial.end', params: [], returns: 'void', doc: 'No-op.' },
  { group: 'SERIAL', name: 'Serial.print', params: [['value', 'any'], ['format', 'int']], optional: 1, returns: 'int', doc: 'Arduino formatting: ints in DEC / HEX / OCT / BIN, floats with 2 digits (or the given count).' },
  { group: 'SERIAL', name: 'Serial.println', params: [['value', 'any'], ['format', 'int']], optional: 2, returns: 'int', doc: 'print() then "\\r\\n".' },
  { group: 'SERIAL', name: 'Serial.printf', params: printfParams, optional: PRINTF_ARGS, returns: 'int', doc: 'printf subset: %d %i %u %x %X %o %c %s %f %e %g %%, flags, width, precision (up to 8 args).' },
  { group: 'SERIAL', name: 'Serial.write', params: [['byteOrText', 'any']], returns: 'int', doc: 'A byte as a character, or a string as is.' },
  { group: 'SERIAL', name: 'Serial.available', params: [], returns: 'int', doc: 'Bytes typed into the CONSOLE input and not read yet.' },
  { group: 'SERIAL', name: 'Serial.read', params: [], returns: 'int', doc: 'Next input byte, or -1.' },
  { group: 'SERIAL', name: 'Serial.peek', params: [], returns: 'int', doc: 'Next input byte without consuming it, or -1.' },
  { group: 'SERIAL', name: 'Serial.readString', params: [], returns: 'string', doc: 'All pending input.' },
  { group: 'SERIAL', name: 'Serial.readStringUntil', params: [['terminator', 'char']], returns: 'string', doc: 'Input up to the terminator (consumed, not returned).' },
  { group: 'SERIAL', name: 'Serial.parseInt', params: [], returns: 'long', doc: 'Next integer in the input, or 0 (no timeout).' },
  { group: 'SERIAL', name: 'Serial.parseFloat', params: [], returns: 'float', doc: 'Next number in the input, or 0 (no timeout).' },
  { group: 'SERIAL', name: 'Serial.flush', params: [], returns: 'void', doc: 'No-op (output is never buffered).' },
  { group: 'SERIAL', name: 'Serial.setTimeout', params: [['ms', 'any']], returns: 'void', doc: 'Accepted; reads never block.' },

  { group: 'I2C / SPI', name: 'Wire.begin', params: [['sda', 'any'], ['scl', 'any']], optional: 2, returns: 'void', doc: 'Virtual I2C bus. Only PCA9685 objects answer.' },
  { group: 'I2C / SPI', name: 'Wire.setClock', params: [['hz', 'unsigned']], returns: 'void', doc: 'Accepted.' },
  { group: 'I2C / SPI', name: 'Wire.beginTransmission', params: [['addr', 'int']], returns: 'void', doc: 'Start a write to a 7-bit address.' },
  { group: 'I2C / SPI', name: 'Wire.write', params: [['value', 'any']], returns: 'int', doc: 'Queued and discarded.' },
  { group: 'I2C / SPI', name: 'Wire.endTransmission', params: [['stop', 'bool']], optional: 1, returns: 'int', doc: '0 when a PCA9685 object lives at the address, else 2 (NACK).' },
  { group: 'I2C / SPI', name: 'Wire.requestFrom', params: [['addr', 'int'], ['count', 'int']], returns: 'int', doc: 'Always 0 bytes.' },
  { group: 'I2C / SPI', name: 'Wire.available', params: [], returns: 'int', doc: 'Always 0.' },
  { group: 'I2C / SPI', name: 'Wire.read', params: [], returns: 'int', doc: 'Always -1.' },
  { group: 'I2C / SPI', name: 'SPI.begin', params: [], returns: 'void', doc: 'Accepted.' },
  { group: 'I2C / SPI', name: 'SPI.end', params: [], returns: 'void', doc: 'Accepted.' },
  { group: 'I2C / SPI', name: 'SPI.transfer', params: [['value', 'int']], returns: 'int', doc: 'Returns 0 (nothing on the bus).' },

  { group: 'STUBS', name: 'Bridge.begin', params: [], returns: 'void', doc: 'kiyobridge entry point. No-op here, so a pasted firmware sketch still compiles.' },
  { group: 'STUBS', name: 'Bridge.update', params: [], returns: 'void', doc: 'kiyobridge pump. No-op here.' },
  { group: 'STUBS', name: 'WiFi.begin', params: [['ssid', 'any'], ['pass', 'any']], optional: 1, returns: 'int', doc: 'Not simulated. Returns WL_CONNECTED.' },
  { group: 'STUBS', name: 'WiFi.status', params: [], returns: 'int', doc: 'Always WL_CONNECTED.' },
  { group: 'STUBS', name: 'WiFi.mode', params: [['mode', 'int']], returns: 'bool', doc: 'Not simulated.' },
  { group: 'STUBS', name: 'WiFi.softAP', params: [['ssid', 'any'], ['pass', 'any']], optional: 1, returns: 'bool', doc: 'Not simulated.' },
  { group: 'STUBS', name: 'WiFi.disconnect', params: [], returns: 'bool', doc: 'Not simulated.' },
  { group: 'STUBS', name: 'WiFi.localIP', params: [], returns: 'string', doc: 'Always "0.0.0.0".' },
  { group: 'STUBS', name: 'WiFi.softAPIP', params: [], returns: 'string', doc: 'Always "0.0.0.0".' },
  { group: 'STUBS', name: 'WiFi.RSSI', params: [], returns: 'int', doc: 'Always -50.' },
]

export const SHIM_OBJECTS: readonly string[] = ['Serial', 'Wire', 'SPI', 'Bridge', 'WiFi']

export const SHIM_CLASSES: readonly ShimClass[] = [
  {
    name: 'Servo',
    ctor: [],
    doc: 'Servo.h / ESP32Servo.h. attach(pin) maps the pin to a joint through the hardware profile.',
    methods: [
      { group: 'SERVO', name: 'attach', params: [['pin', 'int'], ['minUs', 'int'], ['maxUs', 'int']], optional: 2, returns: 'int', doc: 'Bind to a pin; without limits the profile\'s pulse range is used.' },
      { group: 'SERVO', name: 'write', params: [['value', 'int']], returns: 'void', doc: 'Degrees 0..180 (values from 544 up are microseconds, like Servo.h).' },
      { group: 'SERVO', name: 'writeMicroseconds', params: [['us', 'int']], returns: 'void', doc: 'Pulse width, clamped to the attach() range.' },
      { group: 'SERVO', name: 'read', params: [], returns: 'int', doc: 'Last command, degrees.' },
      { group: 'SERVO', name: 'readMicroseconds', params: [], returns: 'int', doc: 'Last pulse width.' },
      { group: 'SERVO', name: 'attached', params: [], returns: 'bool', doc: 'True after attach().' },
      { group: 'SERVO', name: 'detach', params: [], returns: 'void', doc: 'Stop driving the joint.' },
      { group: 'SERVO', name: 'setPeriodHertz', params: [['hz', 'int']], returns: 'void', doc: 'ESP32Servo. Accepted (50 Hz assumed).' },
    ],
  },
  {
    name: 'Adafruit_PWMServoDriver',
    ctor: [['addr', 'int'], ['wire', 'any']],
    ctorOptional: 2,
    doc: 'PCA9685 16-channel PWM board (default address 0x40; 0x41 = channels 16-31 in the pin map).',
    methods: [
      { group: 'PCA9685', name: 'begin', params: [['prescale', 'int']], optional: 1, returns: 'bool', doc: 'Always true.' },
      { group: 'PCA9685', name: 'setPWMFreq', params: [['hz', 'float']], returns: 'void', doc: 'PWM frequency, 24..1526 Hz (servos use 50).' },
      { group: 'PCA9685', name: 'setOscillatorFrequency', params: [['hz', 'unsigned']], returns: 'void', doc: 'Accepted.' },
      { group: 'PCA9685', name: 'setPWM', params: [['ch', 'int'], ['on', 'int'], ['off', 'int']], returns: 'void', doc: 'Pulse from tick `on` to tick `off` of 4096; becomes a joint angle.' },
      { group: 'PCA9685', name: 'setPin', params: [['ch', 'int'], ['value', 'int'], ['invert', 'bool']], optional: 1, returns: 'void', doc: 'Duty in ticks 0..4095.' },
      { group: 'PCA9685', name: 'writeMicroseconds', params: [['ch', 'int'], ['us', 'int']], returns: 'void', doc: 'Pulse width on a channel.' },
      { group: 'PCA9685', name: 'sleep', params: [], returns: 'void', doc: 'Accepted.' },
      { group: 'PCA9685', name: 'wakeup', params: [], returns: 'void', doc: 'Accepted.' },
      { group: 'PCA9685', name: 'reset', params: [], returns: 'void', doc: 'Accepted.' },
    ],
  },
]

/** Builtins the VM implements itself (listed in the reference pane only). */
export const VM_BUILTINS: readonly { group: string; sig: string; doc: string }[] = [
  { group: 'TIME', sig: 'unsigned long millis()', doc: 'Virtual milliseconds since start (sim time).' },
  { group: 'TIME', sig: 'unsigned long micros()', doc: 'Virtual microseconds.' },
  { group: 'TIME', sig: 'void delay(unsigned long ms)', doc: 'Sleeps in virtual time; the robot keeps moving meanwhile.' },
  { group: 'TIME', sig: 'void delayMicroseconds(unsigned int us)', doc: 'Virtual-time sleep.' },
  { group: 'MATH', sig: 'map(x, inLo, inHi, outLo, outHi)', doc: 'Integer re-map, like Arduino.' },
  { group: 'MATH', sig: 'constrain(x, lo, hi)  min  max  abs  sq  sqrt  pow', doc: 'Arduino math helpers.' },
  { group: 'MATH', sig: 'sin cos tan asin acos atan atan2 exp log log10', doc: 'math.h, radians.' },
  { group: 'MATH', sig: 'floor ceil round fabs fmod radians degrees', doc: 'math.h and Arduino helpers.' },
  { group: 'MATH', sig: 'random(max)  random(min, max)  randomSeed(s)', doc: 'Pseudo-random integers.' },
  { group: 'MATH', sig: 'bitRead bitWrite bitSet bitClear bit highByte lowByte', doc: 'Bit helpers.' },
  { group: 'STRING', sig: 'String s = "..."; s.length() s.substring() s.indexOf() s.toInt() ...', doc: 'Arduino String subset, + concatenation.' },
  { group: 'CONSTANTS', sig: 'HIGH LOW INPUT OUTPUT INPUT_PULLUP LED_BUILTIN A0..A7 DEC HEX OCT BIN PA0..PC15 PI', doc: 'Board constants (pins follow the selected board).' },
]

function toSig(f: ShimFn): NativeFnSig {
  const sig: NativeFnSig = { name: f.name, params: f.params.map((p) => p[1]), returns: f.returns, doc: f.doc }
  if (f.optional) sig.optional = f.optional
  return sig
}

export function shimFunctionSigs(): NativeFnSig[] {
  return SHIM_FUNCTIONS.map(toSig)
}

export function shimClassSigs(): NativeClassSig[] {
  return SHIM_CLASSES.map((c) => {
    const sig: NativeClassSig = { name: c.name, ctorParams: c.ctor.map((p) => p[1]), methods: c.methods.map(toSig) }
    if (c.ctorOptional) sig.ctorOptional = c.ctorOptional
    return sig
  })
}

/** Every name the shim reserves (robot API functions may not reuse them). */
export function reservedNames(): Set<string> {
  const names = new Set<string>([...SHIM_OBJECTS, ...SHIM_CLASSES.map((c) => c.name)])
  for (const f of SHIM_FUNCTIONS) if (!f.name.includes('.')) names.add(f.name)
  for (const n of ['millis', 'micros', 'delay', 'delayMicroseconds', 'map', 'constrain', 'min', 'max', 'abs', 'random', 'randomSeed', 'watch']) names.add(n)
  return names
}
