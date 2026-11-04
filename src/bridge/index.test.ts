import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig } from '../core/hardware'
import type { HardwareSpec } from '../core/types'
import { bridge, hardwareBridge, useBridge } from './index'
import { createTransport } from './transports'
import { BleTransport } from './transports/ble'
import { LoopbackTransport } from './transports/loopback'
import { SerialTransport } from './transports/serial'
import { WsTransport } from './transports/ws'

const SPEC: HardwareSpec = {
  robot: 'walker',
  joints: 3,
  jointNames: ['a', 'b', 'c'],
  jointLimits: [[-90, 90], [-90, 90], [-90, 90]],
  homePose: [0, 0, 0],
  defaultLevel: { wired: 'joint', wireless: 'high' },
}

describe('bridge entry point', () => {
  it('exposes the runtime BridgeApi as the same host the UI drives', () => {
    expect(bridge).toBe(hardwareBridge)
    for (const k of ['tick', 'onSourceEnter', 'onSourceExit', 'onRobotChange'] as const) expect(typeof bridge[k]).toBe('function')
  })

  it('starts idle with no timer, and the store mirrors the link status', () => {
    const s = useBridge.getState()
    expect(s.state).toBe('idle')
    expect(s.attached).toBe(false)
    expect(s.calib.recording).toBe(false)
    expect(hardwareBridge.link.attached).toBe(false)
  })
})

describe('createTransport', () => {
  it('builds the transport the hardware profile selects', () => {
    // Arrange
    const cfg = defaultHardwareConfig('esp32', 3)
    const ctx = { config: () => cfg, spec: () => SPEC, miscalibrate: false }
    // Act / Assert
    expect(createTransport('serial', ctx)).toBeInstanceOf(SerialTransport)
    expect(createTransport('ble', ctx)).toBeInstanceOf(BleTransport)
    expect(createTransport('ws', ctx)).toBeInstanceOf(WsTransport)
    const lb = createTransport('loopback', ctx)
    expect(lb).toBeInstanceOf(LoopbackTransport)
    expect(lb.isSupported()).toBe(true)
  })
})
