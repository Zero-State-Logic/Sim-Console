import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig } from '../../core/hardware'
import type { SandboxFnDef } from '../../core/types'
import { ArduinoShim } from './arduino'
import { SHADOWED_GLOBALS, arduinoMap, buildJsScope, jsToVM } from './jsBinding'

const API: SandboxFnDef[] = [
  { name: 'setJoint', kind: 'command', params: ['joint', 'deg'], doc: '' },
  { name: 'readImu', kind: 'query', params: ['axis'], sensor: 'imu', doc: '' },
  { name: 'random', kind: 'query', params: [], sensor: 'x', doc: 'collides with a shim name' },
  { name: 'delete', kind: 'command', params: [], doc: 'not a legal parameter name' },
]

/** Scope as a name -> value record, for poking at bindings directly. */
function scopeOf(shim: ArduinoShim, delays: number[] = []): Record<string, unknown> {
  const s = buildJsScope(shim, {
    delay: (ms) => {
      delays.push(ms)
      return Promise.resolve()
    },
    watch: () => {},
  })
  return Object.fromEntries(s.names.map((n, i) => [n, s.values[i]]))
}

type Fn = (...a: unknown[]) => unknown

describe('buildJsScope', () => {
  it('binds shadowed globals to undefined and skips illegal or reserved robot names', () => {
    // Arrange
    const shim = new ArduinoShim({ ...defaultHardwareConfig('esp32', 12) }, API)
    // Act
    const scope = buildJsScope(shim, { delay: () => Promise.resolve(), watch: () => {} })
    // Assert
    for (const g of SHADOWED_GLOBALS) {
      expect(scope.names).toContain(g)
      expect(scope.values[scope.names.indexOf(g)]).toBeUndefined()
    }
    expect(scope.names).not.toContain('delete')
    expect(new Set(scope.names).size).toBe(scope.names.length)
  })

  it('exposes board constants and the Arduino helpers', () => {
    const shim = new ArduinoShim({ ...defaultHardwareConfig('stm32', 12) }, API)
    const s = scopeOf(shim)
    expect(s.LED_BUILTIN).toBe(45)
    expect(s.PA9).toBe(9)
    expect((s.map as Fn)(512, 0, 1023, 0, 180)).toBe(90)
    expect((s.constrain as Fn)(5, 0, 3)).toBe(3)
    expect((s.radians as Fn)(180)).toBeCloseTo(Math.PI, 12)
    expect((s.sq as Fn)(4)).toBe(16)
  })

  it('keeps the shim random() when the robot API reuses the name', () => {
    const shim = new ArduinoShim({ ...defaultHardwareConfig('esp32', 12) }, API)
    const s = scopeOf(shim)
    const v = (s.random as Fn)(3, 6) as number
    expect(v).toBeGreaterThanOrEqual(3)
    expect(v).toBeLessThan(6)
  })

  it('routes delay / delayMicroseconds to the runner and reads the virtual clock', () => {
    const shim = new ArduinoShim({ ...defaultHardwareConfig('esp32', 12) }, API)
    const delays: number[] = []
    const s = scopeOf(shim, delays)
    shim.beginTick(0, {})
    shim.now = 1234.56
    expect((s.millis as Fn)()).toBe(1234)
    expect((s.micros as Fn)()).toBe(1234560)
    void (s.delay as Fn)(20)
    void (s.delayMicroseconds as Fn)(500)
    expect(delays).toEqual([20, 0.5])
  })

  it('counts millis() from the program start, like a board boot (and the C++ VM)', () => {
    // Arrange: the program starts 12.5 s into the simulation
    const shim = new ArduinoShim({ ...defaultHardwareConfig('esp32', 12) }, API)
    const s = scopeOf(shim)
    const before = (s.millis as Fn)()
    // Act
    shim.beginTick(12_500, {})
    const atStart = (s.millis as Fn)()
    shim.beginTick(12_750.4, {})
    const later = (s.millis as Fn)()
    shim.reset()
    shim.beginTick(20_000, {})
    const afterReset = (s.millis as Fn)()
    // Assert
    expect([before, atStart, later, afterReset]).toEqual([0, 0, 250, 0])
  })

  it('serves Serial, Wire, SPI, Bridge and WiFi like the C++ host', () => {
    const shim = new ArduinoShim({ ...defaultHardwareConfig('esp32', 12) }, API)
    const s = scopeOf(shim)
    const serial = s.Serial as Record<string, Fn>
    serial.begin(115200)
    serial.print('a')
    serial.println(1.5)
    serial.printf('%03d', 7)
    serial.write(66)
    shim.serial.feed('42 x\n')
    expect(serial.available()).toBe(5)
    expect(serial.parseInt()).toBe(42)
    expect(serial.readStringUntil('\n')).toBe(' x')
    expect(shim.takeOutput().serial.join('')).toBe('a1.50\r\n007B')
    const wire = s.Wire as Record<string, Fn>
    wire.begin()
    wire.beginTransmission(0x40)
    expect(wire.endTransmission()).toBe(2)
    expect((s.SPI as Record<string, Fn>).transfer(1)).toBe(0)
    ;(s.Bridge as Record<string, Fn>).begin()
    expect((s.WiFi as Record<string, Fn>).status()).toBe(3)
    expect(shim.takeOutput().log.map((l) => l.level)).toEqual(['info', 'warn'])
  })

  it('drives a PCA9685 object to joints', () => {
    const shim = new ArduinoShim({ ...defaultHardwareConfig('esp32', 18) }, API)
    const s = scopeOf(shim)
    const Pca = s.Adafruit_PWMServoDriver as new (addr?: number) => Record<string, Fn>
    const pwm = new Pca(0x40)
    expect(pwm.begin()).toBe(true)
    pwm.setPWMFreq(50)
    pwm.writeMicroseconds(2, 1500)
    pwm.setPin(3, 307)
    const cmds = shim.takeOutput().cmds
    expect(cmds[0]).toEqual({ fn: 'setJoint', args: [2, 0] })
    expect(cmds[1].args[0]).toBe(3)
  })

  it('calls robot commands and queries with numeric arguments', () => {
    const shim = new ArduinoShim({ ...defaultHardwareConfig('esp32', 12) }, API)
    const s = scopeOf(shim)
    shim.beginTick(0, { imu: [4, 5, 6] })
    expect((s.readImu as Fn)(1)).toBe(5)
    expect((s.setJoint as Fn)('2', 10)).toBeUndefined()
    expect(shim.takeOutput().cmds).toEqual([{ fn: 'setJoint', args: [2, 10] }])
  })

  it('digitalWrite accepts booleans', () => {
    const shim = new ArduinoShim({ ...defaultHardwareConfig('esp32', 12) }, API)
    const s = scopeOf(shim)
    ;(s.digitalWrite as Fn)(2, true)
    expect(shim.led).toBe(1)
  })
})

describe('helpers', () => {
  it('arduinoMap truncates like long arithmetic', () => {
    expect(arduinoMap(5, 0, 10, 0, 3)).toBe(1)
    expect(arduinoMap(-5, 0, 10, 0, 3)).toBe(-1)
    expect(arduinoMap(3, 2, 2, 7, 9)).toBe(7)
  })

  it('jsToVM converts nested values for printing', () => {
    expect(jsToVM({ a: [1, true], b: null })).toEqual({ a: [1, true], b: 'null' })
    expect(jsToVM(undefined)).toBe('undefined')
  })
})
