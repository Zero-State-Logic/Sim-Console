import { describe, expect, it } from 'vitest'
import type { ControlDef, HardwareSpec } from '../../core/types'
import { bandwidthNote, canApplyControl, formatBytesPerSec, formatRate, switchPlan } from './link'

function walker(joints = 18): HardwareSpec {
  return {
    robot: 'walker',
    joints,
    jointNames: Array.from({ length: joints }, (_, i) => `J${i}`),
    jointLimits: Array.from({ length: joints }, () => [-85, 85] as [number, number]),
    homePose: new Array<number>(joints).fill(0),
    legs: joints / 3,
    defaultLevel: { wired: 'joint', wireless: 'high' },
  }
}

describe('bandwidthNote', () => {
  it('estimates the worst-case command size before streaming and stays quiet when it fits', () => {
    // Act
    const n = bandwidthNote({ spec: walker(), level: 'joint', transport: 'serial', baud: 921600, commandHz: 50, measuredCmdBytes: 0, rxBytesPerSec: 0 })
    // Assert
    expect(n).not.toBeNull()
    expect(n?.measured).toBe(false)
    expect(n?.text.startsWith('≤ ')).toBe(true)
    expect(n?.text).toMatch(/× 50 Hz/)
    expect(n?.text).toMatch(/921600 baud/)
    expect(n?.warn).toBe(false)
    expect(n?.advice).toBeNull()
  })

  it('warns over 80 % of a slow link and suggests a lower rate, a faster baud and HIGH level', () => {
    // Act
    const n = bandwidthNote({ spec: walker(24), level: 'joint', transport: 'serial', baud: 115200, commandHz: 100, measuredCmdBytes: 0, rxBytesPerSec: 0 })
    // Assert
    expect(n?.warn).toBe(true)
    expect(n?.utilPct).toBeGreaterThan(80)
    expect(n?.advice).toMatch(/Over 80 % of the link: lower the command rate to ≤ \d+ Hz, raise the baud rate, use HIGH level\./)
  })

  it('uses the measured command size once streaming, and flags heavy telemetry on its own', () => {
    // Act
    const n = bandwidthNote({ spec: walker(), level: 'high', transport: 'ble', baud: 0, commandHz: 10, measuredCmdBytes: 40.4, rxBytesPerSec: 1900 })
    // Assert
    expect(n?.measured).toBe(true)
    expect(n?.bytesPerCmd).toBe(40)
    expect(n?.text).toMatch(/BLE/)
    expect(n?.warn).toBe(true)
    expect(n?.advice).toMatch(/Telemetry uses 95 % of the link/)
  })

  it('returns null without a spec', () => {
    expect(bandwidthNote({ spec: null, level: 'joint', transport: 'ws', baud: 0, commandHz: 50, measuredCmdBytes: 0, rxBytesPerSec: 0 })).toBeNull()
  })
})

describe('switchPlan', () => {
  it('switches robot kind and reshapes the leg or drone count to what the board announced', () => {
    expect(switchPlan({ robot: 'walker', joints: 12, legs: 4 })).toEqual({ kind: 'walker', control: { key: 'legs', value: '4' }, label: 'SWITCH TO WALKER · 4 LEGS' })
    expect(switchPlan({ robot: 'swarm', joints: 5, drones: 5 })).toEqual({ kind: 'swarm', control: { key: 'drones', value: '5' }, label: 'SWITCH TO SWARM · 5 DRONES' })
    expect(switchPlan({ robot: 'sweeper', joints: 4, wheels: 4 })).toEqual({ kind: 'sweeper', control: null, label: 'SWITCH TO SWEEPER' })
  })

  it('applies the reshape only when the module offers that option', () => {
    // Arrange
    const schema: ControlDef[] = [
      { type: 'select', key: 'legs', label: 'LEGS', group: 'G', value: '6', options: [{ value: '4', label: '4' }, { value: '6', label: '6' }] },
      { type: 'slider', key: 'speed', label: 'SPEED', group: 'G', min: 0, max: 1, step: 0.1, value: 0 },
    ]
    // Act / Assert
    expect(canApplyControl(schema, { key: 'legs', value: '4' })).toBe(true)
    expect(canApplyControl(schema, { key: 'legs', value: '5' })).toBe(false)
    expect(canApplyControl(schema, { key: 'speed', value: '1' })).toBe(false)
    expect(canApplyControl(schema, { key: 'drones', value: '3' })).toBe(false)
  })
})

describe('formatters', () => {
  it('formats byte and line rates compactly', () => {
    expect(formatBytesPerSec(512.4)).toBe('512 B/s')
    expect(formatBytesPerSec(4520)).toBe('4.5 kB/s')
    expect(formatBytesPerSec(92160)).toBe('92 kB/s')
    expect(formatRate(49.96)).toBe('50.0')
    expect(formatRate(123.4)).toBe('123')
  })
})
