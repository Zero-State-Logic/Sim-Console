import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig, jointToServoDeg, servoDegToUs, usToPcaTicks } from '../../core/hardware'
import type { SandboxFnDef } from '../../core/types'
import { MAX_CMDS_PER_TICK, MAX_SERIAL_PER_TICK, type HwMap } from '../protocol'
import { ArduinoShim } from './arduino'
import { analogLevel, hash32 } from './pins'
import { hwConfig } from './servoMap'
import { SerialPort } from './serialPort'

const API: SandboxFnDef[] = [
  { name: 'setJoint', kind: 'command', params: ['joint', 'deg'], doc: '' },
  { name: 'walk', kind: 'command', params: ['vx', 'vy', 'wz'], doc: '' },
  { name: 'readLoad', kind: 'query', params: ['leg'], sensor: 'load', doc: '' },
  { name: 'legCount', kind: 'query', params: [], sensor: 'legs', doc: '' },
]

function hwFor(joints: number, patch: Partial<HwMap> = {}): HwMap {
  const c = defaultHardwareConfig('esp32', joints)
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
    ...patch,
  }
}

describe('robot API in the shim', () => {
  it('answers queries from the sensor snapshot, indexing arrays by the first argument', () => {
    // Arrange
    const shim = new ArduinoShim(hwFor(12), API)
    shim.beginTick(0, { load: [1.5, 2.5, 3.5], legs: 6 })
    // Act / Assert
    expect(shim.callRobot('readLoad', [1])).toBe(2.5)
    expect(shim.callRobot('readLoad', [2.9])).toBe(3.5)
    expect(shim.callRobot('readLoad', [7])).toBe(0)
    expect(shim.callRobot('readLoad', [-1])).toBe(0)
    expect(shim.callRobot('legCount', [])).toBe(6)
  })

  it('collects commands in call order and hands them over once', () => {
    const shim = new ArduinoShim(hwFor(12), API)
    shim.callRobot('walk', [0.1, 0, 20])
    shim.callRobot('setJoint', [3, 15])
    const first = shim.takeOutput()
    expect(first.cmds).toEqual([
      { fn: 'walk', args: [0.1, 0, 20] },
      { fn: 'setJoint', args: [3, 15] },
    ])
    expect(shim.takeOutput().cmds).toEqual([])
  })

  it('drops a command with a non-finite argument and warns once', () => {
    const shim = new ArduinoShim(hwFor(12), API)
    shim.callRobot('walk', [Number.NaN, 0, 0])
    shim.callRobot('walk', [0.1, 0])
    const out = shim.takeOutput()
    expect(out.cmds).toEqual([])
    expect(out.log).toHaveLength(1)
    expect(out.log[0].level).toBe('warn')
  })

  it('collapses repeated setJoint on one joint while only setJoints follow', () => {
    const shim = new ArduinoShim(hwFor(12), API)
    shim.callRobot('setJoint', [1, 10])
    shim.callRobot('setJoint', [2, 5])
    shim.callRobot('setJoint', [1, 20])
    shim.callRobot('walk', [0, 0, 0])
    shim.callRobot('setJoint', [1, 30])
    expect(shim.takeOutput().cmds).toEqual([
      { fn: 'setJoint', args: [1, 20] },
      { fn: 'setJoint', args: [2, 5] },
      { fn: 'walk', args: [0, 0, 0] },
      { fn: 'setJoint', args: [1, 30] },
    ])
  })

  it('caps the commands of one tick', () => {
    const shim = new ArduinoShim(hwFor(12), API)
    for (let i = 0; i < MAX_CMDS_PER_TICK + 50; i++) shim.callRobot('walk', [i, 0, 0])
    const out = shim.takeOutput()
    expect(out.cmds).toHaveLength(MAX_CMDS_PER_TICK)
    expect(out.log.some((l) => l.text.includes('dropped'))).toBe(true)
  })
})

