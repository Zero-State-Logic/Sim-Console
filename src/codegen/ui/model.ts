import { BOARDS, defaultServoPins, formatPin } from '../../core/hardware'
import type { HardwareConfig, ServoDriver } from '../../core/hardware'
import type { BoardId, TransportId } from '../../core/protocol'
import type { CommandLevel, HardwareSpec, RobotKind } from '../../core/types'
import { allocateMotorPins, checkPins, PCA_MAX_CHANNEL } from '../pins'
import type { MotorPins } from '../pins'
import type { FirmwareRequest } from '../types'

/* ============================================================
   DIALOG MODEL — pure helpers behind the firmware dialog: which
   choices exist for a board and robot, how a pin is typed and
   shown, which table rows have a problem, and the request the
   generator gets. No React, so it is unit-tested in Node.
   ============================================================ */

export type LinkTransport = Exclude<TransportId, 'loopback'>

export interface Choice<T extends string> {
  value: T
  label: string
  disabled?: boolean
  hint?: string
}

export const BOARD_ORDER: BoardId[] = ['esp32', 'pico', 'picow', 'stm32', 'pizero2w']

export const BOARD_SHORT: Record<BoardId, string> = {
  esp32: 'ESP32',
  pico: 'PICO',
  picow: 'PICO W',
  stm32: 'STM32',
  pizero2w: 'PI ZERO 2 W',
}

const TRANSPORT_LABEL: Record<LinkTransport, string> = { serial: 'USB SERIAL', ble: 'BLE', ws: 'WIFI' }

export const BAUD_RATES = [115200, 230400, 460800, 500000, 921600, 1000000, 2000000]

export function boardChoices(robot: RobotKind): Choice<BoardId>[] {
  return BOARD_ORDER.map((id) => {
    const swarmOnly = robot === 'swarm' && id !== 'esp32'
    return { value: id, label: BOARD_SHORT[id], disabled: swarmOnly, hint: swarmOnly ? 'The swarm relay needs ESP-NOW (ESP32 only)' : BOARDS[id].notes }
  })
}

export function transportChoices(board: BoardId): Choice<LinkTransport>[] {
  return BOARDS[board].transports.map((t) => {
    const picoBle = board === 'picow' && t === 'ble'
    return { value: t, label: TRANSPORT_LABEL[t], disabled: picoBle, hint: picoBle ? 'Pico W BLE firmware is not generated yet: use USB serial or WiFi' : undefined }
  })
}

/** The transport the firmware is generated for: the configured one when the board has it. */
export function effectiveTransport(hw: Pick<HardwareConfig, 'board' | 'transport'>): LinkTransport {
  const allowed = BOARDS[hw.board].transports
  const usable = allowed.filter((t) => !(hw.board === 'picow' && t === 'ble'))
  return (usable as string[]).includes(hw.transport) ? (hw.transport as LinkTransport) : usable[0] ?? allowed[0]
}

export function defaultLevelFor(spec: Pick<HardwareSpec, 'defaultLevel'>, transport: LinkTransport): CommandLevel {
  return transport === 'serial' ? spec.defaultLevel.wired : spec.defaultLevel.wireless
}

export function levelChoices(robot: RobotKind): Choice<CommandLevel>[] {
  if (robot === 'swarm') return [{ value: 'high', label: 'SETPOINTS', hint: 'The relay forwards drone position setpoints' }]
  const high = robot === 'walker' ? 'board runs the gait + IK (v, mode, h)' : 'board mixes the wheels (v)'
  const joint = robot === 'walker' ? 'app streams every joint angle (q)' : 'app streams wheel speeds (w)'
  return [
    { value: 'joint', label: 'JOINT', hint: joint },
    { value: 'high', label: 'HIGH', hint: high },
  ]
}

