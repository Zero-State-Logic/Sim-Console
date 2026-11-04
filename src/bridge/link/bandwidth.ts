import type { TransportId } from '../../core/protocol'
import type { CmdMsg } from '../../core/protocol'
import type { CommandLevel, HardwareSpec } from '../../core/types'
import { serializeCmd } from './outbound'

/* ============================================================
   BANDWIDTH ESTIMATE — does the command stream fit the link?
   UART: 10 bits per byte (start + 8 data + stop), so baud/10 B/s.
   BLE NUS: 20-byte writes, roughly one per 10 ms connection event
   on a typical phone/PC link. WiFi WS: far more than we need.
   ============================================================ */

/** BLE payload throughput with 20-byte chunks on a typical 7.5-15 ms connection interval, bytes/s. */
export const BLE_BYTES_PER_SEC = 2000
/** ESP32 / Pi WebSocket over WiFi, conservative, bytes/s. */
export const WS_BYTES_PER_SEC = 60_000
/** Utilization above this fraction triggers the warning. */
export const BANDWIDTH_WARN = 0.8

/** Usable payload capacity of a link, bytes/s, one direction. */
export function linkCapacity(transport: TransportId, baud: number): number {
  switch (transport) {
    case 'serial':
    case 'loopback':
      return Math.max(baud, 1) / 10
    case 'ble':
      return BLE_BYTES_PER_SEC
    case 'ws':
      return WS_BYTES_PER_SEC
  }
}

function worstJointValue(spec: HardwareSpec, i: number): number {
  const lim = spec.jointLimits[i]
  // a negative value with two decimals is the longest per-joint token
  return lim ? -Math.max(Math.abs(lim[0]), Math.abs(lim[1])) - 0.11 : -180.11
}

/** A worst-case-length command for this spec and level (what the module would send). */
export function sampleCommand(spec: HardwareSpec, level: CommandLevel): CmdMsg {
  if (level === 'high') {
    const cmd: CmdMsg = { t: 'cmd', v: [-0.1234, -0.1234, -1.2345], mode: 'tripod' }
    if (spec.robot === 'walker') cmd.h = 0.1234
    return cmd
  }
  if (spec.robot === 'sweeper') {
    const n = spec.wheels ?? spec.joints
    return { t: 'cmd', w: Array.from({ length: n }, () => -12.345) }
  }
  if (spec.robot === 'swarm') {
    const n = spec.drones ?? spec.joints
    return { t: 'cmd', sp: Array.from({ length: n }, (_, id) => ({ id, p: [-1.234, 1.234, -1.234], yaw: -123.45 })) }
  }
  return { t: 'cmd', q: Array.from({ length: spec.joints }, (_, i) => worstJointValue(spec, i)) }
}

/** Bytes on the wire for one command, newline included. */
export function estimateCmdBytes(spec: HardwareSpec, level: CommandLevel): number {
  const r = serializeCmd(sampleCommand(spec, level), 99999)
  return r.ok ? r.line.length + 1 : 0
}

export interface BandwidthInput {
  bytesPerCmd: number
  commandHz: number
  transport: TransportId
  baud: number
  /** Measured inbound bytes/s (telemetry), 0 when unknown. */
  rxBytesPerSec?: number
}

export interface BandwidthEstimate {
  txBytesPerSec: number
  capacity: number
  /** 0..n fraction of capacity used by commands. */
  txUtil: number
  rxUtil: number
  warn: boolean
  /** Highest command rate that stays under the warning threshold. */
  maxSafeHz: number
}

export function estimateBandwidth(inp: BandwidthInput): BandwidthEstimate {
  const capacity = linkCapacity(inp.transport, inp.baud)
  const txBytesPerSec = inp.bytesPerCmd * inp.commandHz
  const txUtil = txBytesPerSec / capacity
  const rxUtil = (inp.rxBytesPerSec ?? 0) / capacity
  const maxSafeHz = inp.bytesPerCmd > 0 ? Math.floor((capacity * BANDWIDTH_WARN) / inp.bytesPerCmd) : Infinity
  return { txBytesPerSec, capacity, txUtil, rxUtil, warn: txUtil > BANDWIDTH_WARN || rxUtil > BANDWIDTH_WARN, maxSafeHz }
}
