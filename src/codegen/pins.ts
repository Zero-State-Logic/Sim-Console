import { BOARDS, formatPin } from '../core/hardware'
import type { ServoDriver } from '../core/hardware'
import type { BoardId } from '../core/protocol'

/* ============================================================
   PIN RULES per board — which GPIOs can carry a servo / motor
   signal, which ones collide with the link, and the extra pins a
   sweeper's motor driver needs. Messages name the pin as it is
   written in firmware (formatPin), e.g. GPIO 6 or PA11.
   ============================================================ */

export interface PinIssues {
  errors: string[]
  warnings: string[]
}

/** PCA9685: 16 channels per board, at most two boards (0x40, 0x41). */
export const PCA_MAX_CHANNEL = 31

const ESP32_FLASH = [6, 7, 8, 9, 10, 11]
const ESP32_MISSING = [20, 24, 28, 29, 30, 31]
const ESP32_STRAPPING = [0, 2, 5, 12, 15]

function esp32Pin(pin: number, serial: boolean, out: PinIssues): void {
  if (pin > 39 || ESP32_MISSING.includes(pin)) out.errors.push(`GPIO ${pin} does not exist on the ESP32`)
  else if (ESP32_FLASH.includes(pin)) out.errors.push(`GPIO ${pin} is wired to the SPI flash on ESP32 modules`)
  else if (pin >= 34) out.errors.push(`GPIO ${pin} is input-only on the ESP32 and cannot drive a servo`)
  else if ((pin === 1 || pin === 3) && serial) out.errors.push(`GPIO ${pin} is the USB serial line (UART0) used by the link`)
  else if (ESP32_STRAPPING.includes(pin)) out.warnings.push(`GPIO ${pin} is an ESP32 strapping pin; a servo on it can stop the board from booting`)
}

function rp2040Pin(pin: number, board: BoardId, out: PinIssues): void {
  if (pin > 28) out.errors.push(`GP${pin} is not a user GPIO on the ${BOARDS[board].label}`)
  else if (pin >= 23 && pin <= 25) {
    out.errors.push(`GP${pin} is used on the board itself (${board === 'picow' ? 'wireless chip' : 'power / VBUS / LED'})`)
  }
}

function stm32Pin(pin: number, serial: boolean, out: PinIssues): void {
  const name = formatPin('stm32', 'gpio', pin)
  if (pin > 127) out.errors.push(`${name} is not a valid STM32 pin (port A..H, 0..15)`)
  else if (pin === 13 || pin === 14) out.warnings.push(`${name} is the SWD debug pin; using it blocks ST-Link uploads`)
  else if ((pin === 2 || pin === 3) && serial) out.warnings.push(`${name} is the ST-Link virtual COM port on Nucleo boards`)
  else if (pin === 11 || pin === 12) out.warnings.push(`${name} is USB D-/D+ on boards with USB CDC (Black Pill); move it if you use USB`)
}

/** Validate the per-joint pins (or PCA9685 channels) for a board. */
export function checkPins(board: BoardId, driver: ServoDriver, pins: number[], serial: boolean): PinIssues {
  const out: PinIssues = { errors: [], warnings: [] }
  const seen = new Map<number, number>()
  pins.forEach((pin, j) => {
    if (!Number.isInteger(pin) || pin < 0) {
      out.errors.push(`joint ${j} has no ${driver === 'pca9685' ? 'PCA9685 channel' : 'pin'} (${String(pin)})`)
      return
    }
    const prev = seen.get(pin)
    if (prev !== undefined) out.errors.push(`joints ${prev} and ${j} share ${driver === 'pca9685' ? 'channel' : 'pin'} ${formatPin(board, driver, pin)}`)
    seen.set(pin, j)
    if (driver === 'pca9685') {
      if (pin > PCA_MAX_CHANNEL) out.errors.push(`PCA9685 channel ${pin} is out of range (0-15 on 0x40, 16-31 on 0x41)`)
    } else if (board === 'esp32') esp32Pin(pin, serial, out)
    else if (board === 'pico' || board === 'picow') rp2040Pin(pin, board, out)
    else if (board === 'stm32') stm32Pin(pin, serial, out)
  })
  if (driver === 'gpio' && (board === 'pico' || board === 'picow')) out.errors.push(...rp2040PwmConflicts(pins))
  return dedupe(out)
}

/** RP2040: GPIO n drives PWM slice (n >> 1) & 7, channel n & 1, so pins with equal n & 15 collide. */
export function rp2040PwmConflicts(pins: number[]): string[] {
  const byChannel = new Map<number, number>()
  const errors: string[] = []
  for (const pin of pins) {
    if (!Number.isInteger(pin) || pin < 0) continue
    const ch = pin & 15
    const other = byChannel.get(ch)
    if (other !== undefined && other !== pin) {
      errors.push(`GP${other} and GP${pin} share RP2040 PWM slice ${(ch >> 1) & 7} channel ${ch & 1 ? 'B' : 'A'}; move one of them`)
    }
    byChannel.set(ch, pin)
  }
  return errors
}

function dedupe(p: PinIssues): PinIssues {
  return { errors: [...new Set(p.errors)], warnings: [...new Set(p.warnings)] }
}

/* ---------- sweeper motor driver (TB6612-style: PWM + IN1 + IN2 per motor, one STBY) ---------- */

export interface MotorPins {
  pwm: number[]
  in1: number[]
  in2: number[]
  stby: number
  /** LD06 LiDAR UART RX pin (MCU GPIO), -1 when the board uses a fixed UART. */
  lidarRx: number
}

const EXTRA_DIR_PINS: Partial<Record<BoardId, number[]>> = {
  pico: [18, 19, 20, 21, 22, 26, 27, 28],
  picow: [18, 19, 20, 21, 22, 26, 27, 28],
  // PB12-PB15, PB3-PB5, PC13 (PB6/PB7 stay free for the LD06 UART)
  stm32: [28, 29, 30, 31, 19, 20, 21, 45],
}

/** Direction / standby pins for the motor driver, taken from pins nobody else uses. */
export function allocateMotorPins(board: BoardId, driver: ServoDriver, pwm: number[]): MotorPins | null {
  const n = pwm.length
  const need = 2 * n + 1
  const used = new Set(pwm)
  let pool: number[]
  if (driver === 'pca9685') pool = Array.from({ length: 16 }, (_, i) => i)
  else if (board === 'stm32') pool = BOARDS.stm32.gpioPins.filter((p) => p !== 22 && p !== 23).concat(EXTRA_DIR_PINS.stm32 ?? [])
  else pool = BOARDS[board].gpioPins.concat(EXTRA_DIR_PINS[board] ?? [])
  const free = pool.filter((p) => !used.has(p))
  // ESP32: Serial2 RX can go on any GPIO; on a PCA9685 build GPIO 16 is free
  const lidarRx = board !== 'esp32' ? -1 : driver === 'gpio' ? free[need] ?? -1 : 16
  if (free.length < need) return null
  return {
    pwm: pwm.slice(),
    in1: free.slice(0, n),
    in2: free.slice(n, 2 * n),
    stby: free[2 * n],
    lidarRx,
  }
}