describe('Servo through the shim', () => {
  it('maps attach(pin) + write(deg) to setJoint on the profile joint', () => {
    // Arrange: 12-joint ESP32 profile on GPIO, joint 1 is GPIO 14
    const shim = new ArduinoShim(hwFor(12), API)
    const s = shim.servos.createServo()
    // Act
    shim.servos.attach(s, 14)
    shim.servos.write(s, 120)
    // Assert: servo 120 deg = joint +30 deg
    expect(shim.takeOutput().cmds).toEqual([{ fn: 'setJoint', args: [1, 30] }])
    expect(shim.servos.read(s)).toBe(120)
    expect(shim.servos.attached(s)).toBe(true)
  })

  it('applies invert, offset and scale from the profile', () => {
    const hw = hwFor(12, {
      jointInvert: [true, false, ...new Array(10).fill(false)],
      jointOffsetDeg: [0, 10, ...new Array(10).fill(0)],
      jointScale: [1, 2, ...new Array(10).fill(1)],
    })
    const shim = new ArduinoShim(hw, API)
    const a = shim.servos.createServo()
    const b = shim.servos.createServo()
    shim.servos.attach(a, 13)
    shim.servos.attach(b, 14)
    shim.servos.write(a, 100)
    shim.servos.write(b, 120)
    // joint 0 inverted: -(100 - 90) = -10; joint 1: (120 - 90 - 10) / 2 = 10
    expect(shim.takeOutput().cmds).toEqual([
      { fn: 'setJoint', args: [0, -10] },
      { fn: 'setJoint', args: [1, 10] },
    ])
  })

  it('uses the attach() pulse range for write() and clamps writeMicroseconds', () => {
    const shim = new ArduinoShim(hwFor(12), API)
    const s = shim.servos.createServo()
    shim.servos.attach(s, 13, 1000, 2000)
    shim.servos.write(s, 0)
    shim.servos.writeMicroseconds(s, 9999)
    // 1000 us on a 500..2500 servo = 45 deg servo = -45 joint; 2000 us = 135 servo = +45 joint
    expect(shim.takeOutput().cmds).toEqual([{ fn: 'setJoint', args: [0, 45] }])
    expect(shim.servos.readMicroseconds(s)).toBe(2000)
  })

  it('warns once for a pin outside the servo map and emits nothing', () => {
    const shim = new ArduinoShim(hwFor(12), API)
    const s = shim.servos.createServo()
    shim.servos.attach(s, 2)
    shim.servos.write(s, 90)
    shim.servos.write(s, 100)
    const out = shim.takeOutput()
    expect(out.cmds).toEqual([])
    expect(out.log).toHaveLength(1)
  })

  it('ignores servo output on a robot without setJoint', () => {
    const shim = new ArduinoShim(hwFor(12), API.filter((f) => f.name !== 'setJoint'))
    const s = shim.servos.createServo()
    shim.servos.attach(s, 13)
    shim.servos.write(s, 90)
    const out = shim.takeOutput()
    expect(out.cmds).toEqual([])
    expect(out.log[0].text).toContain('setJoint')
  })

  it('stops driving after detach()', () => {
    const shim = new ArduinoShim(hwFor(12), API)
    const s = shim.servos.createServo()
    shim.servos.attach(s, 13)
    shim.servos.detach(s)
    shim.servos.write(s, 150)
    expect(shim.takeOutput().cmds).toEqual([])
  })
})

describe('PCA9685 through the shim', () => {
  it('turns setPWM ticks into a joint angle via the channel map', () => {
    // Arrange: 18 joints on ESP32 default to a PCA9685, channel n = joint n
    const shim = new ArduinoShim(hwFor(18), API)
    const pwm = shim.servos.createPca()
    shim.servos.setPWMFreq(pwm, 50)
    // Act: 1500 us at 50 Hz is 307.2 ticks; use writeMicroseconds for an exact pulse
    shim.servos.pcaWriteMicroseconds(pwm, 4, 1700)
    shim.servos.setPWM(pwm, 5, 0, 307)
    // Assert
    const cmds = shim.takeOutput().cmds
    expect(cmds[0]).toEqual({ fn: 'setJoint', args: [4, 18] })
    expect(cmds[1].fn).toBe('setJoint')
    expect(cmds[1].args[0]).toBe(5)
    expect(cmds[1].args[1]).toBeCloseTo(-0.09, 1)
  })

  it('applies invert and offset to PCA9685 channels, and undoes the firmware tick mapping', () => {
    // Arrange: joint 2 inverted with a -5 deg offset (18-joint ESP32 profile = PCA9685)
    const hw = hwFor(18, {
      jointInvert: [false, false, true, ...new Array(15).fill(false)],
      jointOffsetDeg: [0, 0, -5, ...new Array(15).fill(0)],
    })
    const shim = new ArduinoShim(hw, API)
    const pwm = shim.servos.createPca()
    const cfg = hwConfig(hw)
    // the ticks the generated firmware sends for joint 2 at +20 deg
    const firmwareTicks = usToPcaTicks(servoDegToUs(cfg, jointToServoDeg(cfg, 2, 20)))
    // Act: 369 ticks at 50 Hz = 1801.76 us = 117.158 servo deg -> -(117.158 - 90 + 5) = -32.16 joint
    shim.servos.setPWM(pwm, 2, 0, 369)
    const byHand = shim.takeOutput().cmds
    shim.servos.setPWM(pwm, 2, 0, firmwareTicks)
    const back = shim.takeOutput().cmds[0].args[1]
    // Assert
    expect(byHand).toEqual([{ fn: 'setJoint', args: [2, -32.16] }])
    // one tick is 4.9 us = 0.44 deg of servo travel
    expect(Math.abs(back - 20)).toBeLessThan(0.45)
  })

  it('addresses the second board (0x41) as channels 16-31', () => {
    const shim = new ArduinoShim(hwFor(18), API)
    const hi = shim.servos.createPca(0x41)
    shim.servos.pcaWriteMicroseconds(hi, 1, 1500)
    expect(shim.takeOutput().cmds).toEqual([{ fn: 'setJoint', args: [17, 0] }])
  })

  it('answers I2C probes only at a PCA9685 address', () => {
    const shim = new ArduinoShim(hwFor(18), API)
    shim.servos.createPca(0x40)
    shim.wireBeginTransmission(0x40)
    expect(shim.wireEndTransmission()).toBe(0)
    shim.wireBeginTransmission(0x68)
    expect(shim.wireEndTransmission()).toBe(2)
  })
})

