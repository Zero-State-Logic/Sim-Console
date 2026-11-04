import { describe, expect, it } from 'vitest'
import { BOARDS } from '../core/hardware'
import { allocateMotorPins, checkPins, rp2040PwmConflicts } from './pins'

describe('pin rules per board', () => {
  it('accepts the default GPIO pins of every MCU board', () => {
    for (const board of ['esp32', 'pico', 'picow', 'stm32'] as const) {
      expect(checkPins(board, 'gpio', BOARDS[board].gpioPins.slice(0, 12), true).errors).toEqual([])
    }
  })

  it('rejects ESP32 flash, input-only and missing pins', () => {
    const { errors } = checkPins('esp32', 'gpio', [6, 34, 24], false)
    expect(errors).toHaveLength(3)
    expect(errors[0]).toMatch(/flash/)
    expect(errors[1]).toMatch(/input-only/)
    expect(errors[2]).toMatch(/does not exist/)
  })

  it('warns about ESP32 strapping pins and blocks UART0 on a serial link only', () => {
    expect(checkPins('esp32', 'gpio', [12], false).warnings[0]).toMatch(/strapping/)
    expect(checkPins('esp32', 'gpio', [1], true).errors[0]).toMatch(/UART0/)
    expect(checkPins('esp32', 'gpio', [1], false).errors).toEqual([])
  })

  it('reports shared pins and missing pins', () => {
    const { errors } = checkPins('pico', 'gpio', [2, 2, -1], true)
    expect(errors.some((e) => /share pin 2/.test(e))).toBe(true)
    expect(errors.some((e) => /joint 2 has no pin/.test(e))).toBe(true)
  })

  it('finds RP2040 PWM slice collisions (GPIO n and n+16)', () => {
    expect(rp2040PwmConflicts([2, 18])[0]).toMatch(/slice 1 channel A/)
    expect(rp2040PwmConflicts([2, 3, 4])).toEqual([])
  })

  it('warns about the STM32 SWD and ST-Link VCP pins', () => {
    expect(checkPins('stm32', 'gpio', [13], true).warnings[0]).toMatch(/PA13.*SWD/)
    expect(checkPins('stm32', 'gpio', [2], true).warnings[0]).toMatch(/PA2.*virtual COM/)
  })

  it('limits PCA9685 channels to two boards', () => {
    expect(checkPins('esp32', 'pca9685', [0, 31], true).errors).toEqual([])
    expect(checkPins('esp32', 'pca9685', [32], true).errors[0]).toMatch(/out of range/)
  })
})

describe('sweeper motor pin allocation', () => {
  it.each(['esp32', 'pico', 'picow', 'stm32'] as const)('gives %s two free direction pins per motor plus STBY', (board) => {
    const pwm = BOARDS[board].gpioPins.slice(0, 4)
    const m = allocateMotorPins(board, 'gpio', pwm)
    expect(m).not.toBeNull()
    const all = [...(m?.pwm ?? []), ...(m?.in1 ?? []), ...(m?.in2 ?? []), m?.stby ?? -1]
    expect(new Set(all).size).toBe(13)
    expect(checkPins(board, 'gpio', all, true).errors).toEqual([])
  })

  it('keeps the STM32 LD06 UART pins (PB6 / PB7) free', () => {
    const m = allocateMotorPins('stm32', 'gpio', BOARDS.stm32.gpioPins.slice(0, 4))
    expect([...(m?.in1 ?? []), ...(m?.in2 ?? []), m?.stby]).not.toContain(22)
    expect([...(m?.in1 ?? []), ...(m?.in2 ?? []), m?.stby]).not.toContain(23)
  })

  it('puts every line on PCA9685 channels with a PCA9685 driver', () => {
    const m = allocateMotorPins('pizero2w', 'pca9685', [0, 1, 2, 3])
    expect(m?.in1).toEqual([4, 5, 6, 7])
    expect(m?.in2).toEqual([8, 9, 10, 11])
    expect(m?.stby).toBe(12)
  })
})
