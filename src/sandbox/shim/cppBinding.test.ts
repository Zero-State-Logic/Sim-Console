import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig } from '../../core/hardware'
import type { SandboxFnDef } from '../../core/types'
import type { HwMap } from '../protocol'
import { ArduinoShim } from './arduino'
import { boardConstants, scanIncludes } from './boards'
import { buildCompileOptions, createCppHost, robotSigs } from './cppBinding'

const API: SandboxFnDef[] = [
  { name: 'setJoint', kind: 'command', params: ['joint', 'deg'], doc: 'Drive a joint.' },
  { name: 'readImu', kind: 'query', params: ['axis'], sensor: 'imu', doc: 'Attitude.' },
  { name: 'delay', kind: 'command', params: ['ms'], doc: 'Collides with a builtin.' },
]

function hw(): HwMap {
  const c = defaultHardwareConfig('esp32', 12)
  return { ...c }
}

function serialText(shim: ArduinoShim): string {
  return shim.takeOutput().serial.join('')
}

describe('buildCompileOptions', () => {
  it('declares robot commands as void(float...) and queries as float(float...)', () => {
    const sigs = robotSigs(API)
    expect(sigs.find((s) => s.name === 'setJoint')).toMatchObject({ params: ['float', 'float'], returns: 'void' })
    expect(sigs.find((s) => s.name === 'readImu')).toMatchObject({ params: ['float'], returns: 'float' })
  })

  it('never lets a robot function shadow a shim name', () => {
    expect(robotSigs(API).some((s) => s.name === 'delay')).toBe(false)
  })

  it('includes the shim natives, classes, objects, board constants and headers', () => {
    const o = buildCompileOptions(API, 'stm32', 32)
    const names = o.functions.map((f) => f.name)
    expect(names).toEqual(expect.arrayContaining(['pinMode', 'Serial.println', 'Serial.printf', 'Wire.begin', 'Bridge.update', 'setJoint']))
    expect(o.classes.map((c) => c.name)).toEqual(['Servo', 'Adafruit_PWMServoDriver'])
    expect(o.objects.map((x) => x.name)).toEqual(['Serial', 'Wire', 'SPI', 'Bridge', 'WiFi'])
    expect(o.constants.PB6).toBe(22)
    expect(o.constants.LED_BUILTIN).toBe(45)
    expect(o.constants.HEX).toBe(16)
    expect(o.intBits).toBe(32)
    expect(o.knownIncludes).toEqual(expect.arrayContaining(['Servo.h', 'Adafruit_PWMServoDriver.h', 'kiyobridge.h', 'WiFi.h']))
  })
})

describe('createCppHost', () => {
  it('formats Serial.print by the static argument type', () => {
    // Arrange
    const shim = new ArduinoShim(hw(), API)
    const host = createCppHost(shim)
    // Act
    host.callNative('Serial.print', [3], ['int'], null)
    host.callNative('Serial.print', [' '], ['string'], null)
    host.callNative('Serial.print', [3], ['float'], null)
    host.callNative('Serial.print', [' '], ['string'], null)
    host.callNative('Serial.println', [255, 16], ['int', 'int'], null)
    // Assert
    expect(serialText(shim)).toBe('3 3.00 FF\r\n')
  })

  it('prints a bare newline for println() and supports printf and write', () => {
    const shim = new ArduinoShim(hw(), API)
    const host = createCppHost(shim)
    host.callNative('Serial.println', [], [], null)
    host.callNative('Serial.printf', ['%d-%s', 4, 'ok'], ['string', 'int', 'string'], null)
    host.callNative('Serial.write', [65], ['int'], null)
    expect(serialText(shim)).toBe('\r\n4-okA')
  })

  it('passes the instance handle to Servo methods', () => {
    const shim = new ArduinoShim(hw(), API)
    const host = createCppHost(shim)
    const a = host.constructNative('Servo', [])
    const b = host.constructNative('Servo', [])
    host.callNative('Servo.attach', [13], ['int'], a)
    host.callNative('Servo.attach', [14], ['int'], b)
    host.callNative('Servo.write', [90], ['int'], b)
    expect(shim.takeOutput().cmds).toEqual([{ fn: 'setJoint', args: [1, 0] }])
    expect(host.callNative('Servo.read', [], [], b)).toBe(90)
    expect(host.callNative('Servo.attached', [], [], a)).toBe(true)
  })

  it('constructs a PCA9685 at the given address', () => {
    const shim = new ArduinoShim({ ...defaultHardwareConfig('esp32', 18) }, API)
    const host = createCppHost(shim)
    const pwm = host.constructNative('Adafruit_PWMServoDriver', [0x41])
    host.callNative('Adafruit_PWMServoDriver.writeMicroseconds', [0, 1500], ['int', 'int'], pwm)
    expect(shim.takeOutput().cmds).toEqual([{ fn: 'setJoint', args: [16, 0] }])
  })

  it('routes robot commands and queries', () => {
    const shim = new ArduinoShim(hw(), API)
    const host = createCppHost(shim)
    shim.beginTick(0, { imu: [1, 2, 3] })
    expect(host.callNative('readImu', [2], ['int'], null)).toBe(3)
    expect(host.callNative('setJoint', [4, 12.5], ['int', 'float'], null)).toBeUndefined()
    expect(shim.takeOutput().cmds).toEqual([{ fn: 'setJoint', args: [4, 12.5] }])
  })

  it('serves pins, Wire and WiFi stubs', () => {
    const shim = new ArduinoShim(hw(), API)
    const host = createCppHost(shim)
    host.callNative('pinMode', [2, 1], ['int', 'int'], null)
    host.callNative('digitalWrite', [2, 1], ['int', 'int'], null)
    expect(shim.led).toBe(1)
    expect(host.callNative('digitalRead', [2], ['int'], null)).toBe(1)
    expect(host.callNative('Wire.endTransmission', [], [], null)).toBe(2)
    expect(host.callNative('WiFi.status', [], [], null)).toBe(3)
    expect(host.callNative('WiFi.localIP', [], [], null)).toBe('0.0.0.0')
  })

  it('throws for natives and classes the sandbox does not provide', () => {
    const host = createCppHost(new ArduinoShim(hw(), API))
    expect(() => host.callNative('analogReference', [], [], null)).toThrow(/not available/)
    expect(() => host.constructNative('LiquidCrystal', [])).toThrow(/not available/)
  })
})

describe('board constants and includes', () => {
  it('defines analog pins and the LED per board', () => {
    expect(boardConstants('esp32').A0).toBe(36)
    expect(boardConstants('pico').A0).toBe(26)
    expect(boardConstants('pico').LED_BUILTIN).toBe(25)
    expect(boardConstants('stm32').PC13).toBe(45)
  })

  it('finds #include lines with positions', () => {
    const src = '// x\n#include <Servo.h>\n  #include "WiFi.h"\n'
    expect(scanIncludes(src)).toEqual([
      { header: 'Servo.h', line: 2, col: 1 },
      { header: 'WiFi.h', line: 3, col: 3 },
    ])
  })
})
