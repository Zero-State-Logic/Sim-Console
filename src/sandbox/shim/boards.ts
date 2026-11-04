import type { BoardId } from '../../core/protocol'
import { BIN, DEC, HEX, OCT } from './format'

/* ============================================================
   BOARD CONSTANTS for the Arduino shim. Pin numbers follow each
   core's variant files, so a sketch written for the real board
   reads the same pins here.
   ============================================================ */

export const HIGH = 1
export const LOW = 0
export const INPUT = 0
export const OUTPUT = 1
export const INPUT_PULLUP = 2
export const INPUT_PULLDOWN = 3

/** LED_BUILTIN per core: ESP32 dev kits GPIO2, Pico GP25, Pico W the CYW43 LED (64), STM32 PC13. */
const LED_PIN: Record<BoardId, number> = { esp32: 2, pico: 25, picow: 64, stm32: 45, pizero2w: 13 }

/** A0..A7. Pico has only A0-A3 on real pins; A4-A7 are virtual so every sketch compiles. */
const ANALOG_PINS: Record<BoardId, number[]> = {
  esp32: [36, 37, 38, 39, 32, 33, 34, 35],
  pico: [26, 27, 28, 29, 30, 31, 32, 33],
  picow: [26, 27, 28, 29, 30, 31, 32, 33],
  stm32: [0, 1, 2, 3, 4, 5, 6, 7],
  pizero2w: [14, 15, 16, 17, 18, 19, 20, 21],
}

/** Default analogRead() resolution in bits (ESP32 reads 12-bit, the Arduino API default is 10). */
const ADC_BITS: Record<BoardId, number> = { esp32: 12, pico: 10, picow: 10, stm32: 10, pizero2w: 10 }

export function ledPin(board: BoardId): number {
  return LED_PIN[board]
}

export function adcBits(board: BoardId): number {
  return ADC_BITS[board]
}

export const WIFI_CONSTANTS: Record<string, number> = {
  WL_IDLE_STATUS: 0,
  WL_NO_SSID_AVAIL: 1,
  WL_CONNECTED: 3,
  WL_CONNECT_FAILED: 4,
  WL_DISCONNECTED: 6,
  WIFI_OFF: 0,
  WIFI_STA: 1,
  WIFI_AP: 2,
  WIFI_AP_STA: 3,
}

/** STM32duino names: PA0..PC15 = port * 16 + index (PA8 = 8, PB6 = 22, PC13 = 45). */
export function stm32PinNames(): Record<string, number> {
  const out: Record<string, number> = {}
  for (let port = 0; port < 3; port++) {
    for (let i = 0; i < 16; i++) out[`P${String.fromCharCode(65 + port)}${i}`] = port * 16 + i
  }
  return out
}

/** Every constant the shim defines for a board (both dialects). */
export function boardConstants(board: BoardId): Record<string, number> {
  const consts: Record<string, number> = {
    HIGH,
    LOW,
    INPUT,
    OUTPUT,
    INPUT_PULLUP,
    INPUT_PULLDOWN,
    LED_BUILTIN: ledPin(board),
    DEC,
    HEX,
    OCT,
    BIN,
    SERIAL_8N1: 0x800001c,
    ...WIFI_CONSTANTS,
    ...stm32PinNames(),
  }
  ANALOG_PINS[board].forEach((pin, i) => {
    consts[`A${i}`] = pin
  })
  return consts
}

/** Headers accepted by #include. WiFi.h compiles but is flagged as not simulated. */
export const KNOWN_INCLUDES: readonly string[] = [
  'Arduino.h',
  'Servo.h',
  'ESP32Servo.h',
  'Wire.h',
  'SPI.h',
  'Adafruit_PWMServoDriver.h',
  'math.h',
  'kiyobridge.h',
  'WiFi.h',
]

export interface IncludeRef {
  header: string
  line: number
  col: number
}

/** #include lines, in order (block comments are not tracked; good enough for notes). */
export function scanIncludes(source: string): IncludeRef[] {
  const out: IncludeRef[] = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)#\s*include\s*[<"]([^>"]+)[>"]/.exec(lines[i])
    if (m) out.push({ header: m[2].trim(), line: i + 1, col: m[1].length + 1 })
  }
  return out
}
