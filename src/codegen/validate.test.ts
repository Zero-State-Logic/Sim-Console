import { describe, expect, it } from 'vitest'
import { generateFirmware } from './index'
import { hwFor, request, swarmSpec, sweeperSpec, walkerSpec } from './testing/fixtures'
import { buildContext } from './validate'
import { commandBytes, linkWarnings, SERIAL_BUDGET, telemetryBytes } from './warnings'

describe('invalid combinations come back as errors', () => {
  it('needs no firmware for the Virtual Device', () => {
    const r = generateFirmware(request(walkerSpec(6), hwFor('esp32', 'loopback', 'pca9685', 18), 'joint'))
    expect(r.errors[0]).toMatch(/Virtual Device/)
  })

  it('refuses a transport the board does not have', () => {
    const r = generateFirmware(request(walkerSpec(4), hwFor('pico', 'ws', 'gpio', 12), 'high'))
    expect(r.errors[0]).toMatch(/does not support the 'ws' transport/)
  })

  it('says honestly that Pico W BLE is not generated', () => {
    const r = generateFirmware(request(walkerSpec(4), hwFor('picow', 'ble', 'gpio', 12), 'high'))
    expect(r.errors[0]).toMatch(/Pico W BLE is not generated/)
    expect(r.errors[0]).toMatch(/USB serial or WiFi/)
  })

  it('puts the swarm relay on an ESP32 only', () => {
    const r = generateFirmware(request(swarmSpec(4), hwFor('picow', 'ws', 'gpio', 4), 'high'))
    expect(r.errors[0]).toMatch(/ESP-NOW/)
  })

  it('requires a PCA9685 on the Pi Zero 2 W', () => {
    const r = generateFirmware(request(walkerSpec(6), hwFor('pizero2w', 'ws', 'gpio', 18), 'high'))
    expect(r.errors[0]).toMatch(/PCA9685/)
  })

  it('suggests a PCA9685 when there are more servos than GPIO PWM outputs', () => {
    const r = generateFirmware(request(walkerSpec(6), hwFor('stm32', 'serial', 'gpio', 18, { servoPins: Array.from({ length: 18 }, (_, i) => i) }), 'joint'))
    expect(r.errors[0]).toMatch(/at most 12 outputs.*PCA9685/)
  })

  it('rejects a walker whose joints are not 3 per leg', () => {
    const spec = { ...walkerSpec(6), joints: 17 }
    expect(buildContext(request(spec, hwFor('esp32', 'serial', 'pca9685', 17), 'joint')).errors.join(' ')).toMatch(/3 joints per leg/)
  })

  it('cannot build on-board IK without geometry, but the joint level still works', () => {
    const spec = { ...walkerSpec(6), geometry: undefined }
    const hw = hwFor('esp32', 'serial', 'pca9685', 18)
    expect(generateFirmware(request(spec, hw, 'high')).errors[0]).toMatch(/joint level/)
    expect(generateFirmware(request(spec, hw, 'joint')).errors).toEqual([])
  })

  it('rejects bad numbers in the hardware profile', () => {
    const hw = hwFor('esp32', 'serial', 'pca9685', 18, { baud: 0, servoMinUs: 2600, servoMaxUs: 500, watchdogMs: 10, commandHz: 0 })
    const errors = generateFirmware(request(walkerSpec(6), hw, 'joint')).errors.join(' | ')
    expect(errors).toMatch(/baud 0/)
    expect(errors).toMatch(/pulse range/)
    expect(errors).toMatch(/watchdog 10 ms/)
    expect(errors).toMatch(/command rate 0/)
  })

  it('needs a WiFi SSID and a BLE name', () => {
    expect(generateFirmware(request(walkerSpec(6), hwFor('esp32', 'ws', 'pca9685', 18, { wifiSsid: '' }), 'high')).errors[0]).toMatch(/SSID is empty/)
    expect(generateFirmware(request(walkerSpec(6), hwFor('esp32', 'ble', 'pca9685', 18, { bleName: '' }), 'high')).errors[0]).toMatch(/BLE name is empty/)
  })

  it('rejects too many drones for one ESP-NOW packet', () => {
    expect(generateFirmware(request(swarmSpec(15), hwFor('esp32', 'serial', 'gpio', 15), 'high')).errors[0]).toMatch(/ESP-NOW packet/)
    expect(generateFirmware(request(swarmSpec(14), hwFor('esp32', 'serial', 'gpio', 14), 'high')).errors).toEqual([])
  })
})

