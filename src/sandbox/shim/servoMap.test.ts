import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig, jointToServoDeg, servoDegToUs } from '../../core/hardware'
import type { HwMap } from '../protocol'
import {
  gpioJoint,
  hwConfig,
  pcaGlobalChannel,
  pcaJoint,
  pcaTicksToUs,
  pinLabel,
  servoWriteToUs,
  usToJointDeg,
  usToServoDeg,
  usToServoWrite,
} from './servoMap'

function map(patch: Partial<HwMap> = {}): HwMap {
  const c = defaultHardwareConfig('esp32', 12)
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

describe('gpioJoint', () => {
  it('finds the joint whose profile pin matches', () => {
    // Arrange: ESP32 with 12 joints drives servos from GPIO 13, 14, 27, ...
    const hw = map()
    // Act / Assert
    expect(hw.servoDriver).toBe('gpio')
    expect(gpioJoint(hw, 13)).toEqual({ joint: 0, fallback: false })
    expect(gpioJoint(hw, 27)).toEqual({ joint: 2, fallback: false })
  })

  it('returns null for a pin that drives nothing', () => {
    expect(gpioJoint(map(), 2)).toBeNull()
    expect(gpioJoint(map(), -1)).toBeNull()
  })

  it('falls back to the board default GPIO order on a PCA9685 profile', () => {
    const hw = map({ servoDriver: 'pca9685', servoPins: Array.from({ length: 12 }, (_, i) => i) })
    expect(gpioJoint(hw, 14)).toEqual({ joint: 1, fallback: true })
  })
})

describe('pcaJoint', () => {
  it('maps channels at 0x40 and 0x41 through the channel table', () => {
    const pins = Array.from({ length: 18 }, (_, i) => i)
    const hw = map({ servoDriver: 'pca9685', servoPins: pins, jointInvert: new Array(18).fill(false), jointOffsetDeg: new Array(18).fill(0), jointScale: new Array(18).fill(1) })
    expect(pcaGlobalChannel(0x41, 1)).toBe(17)
    expect(pcaJoint(hw, 0x40, 5)).toEqual({ joint: 5, fallback: false })
    expect(pcaJoint(hw, 0x41, 1)).toEqual({ joint: 17, fallback: false })
  })

  it('honours a remapped channel table', () => {
    const hw = map({ servoDriver: 'pca9685', servoPins: [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4] })
    expect(pcaJoint(hw, 0x40, 15)).toEqual({ joint: 0, fallback: false })
  })

  it('rejects channels outside 0..15', () => {
    const hw = map({ servoDriver: 'pca9685' })
    expect(pcaJoint(hw, 0x40, 16)).toBeNull()
  })

  it('falls back to channel n = joint n on a GPIO profile', () => {
    expect(pcaJoint(map(), 0x40, 3)).toEqual({ joint: 3, fallback: true })
  })
})

describe('pulse conversions', () => {
  it('maps the calibrated pulse range onto the servo travel', () => {
    const hw = map()
    expect(usToServoDeg(hw, 500)).toBe(0)
    expect(usToServoDeg(hw, 1500)).toBe(90)
    expect(usToServoDeg(hw, 2500)).toBe(180)
    expect(usToServoDeg(hw, 9999)).toBe(180)
  })

  it('treats Servo.write values from 544 up as microseconds', () => {
    expect(servoWriteToUs(90, 500, 2500)).toBe(1500)
    expect(servoWriteToUs(-10, 500, 2500)).toBe(500)
    expect(servoWriteToUs(1200, 500, 2500)).toBe(1200)
    expect(usToServoWrite(1500, 500, 2500)).toBe(90)
  })

  it('converts PCA9685 tick pairs at 50 Hz to microseconds', () => {
    // 307 ticks of 4096 at 50 Hz is about 1499 us
    expect(pcaTicksToUs(0, 307, 50)).toBeCloseTo(1499.0, 0)
    expect(pcaTicksToUs(100, 407, 50)).toBeCloseTo(1499.0, 0)
    expect(pcaTicksToUs(4000, 211, 50)).toBeCloseTo(1499.0, 0)
  })

  it('ignores full-on, full-off and zero-width pulses', () => {
    expect(pcaTicksToUs(4096, 0, 50)).toBeNull()
    expect(pcaTicksToUs(0, 4096, 50)).toBeNull()
    expect(pcaTicksToUs(10, 10, 50)).toBeNull()
  })
})

describe('usToJointDeg inverts the firmware mapping', () => {
  it('round-trips plain, inverted, offset and scaled joints', () => {
    // Arrange: joint 1 inverted, joint 2 offset +7 deg, joint 3 scale 1.25
    const hw = map({
      jointInvert: [false, true, false, false, false, false, false, false, false, false, false, false],
      jointOffsetDeg: [0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      jointScale: [1, 1, 1, 1.25, 1, 1, 1, 1, 1, 1, 1, 1],
    })
    const cfg = hwConfig(hw)
    for (const joint of [0, 1, 2, 3]) {
      for (const deg of [-40, 0, 25]) {
        // Act: the firmware turns joint degrees into a pulse; the shim turns it back
        const us = servoDegToUs(cfg, jointToServoDeg(cfg, joint, deg))
        // Assert (pulses are whole microseconds, about 0.09 deg each)
        expect(usToJointDeg(cfg, joint, us)).toBeCloseTo(deg, 0)
      }
    }
  })

  it('flips the sign on an inverted joint', () => {
    const hw = map({ jointInvert: [true, ...new Array(11).fill(false)] })
    expect(usToJointDeg(hwConfig(hw), 0, 1700)).toBeCloseTo(-18, 6)
  })
})

describe('pinLabel', () => {
  it('names STM32 pins by port', () => {
    expect(pinLabel(map({ board: 'stm32' }), 'gpio', 22)).toBe('PB6')
    expect(pinLabel(map(), 'gpio', 13)).toBe('pin 13')
    expect(pinLabel(map(), 'pca9685', 3)).toBe('channel 3')
  })
})
