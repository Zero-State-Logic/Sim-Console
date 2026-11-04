import { describe, expect, it } from 'vitest'
import { hwFor, swarmSpec, sweeperSpec, walkerSpec } from '../testing/fixtures'
import {
  boardChoices,
  buildRequest,
  defaultLevelFor,
  driverChoices,
  effectiveTransport,
  levelChoices,
  parsePin,
  patchForDriver,
  pinLabel,
  pinRowIssues,
  stepChoice,
  sweeperMotorPins,
  transportChoices,
  withEntry,
} from './model'

describe('firmware dialog model', () => {
  it('offers only ESP32 for the swarm relay', () => {
    const choices = boardChoices('swarm')
    expect(choices.filter((c) => !c.disabled).map((c) => c.value)).toEqual(['esp32'])
    expect(boardChoices('walker').every((c) => !c.disabled)).toBe(true)
  })

  it('lists the transports of the board and disables Pico W BLE', () => {
    expect(transportChoices('pico').map((c) => c.value)).toEqual(['serial'])
    const picow = transportChoices('picow')
    expect(picow.find((c) => c.value === 'ble')?.disabled).toBe(true)
  })

  it('falls back to a transport the board has (loopback or BLE on a Pico W)', () => {
    expect(effectiveTransport({ board: 'esp32', transport: 'loopback' })).toBe('serial')
    expect(effectiveTransport({ board: 'picow', transport: 'ble' })).toBe('serial')
    expect(effectiveTransport({ board: 'pizero2w', transport: 'serial' })).toBe('serial')
    expect(effectiveTransport({ board: 'pizero2w', transport: 'loopback' })).toBe('ws')
  })

  it('defaults the level by transport class', () => {
    expect(defaultLevelFor(walkerSpec(6), 'serial')).toBe('joint')
    expect(defaultLevelFor(walkerSpec(6), 'ble')).toBe('high')
    expect(levelChoices('swarm').map((c) => c.value)).toEqual(['high'])
  })

  it('disables GPIO where it cannot work', () => {
    expect(driverChoices('pizero2w', 4)[0].disabled).toBe(true)
    expect(driverChoices('stm32', 18)[0].disabled).toBe(true)
    expect(driverChoices('esp32', 12)[0].disabled).toBe(false)
  })

  it('parses pins the way each board writes them', () => {
    expect(parsePin('stm32', 'gpio', 'pb6')).toBe(22)
    expect(parsePin('stm32', 'gpio', 'PA16')).toBeNull()
    expect(parsePin('esp32', 'gpio', 'GPIO 13')).toBe(13)
    expect(parsePin('pico', 'gpio', 'GP4')).toBe(4)
    expect(parsePin('esp32', 'pca9685', '31')).toBe(31)
    expect(parsePin('esp32', 'pca9685', '32')).toBeNull()
    expect(parsePin('esp32', 'gpio', 'x1')).toBeNull()
    expect(pinLabel('stm32', 'gpio', 22)).toBe('PB6')
    expect(pinLabel('esp32', 'gpio', -1)).toBe('')
  })

  it('marks shared and invalid pins row by row', () => {
    const bad = pinRowIssues('esp32', 'gpio', [13, 13, 6, 14], true)
    expect([...bad].sort()).toEqual([0, 1, 2])
  })

  it('resets the pins when the driver changes', () => {
    const hw = hwFor('esp32', 'serial', 'gpio', 12)
    expect(patchForDriver(hw, 'pca9685', 12).servoPins).toEqual(Array.from({ length: 12 }, (_, i) => i))
  })

  it('shows the sweeper direction lines read-only', () => {
    const m = sweeperMotorPins(hwFor('esp32', 'serial', 'gpio', 4))
    expect(m?.in1).toHaveLength(4)
    expect(m?.stby).toBeGreaterThanOrEqual(0)
  })

  it('builds the request with the effective transport, leaving the stored profile alone', () => {
    const hw = hwFor('esp32', 'loopback', 'pca9685', 18)
    const req = buildRequest(walkerSpec(6), hw, 'WALKER', 'joint')
    expect(req.hw.transport).toBe('serial')
    expect(hw.transport).toBe('loopback')
    expect(buildRequest(sweeperSpec(), hwFor('esp32', 'ws', 'gpio', 4), 'SWEEPER', 'high').robotLabel).toBe('SWEEPER')
    expect(buildRequest(swarmSpec(3), hwFor('esp32', 'ble', 'gpio', 3), 'SWARM', 'high').hw.transport).toBe('ble')
  })

  it('moves radio-group selection with the arrow keys, skipping disabled choices', () => {
    // STM32 with 18 joints: GPIO is disabled, so the arrows stay on PCA9685
    expect(stepChoice(driverChoices('stm32', 18), 'pca9685', 1)).toBe('pca9685')
    const three = [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', disabled: true },
      { value: 'c', label: 'C' },
    ]
    expect(stepChoice(three, 'a', 1)).toBe('c')
    expect(stepChoice(three, 'a', -1)).toBe('c')
    expect(stepChoice(three, 'c', 1)).toBe('a')
    expect(stepChoice([{ value: 'a', label: 'A', disabled: true }], 'a', 1)).toBeNull()
  })

  it('updates one entry without touching the original array', () => {
    const a = [1, 2, 3]
    expect(withEntry(a, 1, 9)).toEqual([1, 9, 3])
    expect(a).toEqual([1, 2, 3])
  })
})
