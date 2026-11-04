import type { GenContext } from './context'

/* ============================================================
   LINK WARNINGS — bandwidth budget and per-platform caveats.
   Byte counts are estimates of the NDJSON lines the app sends
   (cmd) and the board returns (tel), with typical precision.
   ============================================================ */

/** Serial line utilisation above this fraction leaves no headroom for bursts. */
export const SERIAL_BUDGET = 0.5
/** Practical BLE notification / write throughput, bytes per second. */
export const BLE_BYTES_PER_SEC = 4000

const CMD_HEAD = '{"t":"cmd","seq":65535,'.length
const TEL_HEAD = '{"t":"tel","ms":1234567,'.length
/** One joint value like -123.45 plus the comma. */
const VALUE_BYTES = 8
const TWIST_TAIL = '"v":[0.123,-0.045,0.512],"mode":"tripod","h":0.091}\n'.length
const DRONE_SP = '{"id":0,"p":[1.234,0.812,-2.345],"yaw":12.3},'.length
const DRONE_TEL = '{"id":0,"p":[1.23,0.81,-2.34],"att":[1.2,-0.4,12.3],"bat":3.91},'.length

/** Estimated bytes of one command line for this robot and level. */
export function commandBytes(ctx: Pick<GenContext, 'robot' | 'level' | 'joints'>): number {
  if (ctx.robot === 'swarm') return CMD_HEAD + 6 + ctx.joints * DRONE_SP + 2
  if (ctx.level === 'high') return CMD_HEAD + TWIST_TAIL
  return CMD_HEAD + 6 + ctx.joints * VALUE_BYTES + 2
}

/** Estimated bytes of one telemetry line. */
export function telemetryBytes(ctx: Pick<GenContext, 'robot' | 'joints' | 'legs'>): number {
  if (ctx.robot === 'swarm') return TEL_HEAD + 11 + ctx.joints * DRONE_TEL + 2
  if (ctx.robot === 'sweeper') return TEL_HEAD + 8 + 4 * VALUE_BYTES + 30 + 2
  return TEL_HEAD + 8 + ctx.joints * VALUE_BYTES + 9 + ctx.legs * 5 + 2
}

function serialWarnings(ctx: GenContext): string[] {
  // native USB CDC ignores the baud and runs at USB speed: no budget to check
  if (ctx.usbCdc) return []
  const out: string[] = []
  const capacity = ctx.hw.baud / 10
  const cmd = commandBytes(ctx) * ctx.hw.commandHz
  const tel = telemetryBytes(ctx) * ctx.hw.telemetryHz
  if (cmd > capacity * SERIAL_BUDGET) {
    out.push(
      `${ctx.joints} joints × ${ctx.hw.commandHz} Hz needs about ${Math.round(cmd)} B/s of commands, ${Math.round((cmd / capacity) * 100)}% of ${ctx.hw.baud} baud (${Math.round(capacity)} B/s). Raise the baud to 921600 or lower the command rate.`,
    )
  }
  if (tel > capacity * SERIAL_BUDGET) {
    out.push(`telemetry at ${ctx.hw.telemetryHz} Hz needs about ${Math.round(tel)} B/s, ${Math.round((tel / capacity) * 100)}% of the link. Lower the telemetry rate or raise the baud.`)
  }
  return out
}

function bleWarnings(ctx: GenContext): string[] {
  const out: string[] = []
  const cmd = commandBytes(ctx) * ctx.hw.commandHz
  if (cmd > BLE_BYTES_PER_SEC) {
    out.push(
      `BLE carries roughly ${BLE_BYTES_PER_SEC} B/s in practice; streaming ${ctx.level === 'joint' ? 'every joint' : 'commands'} at ${ctx.hw.commandHz} Hz needs about ${Math.round(cmd)} B/s. Use the HIGH level or a lower command rate.`,
    )
  }
  out.push('Web Bluetooth works in Chrome / Edge (desktop and Android) only, and the page must be served over HTTPS or localhost.')
  return out
}

function platformWarnings(ctx: GenContext): string[] {
  const out: string[] = []
  if (ctx.board === 'stm32') {
    out.push('STM32: on Nucleo boards Serial is the ST-Link virtual COM port (USART2). On Black Pill / Blue Pill enable USB CDC (Tools > USB support > CDC) or Serial goes to PA2/PA3.')
  }
  if (ctx.board === 'pizero2w') {
    out.push('Pi Zero 2 W: Linux is not real-time, so expect a few ms of jitter; the PCA9685 keeps servo pulses steady regardless.')
  }
  if (ctx.board === 'picow' && ctx.link === 'ws') out.push('Pico W WebSocket needs the WebSockets library 2.4.0 or newer (RP2040 support).')
  if (ctx.robot === 'swarm') out.push('Flight stabilisation stays on each drone\'s flight controller; the relay only forwards position setpoints over ESP-NOW.')
  return out
}

/** All bandwidth and platform warnings for a validated context. */
export function linkWarnings(ctx: GenContext): string[] {
  const out: string[] = []
  if (ctx.link === 'serial') out.push(...serialWarnings(ctx))
  if (ctx.link === 'ble') out.push(...bleWarnings(ctx))
  if (ctx.link === 'ws') {
    out.push(
      'The hosted (HTTPS) app cannot open ws:// to a LAN address (mixed content). Run the app locally (npm run dev), or run tools/ws-relay.mjs and connect to ws://localhost.',
    )
  }
  out.push(...platformWarnings(ctx))
  return out
}