export function driverChoices(board: BoardId, joints: number): Choice<ServoDriver>[] {
  const info = BOARDS[board]
  const gpioOff = info.kind === 'linux' || joints > info.maxGpioServos
  const hint = info.kind === 'linux' ? 'Linux cannot time servo pulses: use a PCA9685' : gpioOff ? `${info.label} drives at most ${info.maxGpioServos} outputs from GPIO` : undefined
  return [
    { value: 'gpio', label: 'GPIO', disabled: gpioOff, hint },
    { value: 'pca9685', label: 'PCA9685', hint: '16 channels per board over I2C; a second board at 0x41 gives 32' },
  ]
}

/** Config patch for a driver switch: fresh default pins so nothing stale carries over. */
export function patchForDriver(hw: HardwareConfig, driver: ServoDriver, joints: number): Partial<HardwareConfig> {
  return { servoDriver: driver, servoPins: defaultServoPins(hw.board, driver, joints) }
}

/** Pin text in the table: PA8 on STM32 GPIO, a plain number everywhere else. */
export function pinLabel(board: BoardId, driver: ServoDriver, pin: number): string {
  return pin < 0 || !Number.isInteger(pin) ? '' : formatPin(board, driver, pin)
}

/** Parse what the user typed into a pin cell. Null = not a pin. */
export function parsePin(board: BoardId, driver: ServoDriver, text: string): number | null {
  const t = text.trim().toUpperCase()
  if (driver === 'gpio' && board === 'stm32') {
    const m = /^P([A-H])(\d{1,2})$/.exec(t)
    if (m) {
      const idx = Number(m[2])
      return idx <= 15 ? (m[1].charCodeAt(0) - 65) * 16 + idx : null
    }
  }
  const raw = t.replace(/^(GPIO|GP|CH)\s*/, '')
  if (!/^\d{1,3}$/.test(raw)) return null
  const n = Number(raw)
  if (driver === 'pca9685' && n > PCA_MAX_CHANNEL) return null
  return n
}

/** Rows (joint indexes) whose pin is missing, shared, or wrong for the board. */
export function pinRowIssues(board: BoardId, driver: ServoDriver, pins: number[], serial: boolean): Set<number> {
  const bad = new Set<number>()
  const seen = new Map<number, number>()
  pins.forEach((pin, j) => {
    if (checkPins(board, driver, [pin], serial).errors.length) bad.add(j)
    const prev = seen.get(pin)
    if (prev !== undefined) {
      bad.add(prev)
      bad.add(j)
    }
    seen.set(pin, j)
  })
  return bad
}

/** Direction / standby lines the sweeper firmware will use (read-only in the table). */
export function sweeperMotorPins(hw: HardwareConfig): MotorPins | null {
  return allocateMotorPins(hw.board, hw.servoDriver, hw.servoPins.slice(0, 4))
}

/** Next enabled choice in a direction, wrapping around (radio-group arrow keys). */
export function stepChoice<T extends string>(choices: Choice<T>[], value: T, dir: 1 | -1): T | null {
  const n = choices.length
  const at = choices.findIndex((c) => c.value === value)
  for (let k = 1; k <= n; k++) {
    const c = choices[(((at + dir * k) % n) + n) % n]
    if (!c.disabled) return c.value
  }
  return null
}

/** Immutable update of one entry of a per-joint array. */
export function withEntry<T>(arr: readonly T[], index: number, value: T): T[] {
  return arr.map((v, i) => (i === index ? value : v))
}

/** The generator request for what the dialog shows. */
export function buildRequest(spec: HardwareSpec, hw: HardwareConfig, robotLabel: string, level: CommandLevel): FirmwareRequest {
  return { spec, hw: { ...hw, transport: effectiveTransport(hw) }, robotLabel, level }
}

/** The three lines a user adds to an existing sketch. */
export const TOUCH_POINTS = '#include "kiyobridge.h"   // top of the sketch\n\nvoid setup() { Bridge.begin(); }   // first line of setup()\nvoid loop()  { Bridge.update(); }  // first line of loop()\n'
