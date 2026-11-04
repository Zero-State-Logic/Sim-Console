import { BOARDS, fitConfigToSpec } from '../core/hardware'
import type { HardwareConfig } from '../core/hardware'
import type { BoardId } from '../core/protocol'
import type { HardwareSpec } from '../core/types'
import { BOARD_TITLE } from './context'
import type { GenContext, LinkId, SweeperCtx, WalkerCtx } from './context'
import { asciiOnly, slug } from './format'
import { gaitsFor } from './gaits'
import { forwardMatrix, readSweeperGeometry, wheelTable } from './mecanumGen'
import { allocateMotorPins, checkPins } from './pins'
import { servoTable } from './servoMap'
import type { FirmwareRequest } from './types'
import { gaitTuning, neutralFeet, readWalkerGeometry } from './walkerGeom'
import { linkWarnings } from './warnings'
import { MAX_SWARM_DRONES } from './cpp/swarm'

/* ============================================================
   VALIDATION — turns a request into a GenContext or a list of
   errors. Never throws: every invalid combination is reported in
   plain words with the fix, so the dialog can show it.
   ============================================================ */

export interface Validated {
  ctx: GenContext | null
  errors: string[]
  warnings: string[]
}

/** Hard cap: clamp bookkeeping in the firmware is a 32-bit mask. */
export const MAX_FIRMWARE_JOINTS = 32
export const BLE_NAME_MAX = 29
export const SSID_MAX = 32

function checkLink(board: BoardId, transport: string, errors: string[]): LinkId | null {
  if (transport === 'loopback') {
    errors.push('The Virtual Device (loopback) is built into the app and needs no firmware. Pick USB serial, BLE or WiFi.')
    return null
  }
  const allowed = BOARDS[board].transports as string[]
  if (!allowed.includes(transport)) {
    errors.push(`${BOARD_TITLE[board]} does not support the '${transport}' transport here. Supported: ${allowed.join(', ')}.`)
    return null
  }
  if (board === 'picow' && transport === 'ble') {
    errors.push(
      'Pico W BLE is not generated: the arduino-pico BTstack GATT API needs a hand-built attribute database that cannot be verified here. Use USB serial or WiFi WebSocket on the Pico W, or an ESP32 for BLE.',
    )
    return null
  }
  return transport as LinkId
}

function checkSpec(spec: HardwareSpec, errors: string[], warnings: string[]): void {
  const n = spec.joints
  if (!Number.isInteger(n) || n < 1 || n > MAX_FIRMWARE_JOINTS) {
    errors.push(`the robot reports ${String(n)} joints; firmware supports 1-${MAX_FIRMWARE_JOINTS}`)
    return
  }
  if (spec.robot === 'walker') {
    const legs = spec.legs ?? n / 3
    if (!Number.isInteger(legs) || legs < 1 || legs * 3 !== n) errors.push(`a walker needs 3 joints per leg, got ${n} joints for ${String(spec.legs)} legs`)
  } else if (spec.robot === 'sweeper') {
    if (n !== 4) errors.push(`the mecanum sweeper firmware drives exactly 4 wheels, the robot reports ${n}`)
  } else if (n > MAX_SWARM_DRONES) errors.push(`the swarm relay fits ${MAX_SWARM_DRONES} drones in one ESP-NOW packet, got ${n}`)
  if (spec.jointLimits.length !== n) errors.push(`jointLimits has ${spec.jointLimits.length} entries for ${n} joints`)
  spec.jointLimits.forEach(([lo, hi], j) => {
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) errors.push(`joint ${j} has invalid limits [${lo}, ${hi}]`)
  })
  if (spec.homePose.length !== n) errors.push(`homePose has ${spec.homePose.length} entries for ${n} joints`)
  spec.homePose.forEach((v, j) => {
    if (!Number.isFinite(v)) errors.push(`home pose of joint ${j} is not a number`)
    const lim = spec.jointLimits[j]
    if (lim && Number.isFinite(v) && (v < lim[0] || v > lim[1])) warnings.push(`home pose of joint ${j} (${v}°) is outside its limits and will be clamped`)
  })
  if (spec.jointNames.length !== n) warnings.push(`the robot names ${spec.jointNames.length} of ${n} joints; missing names become J<n>`)
}

