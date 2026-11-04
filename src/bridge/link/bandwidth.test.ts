import { describe, expect, it } from 'vitest'
import { BLE_BYTES_PER_SEC, estimateBandwidth, estimateCmdBytes, linkCapacity, sampleCommand } from './bandwidth'
import type { HardwareSpec } from '../../core/types'

function walkerSpec(joints = 18): HardwareSpec {
  return {
    robot: 'walker',
    joints,
    jointNames: Array.from({ length: joints }, (_, i) => `J${i}`),
    jointLimits: Array.from({ length: joints }, () => [-90, 90] as [number, number]),
    homePose: new Array(joints).fill(0),
    legs: joints / 3,
    defaultLevel: { wired: 'joint', wireless: 'high' },
  }
}

describe('linkCapacity', () => {
  it('uses baud/10 for UART-like links and fixed budgets for BLE and WS', () => {
    expect(linkCapacity('serial', 921600)).toBe(92160)
    expect(linkCapacity('loopback', 115200)).toBe(11520)
    expect(linkCapacity('ble', 921600)).toBe(BLE_BYTES_PER_SEC)
    expect(linkCapacity('ws', 0)).toBeGreaterThan(10000)
  })
})

describe('estimateCmdBytes', () => {
  it('sizes a worst-case 18-joint command at about 7 bytes per joint plus framing', () => {
    const bytes = estimateCmdBytes(walkerSpec(), 'joint')
    // "-90.11," is 7 chars per joint (no trailing comma), {"t":"cmd","seq":99999,"q":[ + ]} is 30, plus a newline
    expect(bytes).toBe(18 * 7 - 1 + 30 + 1)
  })

  it('sizes high-level commands independent of joint count', () => {
    expect(estimateCmdBytes(walkerSpec(18), 'high')).toBe(estimateCmdBytes(walkerSpec(12), 'high'))
  })

  it('builds wheel and drone samples for the other robots', () => {
    const sweeper: HardwareSpec = { ...walkerSpec(4), robot: 'sweeper', wheels: 4 }
    const swarm: HardwareSpec = { ...walkerSpec(4), robot: 'swarm', drones: 4 }
    expect(sampleCommand(sweeper, 'joint').w).toHaveLength(4)
    expect(sampleCommand(swarm, 'joint').sp).toHaveLength(4)
  })
})

describe('estimateBandwidth', () => {
  it('fits 18 joints at 50 Hz on 921600 baud with lots of headroom', () => {
    const bytes = estimateCmdBytes(walkerSpec(), 'joint')
    const est = estimateBandwidth({ bytesPerCmd: bytes, commandHz: 50, transport: 'serial', baud: 921600 })
    expect(est.txUtil).toBeLessThan(0.1)
    expect(est.warn).toBe(false)
  })

  it('warns when 18 joints at 50 Hz are pushed through 115200 baud', () => {
    const est = estimateBandwidth({ bytesPerCmd: 156, commandHz: 50, transport: 'serial', baud: 115200 })
    expect(est.txBytesPerSec).toBe(7800)
    expect(est.txUtil).toBeCloseTo(7800 / 11520, 6)
    expect(est.warn).toBe(false)
    const hot = estimateBandwidth({ bytesPerCmd: 200, commandHz: 50, transport: 'serial', baud: 115200 })
    expect(hot.warn).toBe(true)
    expect(hot.maxSafeHz).toBe(Math.floor((11520 * 0.8) / 200))
  })

  it('warns when joint streaming would exceed BLE throughput', () => {
    const est = estimateBandwidth({ bytesPerCmd: 156, commandHz: 50, transport: 'ble', baud: 0 })
    expect(est.warn).toBe(true)
  })

  it('also warns when inbound telemetry saturates the link', () => {
    const est = estimateBandwidth({ bytesPerCmd: 10, commandHz: 1, transport: 'serial', baud: 115200, rxBytesPerSec: 10000 })
    expect(est.warn).toBe(true)
  })
})
