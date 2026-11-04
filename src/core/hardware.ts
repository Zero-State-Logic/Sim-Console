import { create } from 'zustand'
import type { BoardId, TransportId } from './protocol'
import type { HardwareSpec } from './types'

/* ============================================================
   HARDWARE PROFILE — shared by codegen (writes firmware from it),
   the bridge (connects with it) and the sandbox (maps Servo pins
   to joints with it). One definition, so the real robot and the
   virtual one line up.
   ============================================================ */

export type ServoDriver = 'gpio' | 'pca9685'
export type WifiMode = 'sta' | 'ap'

export interface BoardInfo {
  id: BoardId
  label: string
  /** 'linux' boards get a Python daemon instead of loop() firmware. */
  kind: 'mcu' | 'linux'
  transports: Exclude<TransportId, 'loopback'>[]
  defaultBaud: number
  /** How many servos the board can drive straight from GPIO PWM. */
  maxGpioServos: number
  /** Safe default servo pins, in joint order. */
  gpioPins: number[]
  notes: string
}

export const BOARDS: Record<BoardId, BoardInfo> = {
  esp32: {
    id: 'esp32',
    label: 'ESP32',
    kind: 'mcu',
    transports: ['serial', 'ble', 'ws'],
    defaultBaud: 921600,
    maxGpioServos: 16,
    // avoids flash pins 6-11, input-only 34-39 and strapping pin 12
    gpioPins: [13, 14, 27, 26, 25, 33, 32, 4, 16, 17, 5, 18, 19, 21, 22, 23],
    notes: 'USB serial, BLE (NimBLE) and WiFi WebSocket. The best target. Build it first.',
  },
  pico: {
    id: 'pico',
    label: 'Raspberry Pi Pico (RP2040)',
    kind: 'mcu',
    transports: ['serial'],
    defaultBaud: 921600,
    maxGpioServos: 16,
    gpioPins: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
    notes: 'USB only (arduino-pico core). USB CDC ignores the baud setting.',
  },
  picow: {
    id: 'picow',
    label: 'Raspberry Pi Pico W',
    kind: 'mcu',
    transports: ['serial', 'ws', 'ble'],
    defaultBaud: 921600,
    maxGpioServos: 16,
    gpioPins: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
    notes: 'USB, WiFi WebSocket and BLE (arduino-pico core with the BTstack option).',
  },
  stm32: {
    id: 'stm32',
    label: 'STM32 (STM32duino)',
    kind: 'mcu',
    transports: ['serial'],
    defaultBaud: 921600,
    maxGpioServos: 12,
    // PA8 PA9 PA10 PA11 PA0 PA1 PA6 PA7 PB0 PB1 PB6 PB7 (timer-capable, skips the PA2/PA3 VCP pins)
    gpioPins: [8, 9, 10, 11, 0, 1, 6, 7, 16, 17, 22, 23],
    notes: 'USB serial only, no wireless unless you add a module. Pins are numbered port*16+index (PA8 = 8, PB6 = 22).',
  },
  pizero2w: {
    id: 'pizero2w',
    label: 'Raspberry Pi Zero 2 W',
    kind: 'linux',
    transports: ['ws', 'serial'],
    defaultBaud: 921600,
    maxGpioServos: 0,
    gpioPins: [],
    notes: 'A Linux computer, not a microcontroller. It runs a generated Python daemon and drives servos through a PCA9685.',
  },
}

export interface HardwareConfig {
  board: BoardId
  transport: TransportId
  baud: number
  bleName: string
  /** e.g. ws://192.168.4.1:81 */
  wsUrl: string
  wifiMode: WifiMode
  /** Codegen only. The WiFi password is never stored; the generated code has a placeholder. */
  wifiSsid: string
  servoDriver: ServoDriver
  /** Per joint: GPIO number, or PCA9685 channel (0-15 board 0x40, 16-31 board 0x41). */
  servoPins: number[]
  servoMinUs: number
  servoMaxUs: number
  /** Mechanical travel of the servo, degrees (usually 180). */
  servoRangeDeg: number
  jointInvert: boolean[]
  jointOffsetDeg: number[]
  jointScale: number[]
  commandHz: number
  telemetryHz: number
  watchdogMs: number
  watchdogAction: 'hold' | 'relax'
}

const STORAGE_KEY = 'simconsole.hw.v1'

export function defaultServoDriver(board: BoardId, joints: number): ServoDriver {
  const info = BOARDS[board]
  return info.kind === 'linux' || joints > info.maxGpioServos ? 'pca9685' : 'gpio'
}

export function defaultServoPins(board: BoardId, driver: ServoDriver, joints: number): number[] {
  if (driver === 'pca9685') return Array.from({ length: joints }, (_, i) => i)
  const pins = BOARDS[board].gpioPins
  return Array.from({ length: joints }, (_, i) => pins[i] ?? -1)
}

/** Pin label as it must appear in firmware source for this board. */
export function formatPin(board: BoardId, driver: ServoDriver, pin: number): string {
  if (driver === 'pca9685') return String(pin)
  if (board === 'stm32') return `P${String.fromCharCode(65 + Math.floor(pin / 16))}${pin % 16}`
  return String(pin)
}