function checkConfig(hw: HardwareConfig, n: number, link: LinkId, errors: string[], warnings: string[]): void {
  const range = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi
  if (link === 'serial' && !(Number.isInteger(hw.baud) && hw.baud >= 1200 && hw.baud <= 4_000_000)) errors.push(`baud ${hw.baud} is not a valid serial rate`)
  if (!range(hw.servoMinUs, 100, 3000) || !range(hw.servoMaxUs, 100, 3000) || hw.servoMinUs >= hw.servoMaxUs) {
    errors.push(`servo pulse range ${hw.servoMinUs}-${hw.servoMaxUs} µs is invalid (100-3000 µs, min below max)`)
  }
  if (!range(hw.servoRangeDeg, 1, 360)) errors.push(`servo travel ${hw.servoRangeDeg}° must be 1-360°`)
  if (!range(hw.commandHz, 1, 500)) errors.push(`command rate ${hw.commandHz} Hz must be 1-500 Hz`)
  if (!range(hw.telemetryHz, 1, 200)) errors.push(`telemetry rate ${hw.telemetryHz} Hz must be 1-200 Hz`)
  if (!range(hw.watchdogMs, 50, 60000)) errors.push(`watchdog ${hw.watchdogMs} ms must be 50-60000 ms`)
  else if (hw.watchdogMs < 3000 / hw.commandHz) warnings.push(`watchdog ${hw.watchdogMs} ms is under 3 command periods; one late packet will trip it`)
  for (let j = 0; j < n; j++) {
    if (!Number.isFinite(hw.jointOffsetDeg[j] ?? 0) || !Number.isFinite(hw.jointScale[j] ?? 1)) errors.push(`joint ${j} has a non-numeric offset or scale`)
    else if ((hw.jointScale[j] ?? 1) === 0) warnings.push(`joint ${j} has scale 0, so its servo never moves`)
  }
}

function checkDriver(req: FirmwareRequest, hw: HardwareConfig, link: LinkId, errors: string[], warnings: string[]): void {
  const { spec } = req
  const board = BOARDS[hw.board]
  if (spec.robot === 'swarm') return
  if (board.kind === 'linux' && hw.servoDriver === 'gpio') {
    errors.push('The Pi Zero 2 W daemon drives every output through a PCA9685 (Linux GPIO cannot time servo pulses). Switch the servo driver to PCA9685.')
    return
  }
  if (hw.servoDriver === 'gpio' && spec.joints > board.maxGpioServos) {
    errors.push(`${board.label} can drive at most ${board.maxGpioServos} outputs straight from GPIO and this robot needs ${spec.joints}. Use a PCA9685 (16 channels per board, two boards for up to 32).`)
    return
  }
  const pins = checkPins(hw.board, hw.servoDriver, hw.servoPins.slice(0, spec.joints), link === 'serial')
  errors.push(...pins.errors)
  warnings.push(...pins.warnings)
  if (hw.servoDriver === 'gpio' && spec.robot === 'walker') {
    if (hw.board === 'esp32' && (hw.servoMinUs < 500 || hw.servoMaxUs > 2500)) warnings.push('ESP32Servo clamps pulses to 500-2500 µs; values outside are cut off')
    if (hw.board === 'stm32' && (hw.servoMinUs < 36 || hw.servoMinUs > 1052 || hw.servoMaxUs < 1892 || hw.servoMaxUs > 2908)) {
      errors.push('the STM32 Servo library can only attach with min 36-1052 µs and max 1892-2908 µs; adjust the pulse range or use a PCA9685')
    }
  }
}

function names(spec: HardwareSpec): string[] {
  return Array.from({ length: spec.joints }, (_, j) => asciiOnly(spec.jointNames[j] ?? '') || `J${j + 1}`)
}

function walkerCtx(req: FirmwareRequest, errors: string[]): WalkerCtx | null {
  if (req.spec.robot !== 'walker' || req.level !== 'high') return null
  const { geom, errors: geomErrors } = readWalkerGeometry(req.spec)
  if (!geom) {
    errors.push(...geomErrors.map((e) => `${e}. Generate at the joint level instead, or fix the robot geometry.`))
    return null
  }
  const feet = neutralFeet(geom)
  return { geom, gaits: gaitsFor(geom), tuning: gaitTuning(geom), neutralX: feet.x, neutralY: feet.y }
}

function sweeperCtx(req: FirmwareRequest, hw: HardwareConfig, errors: string[], warnings: string[]): SweeperCtx | null {
  if (req.spec.robot !== 'sweeper' || req.spec.joints !== 4) return null
  const { geom, missing } = readSweeperGeometry(req.spec)
  if (missing.length) warnings.push(`the robot spec has no ${missing.join(', ')}; using romi defaults. Measure your robot and edit KIYO_WHEEL_* in kiyobridge.h.`)
  const { rows, guessed } = wheelTable(req.spec, geom)
  if (guessed) warnings.push('wheel names did not parse as FL/FR/RL/RR; assuming joint order FL, FR, RL, RR')
  const motors = allocateMotorPins(hw.board, hw.servoDriver, hw.servoPins.slice(0, 4))
  if (!motors) {
    errors.push('not enough free pins for the motor driver direction lines (needs 2 per motor + STBY); free some pins or use a PCA9685')
    return null
  }
  return { geom, wheels: rows, forward: forwardMatrix(rows, geom.wheelRadius), motors }
}

