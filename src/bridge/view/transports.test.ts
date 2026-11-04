import { describe, expect, it } from 'vitest'
import type { BrowserEnv } from '../link/env'
import { BAUD_RATES, supportNotices, transportAfterBoardChange, transportLabel, transportOptions, visibleTransports } from './transports'

const CHROME: BrowserEnv = { hasSerial: true, hasBluetooth: true, hasWebSocket: true, isSecureContext: true, userAgent: 'Chrome/130' }
const FIREFOX: BrowserEnv = { hasSerial: false, hasBluetooth: false, hasWebSocket: true, isSecureContext: true, userAgent: 'Firefox/130' }

describe('transportOptions', () => {
  it('lists every transport in picker order and always offers the virtual device', () => {
    // Act
    const opts = transportOptions('pico', CHROME)
    // Assert
    expect(opts.map((o) => o.id)).toEqual(['serial', 'ble', 'ws', 'loopback'])
    expect(opts.find((o) => o.id === 'loopback')).toMatchObject({ onBoard: true, supported: true, label: 'VIRTUAL DEVICE' })
  })

  it("flags links the board's firmware does not have, with a reason", () => {
    // Act
    const ble = transportOptions('stm32', CHROME).find((o) => o.id === 'ble')
    // Assert
    expect(ble?.onBoard).toBe(false)
    expect(ble?.reason).toMatch(/STM32.*no bluetooth link/i)
  })

  it('filters the picker to BOARDS[board].transports plus the virtual device', () => {
    expect(visibleTransports(transportOptions('esp32', CHROME)).map((o) => o.id)).toEqual(['serial', 'ble', 'ws', 'loopback'])
    expect(visibleTransports(transportOptions('pico', CHROME)).map((o) => o.id)).toEqual(['serial', 'loopback'])
    expect(visibleTransports(transportOptions('pizero2w', CHROME)).map((o) => o.id)).toEqual(['serial', 'ws', 'loopback'])
  })

  it('collects one notice per missing browser API for the board', () => {
    // Act
    const notices = supportNotices(transportOptions('esp32', FIREFOX))
    // Assert
    expect(notices).toHaveLength(2)
    expect(notices[0]).toMatch(/Web Serial is not available in Firefox/)
    expect(notices[1]).toMatch(/Web Bluetooth is not available in Firefox/)
    expect(supportNotices(transportOptions('esp32', CHROME))).toEqual([])
  })
})

describe('transportAfterBoardChange', () => {
  it('keeps the virtual device and any link the new board has, else takes its first link', () => {
    expect(transportAfterBoardChange('loopback', 'stm32')).toBe('loopback')
    expect(transportAfterBoardChange('ws', 'picow')).toBe('ws')
    expect(transportAfterBoardChange('ble', 'pico')).toBe('serial')
  })
})

describe('constants', () => {
  it('offers the spec baud rates and readable labels', () => {
    expect(BAUD_RATES).toEqual([115200, 230400, 460800, 921600, 1000000, 2000000])
    expect(transportLabel('serial')).toBe('USB SERIAL')
    expect(transportLabel('ws')).toBe('WIFI')
  })
})