/** Joint-space degrees (0 = neutral) → servo command degrees (90 = neutral). */
export function jointToServoDeg(cfg: HardwareConfig, joint: number, jointDeg: number): number {
  const dir = cfg.jointInvert[joint] ? -1 : 1
  const scale = cfg.jointScale[joint] ?? 1
  const offset = cfg.jointOffsetDeg[joint] ?? 0
  return cfg.servoRangeDeg / 2 + offset + dir * scale * jointDeg
}

/** Servo command degrees → joint-space degrees. Inverse of jointToServoDeg. */
export function servoToJointDeg(cfg: HardwareConfig, joint: number, servoDeg: number): number {
  const dir = cfg.jointInvert[joint] ? -1 : 1
  const scale = cfg.jointScale[joint] || 1
  const offset = cfg.jointOffsetDeg[joint] ?? 0
  return (dir * (servoDeg - cfg.servoRangeDeg / 2 - offset)) / scale
}

/** PCA9685 at 50 Hz: microseconds → 12-bit tick count. */
export function usToPcaTicks(us: number, freqHz = 50): number {
  return Math.round((us * freqHz * 4096) / 1_000_000)
}

/** Servo degrees → pulse width, clamped to the configured range. */
export function servoDegToUs(cfg: HardwareConfig, servoDeg: number): number {
  const f = Math.min(Math.max(servoDeg / cfg.servoRangeDeg, 0), 1)
  return Math.round(cfg.servoMinUs + f * (cfg.servoMaxUs - cfg.servoMinUs))
}

export function defaultHardwareConfig(board: BoardId, joints: number): HardwareConfig {
  const servoDriver = defaultServoDriver(board, joints)
  return {
    board,
    transport: 'serial',
    baud: BOARDS[board].defaultBaud,
    bleName: 'KiyoBot',
    wsUrl: 'ws://192.168.4.1:81',
    wifiMode: 'ap',
    wifiSsid: 'KiyoBot',
    servoDriver,
    servoPins: defaultServoPins(board, servoDriver, joints),
    servoMinUs: 500,
    servoMaxUs: 2500,
    servoRangeDeg: 180,
    jointInvert: new Array(joints).fill(false),
    jointOffsetDeg: new Array(joints).fill(0),
    jointScale: new Array(joints).fill(1),
    commandHz: 50,
    telemetryHz: 25,
    watchdogMs: 500,
    watchdogAction: 'hold',
  }
}

function resize<T>(arr: T[], n: number, fill: T): T[] {
  return Array.from({ length: n }, (_, i) => (i < arr.length ? arr[i] : fill))
}

/** Fit an existing config to a (possibly different) joint count without losing calibration. */
export function fitConfigToSpec(cfg: HardwareConfig, spec: HardwareSpec): HardwareConfig {
  const n = spec.joints
  if (cfg.servoPins.length === n) return cfg
  const servoDriver = defaultServoDriver(cfg.board, n)
  return {
    ...cfg,
    servoDriver,
    servoPins: defaultServoPins(cfg.board, servoDriver, n),
    jointInvert: resize(cfg.jointInvert, n, false),
    jointOffsetDeg: resize(cfg.jointOffsetDeg, n, 0),
    jointScale: resize(cfg.jointScale, n, 1),
  }
}

function load(): HardwareConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<HardwareConfig>
    if (!parsed || typeof parsed !== 'object' || !parsed.board || !(parsed.board in BOARDS)) return null
    const base = defaultHardwareConfig(parsed.board, parsed.servoPins?.length ?? 18)
    return { ...base, ...parsed }
  } catch {
    return null
  }
}

function save(cfg: HardwareConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
  } catch {
    /* storage unavailable (private mode / quota): config stays in memory */
  }
}

interface HardwareState {
  config: HardwareConfig
  setConfig: (patch: Partial<HardwareConfig>) => void
  setBoard: (board: BoardId) => void
  syncToSpec: (spec: HardwareSpec) => void
}

export const useHardware = create<HardwareState>((set, get) => ({
  config: load() ?? defaultHardwareConfig('esp32', 18),
  setConfig: (patch) => {
    const config = { ...get().config, ...patch }
    save(config)
    set({ config })
  },
  setBoard: (board) => {
    const prev = get().config
    const joints = prev.servoPins.length
    const servoDriver = defaultServoDriver(board, joints)
    const transport = BOARDS[board].transports.includes(prev.transport as Exclude<TransportId, 'loopback'>)
      ? prev.transport
      : BOARDS[board].transports[0]
    const config: HardwareConfig = {
      ...prev,
      board,
      transport,
      baud: BOARDS[board].defaultBaud,
      servoDriver,
      servoPins: defaultServoPins(board, servoDriver, joints),
    }
    save(config)
    set({ config })
  },
  syncToSpec: (spec) => {
    const config = fitConfigToSpec(get().config, spec)
    if (config !== get().config) {
      save(config)
      set({ config })
    }
  },
}))