describe('virtual pins', () => {
  it('reads back OUTPUT levels, pull-ups HIGH and floating inputs LOW', () => {
    const shim = new ArduinoShim(hwFor(12), API)
    shim.pins.pinMode(5, 1)
    shim.pins.digitalWrite(5, 1)
    shim.pins.pinMode(6, 2)
    shim.pins.pinMode(7, 0)
    expect(shim.pins.digitalRead(5)).toBe(1)
    expect(shim.pins.digitalRead(6)).toBe(1)
    expect(shim.pins.digitalRead(7)).toBe(0)
  })

  it('reports LED_BUILTIN brightness from digitalWrite and analogWrite', () => {
    const shim = new ArduinoShim(hwFor(12), API)
    expect(shim.ledPin).toBe(2)
    shim.pins.digitalWrite(2, 1)
    expect(shim.led).toBe(1)
    shim.pins.analogWrite(2, 51)
    expect(shim.led).toBeCloseTo(0.2, 6)
  })

  it('returns deterministic ADC values in range for the board resolution', () => {
    const shim = new ArduinoShim(hwFor(12), API)
    const a = shim.pins.analogRead(36, 1234)
    const b = shim.pins.analogRead(36, 1234)
    expect(a).toBe(b)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThanOrEqual(4095)
    shim.pins.analogReadResolution(10)
    expect(shim.pins.analogRead(36, 1234)).toBeLessThanOrEqual(1023)
  })

  it('makes the ADC level noisy but bounded', () => {
    const values = Array.from({ length: 200 }, (_, i) => analogLevel(3, i * 7))
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...values)).toBeLessThanOrEqual(1)
    expect(new Set(values).size).toBeGreaterThan(100)
    expect(hash32(1, 2)).toBe(hash32(1, 2))
    expect(hash32(1, 2)).not.toBe(hash32(2, 1))
  })
})

describe('SerialPort', () => {
  it('buffers input for read / peek / parseInt / readStringUntil', () => {
    const s = new SerialPort()
    s.feed('ab 12,x 3.5\n')
    expect(s.available()).toBe(12)
    expect(s.peek()).toBe(97)
    expect(s.read()).toBe(97)
    expect(s.parseInt()).toBe(12)
    expect(s.readStringUntil(',')).toBe('')
    expect(s.parseFloat()).toBe(3.5)
    expect(s.readString()).toBe('\n')
    expect(s.read()).toBe(-1)
  })

  it('cuts output above the per-tick cap and recovers next tick', () => {
    const s = new SerialPort()
    s.write('x'.repeat(MAX_SERIAL_PER_TICK - 2))
    s.write('abcdef')
    s.write('lost')
    const chunks = s.take()
    expect(chunks.join('').startsWith('x')).toBe(true)
    expect(chunks.join('')).toContain('serial output cut')
    expect(chunks.join('')).not.toContain('lost')
    s.write('ok')
    expect(s.take()).toEqual(['ok'])
  })
})

describe('misc shim behaviour', () => {
  it('gives reproducible random numbers in [min, max) after randomSeed', () => {
    const a = new ArduinoShim(hwFor(12), API)
    const b = new ArduinoShim(hwFor(12), API)
    a.randomSeed(42)
    b.randomSeed(42)
    const xs = Array.from({ length: 20 }, () => a.random(10, 20))
    expect(xs).toEqual(Array.from({ length: 20 }, () => b.random(10, 20)))
    expect(xs.every((x) => x >= 10 && x < 20)).toBe(true)
    expect(a.random(5)).toBeLessThan(5)
  })

  it('notes the kiyobridge and WiFi stubs once each', () => {
    const shim = new ArduinoShim(hwFor(12), API)
    shim.bridgeCall()
    shim.bridgeCall()
    shim.wifiCall()
    const log = shim.takeOutput().log
    expect(log.map((l) => l.level)).toEqual(['info', 'warn'])
  })

  it('clears state and one-time warnings on reset', () => {
    const shim = new ArduinoShim(hwFor(12), API)
    shim.pins.digitalWrite(2, 1)
    shim.wifiCall()
    shim.reset()
    expect(shim.led).toBe(0)
    shim.wifiCall()
    expect(shim.takeOutput().log).toHaveLength(1)
  })
})