function staticCaps(req: FirmwareRequest): string[] {
  const caps: string[] = []
  if (req.spec.robot === 'walker' && req.level === 'high') caps.push('onboard-ik', 'gait')
  if (req.spec.robot === 'sweeper') caps.push('mecanum', 'odom')
  if (req.spec.robot === 'swarm') caps.push('relay', 'espnow')
  caps.push('watchdog', 'clamp')
  return caps
}

function checkStrings(hw: HardwareConfig, link: LinkId, errors: string[], warnings: string[]): void {
  if (link === 'ble') {
    const name = asciiOnly(hw.bleName)
    if (!name) errors.push('the BLE name is empty (use printable ASCII)')
    else if (name !== hw.bleName || name.length > BLE_NAME_MAX) warnings.push(`the BLE name is trimmed to ${BLE_NAME_MAX} printable ASCII characters`)
  }
  // the Pi joins the WiFi configured in Raspberry Pi Imager; only MCU builds embed an SSID
  if (link === 'ws' && BOARDS[hw.board].kind === 'mcu') {
    const ssid = asciiOnly(hw.wifiSsid)
    if (!ssid) errors.push('the WiFi SSID is empty (use printable ASCII)')
    else if (ssid.length > SSID_MAX) errors.push(`the WiFi SSID is longer than ${SSID_MAX} characters`)
    else if (ssid !== hw.wifiSsid) warnings.push('non-ASCII characters were removed from the WiFi SSID')
  }
}

/** Validate and resolve a request. Errors mean no files can be generated. */
export function buildContext(req: FirmwareRequest): Validated {
  const errors: string[] = []
  const warnings: string[] = []
  if (!(req.hw.board in BOARDS)) return { ctx: null, errors: [`unknown board '${String(req.hw.board)}'`], warnings }
  if (req.spec.robot === 'swarm' && req.hw.board !== 'esp32') {
    errors.push('The swarm ground-station relay uses ESP-NOW, which only the ESP32 has. Pick ESP32 as the relay board.')
  }
  const link = checkLink(req.hw.board, req.hw.transport, errors)
  checkSpec(req.spec, errors, warnings)
  if (!link || errors.length) return { ctx: null, errors, warnings }
  const hw = fitConfigToSpec(req.hw, req.spec)
  checkConfig(hw, req.spec.joints, link, errors, warnings)
  checkDriver(req, hw, link, errors, warnings)
  checkStrings(hw, link, errors, warnings)
  const walker = walkerCtx(req, errors)
  const sweeper = sweeperCtx(req, hw, errors, warnings)
  if (errors.length) return { ctx: null, errors, warnings }
  const ctx = assemble(req, hw, link, walker, sweeper)
  warnings.push(...linkWarnings(ctx))
  return { ctx, errors, warnings: [...new Set(warnings)] }
}

function assemble(req: FirmwareRequest, hw: HardwareConfig, link: LinkId, walker: WalkerCtx | null, sweeper: SweeperCtx | null): GenContext {
  const { spec } = req
  const n = spec.joints
  const driver = spec.robot === 'swarm' ? 'gpio' : hw.servoDriver
  const pins = hw.servoPins.slice(0, n)
  const usbCdc = link === 'serial' && (hw.board === 'pico' || hw.board === 'picow' || hw.board === 'pizero2w')
  return {
    spec,
    hw,
    board: hw.board,
    info: BOARDS[hw.board],
    robot: spec.robot,
    robotLabel: asciiOnly(req.robotLabel) || spec.robot.toUpperCase(),
    level: req.level,
    link,
    driver,
    joints: n,
    names: names(spec),
    limits: spec.jointLimits.map(([lo, hi]) => [lo, hi] as [number, number]),
    home: spec.homePose.map((v, j) => Math.min(Math.max(v, spec.jointLimits[j][0]), spec.jointLimits[j][1])),
    legs: spec.robot === 'walker' ? spec.legs ?? n / 3 : 0,
    wheels: spec.robot === 'sweeper' ? spec.wheels ?? n : 0,
    drones: spec.robot === 'swarm' ? spec.drones ?? n : 0,
    sketch: slug(`${spec.robot}_${hw.board}`),
    servo: servoTable(hw, n),
    pcaBoards: driver === 'pca9685' && pins.some((p) => p >= 16) ? 2 : 1,
    walker,
    sweeper,
    caps: staticCaps(req),
    usbCdc,
  }
}