describe('warnings', () => {
  it('flags 18 joints at 50 Hz over 115200 baud', () => {
    const r = generateFirmware(request(walkerSpec(6), hwFor('esp32', 'serial', 'pca9685', 18, { baud: 115200 }), 'joint'))
    expect(r.errors).toEqual([])
    expect(r.warnings.some((w) => /18 joints × 50 Hz/.test(w) && /921600/.test(w))).toBe(true)
  })

  it('is quiet at 921600 baud', () => {
    const r = generateFirmware(request(walkerSpec(6), hwFor('esp32', 'serial', 'pca9685', 18), 'joint'))
    expect(r.warnings).toEqual([])
  })

  it('skips the baud budget on native USB CDC', () => {
    const v = buildContext(request(walkerSpec(4), hwFor('pico', 'serial', 'gpio', 12, { baud: 9600 }), 'joint'))
    expect(v.ctx?.usbCdc).toBe(true)
    expect(v.warnings.some((w) => /baud \(/.test(w))).toBe(false)
  })

  it('warns that streaming every joint over BLE is too much', () => {
    const r = generateFirmware(request(walkerSpec(6), hwFor('esp32', 'ble', 'pca9685', 18), 'joint'))
    expect(r.warnings.some((w) => /BLE carries/.test(w))).toBe(true)
  })

  it('explains mixed content for WiFi, the STM32 serial caveat and the flight-controller limit', () => {
    const ws = generateFirmware(request(walkerSpec(6), hwFor('esp32', 'ws', 'pca9685', 18), 'high')).warnings
    const stm = generateFirmware(request(sweeperSpec(), hwFor('stm32', 'serial', 'gpio', 4), 'joint')).warnings
    const swarm = generateFirmware(request(swarmSpec(4), hwFor('esp32', 'serial', 'gpio', 4), 'high')).warnings
    expect(ws.some((w) => /mixed content/.test(w))).toBe(true)
    expect(stm.some((w) => /ST-Link virtual COM/.test(w))).toBe(true)
    expect(swarm.some((w) => /flight controller/.test(w))).toBe(true)
  })

  it('warns about a strapping pin without refusing the build', () => {
    const pins = [12, 13, 14, 27, 26, 25, 33, 32, 4, 16, 17, 18]
    const r = generateFirmware(request(walkerSpec(4), hwFor('esp32', 'serial', 'gpio', 12, { servoPins: pins }), 'joint'))
    expect(r.errors).toEqual([])
    expect(r.warnings.some((w) => /strapping/.test(w))).toBe(true)
  })

  it('estimates line sizes from the robot and level', () => {
    expect(commandBytes({ robot: 'walker', level: 'joint', joints: 18 })).toBeGreaterThan(commandBytes({ robot: 'walker', level: 'high', joints: 18 }))
    expect(telemetryBytes({ robot: 'walker', joints: 24, legs: 8 })).toBeGreaterThan(telemetryBytes({ robot: 'walker', joints: 12, legs: 4 }))
    expect(SERIAL_BUDGET).toBeLessThan(1)
  })

  it('returns no link warnings for a comfortable serial link', () => {
    const v = buildContext(request(sweeperSpec(), hwFor('esp32', 'serial', 'gpio', 4), 'joint'))
    expect(v.ctx && linkWarnings(v.ctx)).toEqual([])
  })
})
