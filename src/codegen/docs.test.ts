import { describe, expect, it } from 'vitest'
import { formatPin } from '../core/hardware'
import { generateFirmware } from './index'
import { hwFor, request, swarmSpec, sweeperSpec, walkerSpec } from './testing/fixtures'
import type { FirmwareResult } from './types'

function text(r: FirmwareResult, name: string): string {
  return r.files.find((f) => f.path.endsWith(name))?.content ?? ''
}

describe('README_FIRMWARE.md', () => {
  it('has a wiring row per joint with the pin as the firmware writes it', () => {
    const hw = hwFor('stm32', 'serial', 'gpio', 12)
    const r = generateFirmware(request(walkerSpec(4), hw, 'joint'))
    const md = text(r, 'README_FIRMWARE.md')
    const rows = md.split('\n').filter((l) => /^\| \d+ \| L\d/.test(l))
    expect(rows).toHaveLength(12)
    expect(rows[10]).toContain(`| ${formatPin('stm32', 'gpio', hw.servoPins[10])} |`)
  })

  it('names the PCA9685 board and channel for each joint', () => {
    const md = text(generateFirmware(request(walkerSpec(8), hwFor('esp32', 'serial', 'pca9685', 24), 'joint')), 'README_FIRMWARE.md')
    expect(md).toContain('PCA9685 0x40 ch 0')
    expect(md).toContain('PCA9685 0x41 ch 7')
  })

  it('lists the libraries, the steps and the power safety notes', () => {
    const r = generateFirmware(request(walkerSpec(6), hwFor('esp32', 'ble', 'pca9685', 18), 'high'))
    const md = text(r, 'README_FIRMWARE.md')
    for (const lib of ['ArduinoJson', 'Adafruit PWM Servo Driver Library', 'NimBLE-Arduino']) expect(md).toContain(lib)
    expect(md).toMatch(/Join the grounds/)
    expect(md).toMatch(/separate supply/)
    expect(md).toContain(`1. ${r.steps[0]}`)
  })

  it('gives Pi users Pi guidance, not Arduino loop() advice, and only the hooks the daemon has', () => {
    const md = text(generateFirmware(request(sweeperSpec(), hwFor('pizero2w', 'ws', 'pca9685', 4), 'high')), 'README_FIRMWARE.md')
    const where = md.slice(md.indexOf('## Where your code goes'), md.indexOf('## Protocol'))
    expect(where).not.toMatch(/loop\(\)|Bridge\.update/)
    expect(where).toMatch(/systemctl stop kiyobridge/)
    expect(where).toContain('read_wheel_speed(wheel)')
    expect(where).not.toContain('read_load')
  })

  it('documents the sweeper motor driver lines and the swarm flight-controller limit', () => {
    expect(text(generateFirmware(request(sweeperSpec(), hwFor('esp32', 'serial', 'gpio', 4), 'joint')), 'README_FIRMWARE.md')).toMatch(/STBY/)
    expect(text(generateFirmware(request(swarmSpec(3), hwFor('esp32', 'serial', 'gpio', 3), 'high')), 'README_FIRMWARE.md')).toMatch(/Flight stabilisation stays on each drone/)
  })
})

describe('sketch, steps and platformio.ini', () => {
  it('tells the user where the existing code goes and not to block loop()', () => {
    const ino = text(generateFirmware(request(walkerSpec(6), hwFor('esp32', 'serial', 'pca9685', 18), 'joint')), 'walker_esp32.ino')
    expect(ino).toContain('your existing setup() code goes here')
    expect(ino).toContain('your existing loop() code goes here')
    expect(ino).toMatch(/Never block it with a long delay\(\)/)
    expect(ino).toContain('Bridge.log(')
  })

  it('walks through install, placement, upload and connect', () => {
    const steps = generateFirmware(request(walkerSpec(6), hwFor('esp32', 'ws', 'pca9685', 18), 'high')).steps
    expect(steps[0]).toMatch(/board package and the libraries/)
    expect(steps.join(' ')).toMatch(/copy kiyobridge\.h next to your \.ino/)
    expect(steps.join(' ')).toMatch(/CHANGE_ME/)
    expect(steps.join(' ')).toMatch(/ws:\/\/<ip>:81/)
    expect(steps[steps.length - 1]).toMatch(/HOME/)
  })

  it('sets the PlatformIO environment and libraries per board', () => {
    const pico = text(generateFirmware(request(walkerSpec(4), hwFor('pico', 'serial', 'gpio', 12), 'joint')), 'platformio.ini')
    const esp = text(generateFirmware(request(walkerSpec(6), hwFor('esp32', 'ws', 'pca9685', 18), 'high')), 'platformio.ini')
    expect(pico).toContain('board = rpipico')
    expect(pico).toContain('board_build.core = earlephilhower')
    expect(esp).toContain('board = esp32dev')
    expect(esp).toContain('links2004/WebSockets')
    expect(esp).toContain('bblanchon/ArduinoJson@^7')
    expect(esp).toContain('src_dir = .')
  })
})
