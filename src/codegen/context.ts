import type { BoardInfo, HardwareConfig, ServoDriver } from '../core/hardware'
import type { BoardId } from '../core/protocol'
import type { CommandLevel, HardwareSpec, RobotKind } from '../core/types'
import type { GaitDef } from './gaits'
import type { SweeperGeom, WheelRow } from './mecanumGen'
import type { MotorPins } from './pins'
import type { ServoTable } from './servoMap'
import type { GaitTuning, WalkerGeom } from './walkerGeom'

/* ============================================================
   GENERATION CONTEXT — a validated, fully resolved view of the
   request. Every template reads from this, never from the raw
   request, so templates never see a missing or non-finite value.
   ============================================================ */

export type LinkId = 'serial' | 'ble' | 'ws'

export const FW_ID = 'kiyobridge-1.0'
export const PROTO = 1

export interface WalkerCtx {
  geom: WalkerGeom
  gaits: GaitDef[]
  tuning: GaitTuning
  neutralX: number[]
  neutralY: number[]
}

export interface SweeperCtx {
  geom: SweeperGeom
  wheels: WheelRow[]
  /** 3×N least-squares forward matrix. */
  forward: number[][]
  motors: MotorPins
}

export interface GenContext {
  spec: HardwareSpec
  hw: HardwareConfig
  board: BoardId
  info: BoardInfo
  robot: RobotKind
  robotLabel: string
  level: CommandLevel
  link: LinkId
  driver: ServoDriver
  joints: number
  names: string[]
  limits: [number, number][]
  home: number[]
  legs: number
  wheels: number
  drones: number
  /** Sketch / folder name, e.g. 'walker_esp32'. */
  sketch: string
  servo: ServoTable
  /** Number of PCA9685 boards (1 or 2) when driver = pca9685. */
  pcaBoards: number
  walker: WalkerCtx | null
  sweeper: SweeperCtx | null
  /** Static capability tags announced in hello (hooks add more at runtime). */
  caps: string[]
  /** Transport the USB link really is (CDC ignores the baud). */
  usbCdc: boolean
}

export const BOARD_TITLE: Record<BoardId, string> = {
  esp32: 'ESP32',
  pico: 'Raspberry Pi Pico',
  picow: 'Raspberry Pi Pico W',
  stm32: 'STM32 (STM32duino)',
  pizero2w: 'Raspberry Pi Zero 2 W',
}

export const LINK_TITLE: Record<LinkId, string> = {
  serial: 'USB serial',
  ble: 'Bluetooth LE (Nordic UART)',
  ws: 'WiFi WebSocket',
}

/** Nordic UART Service, the de-facto BLE serial profile. */
export const NUS = {
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  rx: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  tx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
} as const

export const WS_PORT = 81
export const WIFI_PASS_PLACEHOLDER = 'CHANGE_ME'
export const ESPNOW_CHANNEL = 1
