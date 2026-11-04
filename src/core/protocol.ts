/* ============================================================
   KIYOBRIDGE PROTOCOL v1 — newline-delimited JSON, both directions.
   Human-readable on purpose: the raw stream IS the serial monitor feed.
   The generated firmware (src/codegen) and the Virtual Device
   (src/bridge) must speak exactly this.
   ============================================================ */

import type { RobotKind } from './types'

export const PROTOCOL_VERSION = 1
/** Hard cap on one inbound line. Longer lines are dropped as malformed. */
export const MAX_LINE_BYTES = 8192

export type BoardId = 'esp32' | 'pico' | 'picow' | 'stm32' | 'pizero2w'
export type TransportId = 'serial' | 'ble' | 'ws' | 'loopback'

/* ---------- bot → app ---------- */

export interface HelloMsg {
  t: 'hello'
  proto: number
  board: BoardId
  robot: RobotKind
  joints: number
  legs?: number
  wheels?: number
  drones?: number
  /** Firmware id, e.g. 'kiyobridge-1.0'. */
  fw?: string
  /** Optional capabilities, e.g. ['imu','load','feedback','onboard-ik']. */
  caps?: string[]
}

export interface DroneTel {
  id: number
  /** World position, meters [x, y, z] (y up). */
  p: [number, number, number]
  /** Attitude, degrees [roll, pitch, yaw]. */
  att: [number, number, number]
  /**
   * Battery. Values <= 4.35 are a 1S LiPo cell voltage (e.g. 3.92), values above are a
   * percentage (5–100). Generated firmware sends percent and encodes readings of 4 % or
   * less as cell volts so the two never collide; the Virtual Device sends cell volts.
   * Decoded to percent by src/robots/swarm/hardwareIO.ts batteryPercent().
   */
  bat?: number
}

export interface LidarScan {
  /** Start angle, degrees. */
  a0: number
  /** Angle step, degrees. */
  da: number
  /** Ranges, meters (0 = no return). */
  r: number[]
}

export interface TelMsg {
  t: 'tel'
  /** Board uptime, ms. */
  ms?: number
  /** Measured joint angles, degrees joint space. */
  ang?: number[]
  /** Per-leg load, normalized 0..1 (or N if caps include 'load-n'). */
  load?: number[]
  /** IMU [roll, pitch, yaw], degrees. */
  imu?: [number, number, number]
  /** Wheel encoder speeds, rad/s. */
  enc?: number[]
  scan?: LidarScan
  /** Planar pose [x, y, headingDeg] (sweeper odometry). */
  pose?: [number, number, number]
  vbat?: number
  drones?: DroneTel[]
}

export interface AckMsg {
  t: 'ack'
  /** Which message is being acknowledged, e.g. 'home', 'estop'. */
  of: string
  ok: boolean
  msg?: string
}

export interface LogMsg {
  t: 'log'
  lvl?: 'info' | 'warn' | 'err'
  msg: string
}

export interface PongMsg {
  t: 'pong'
  id: number
}

/* ---------- app → bot ---------- */

export interface DroneSetpoint {
  id: number
  /** Target position, meters [x, y, z] (y up). */
  p: [number, number, number]
  yaw?: number
}

export interface CmdMsg {
  t: 'cmd'
  seq?: number
  /** Joint targets, degrees joint space (USB / 'joint' level). */
  q?: number[]
  /** Body twist [vx m/s, vy m/s, wz rad/s] ('high' level). */
  v?: [number, number, number]
  /** Wheel speeds, rad/s (sweeper 'joint' level). */
  w?: number[]
  /** Drone setpoints (swarm). */
  sp?: DroneSetpoint[]
  /** Gait or behaviour name, e.g. 'tripod', 'coverage'. */
  mode?: string
  /** Body height, meters (walker 'high' level). */
  h?: number
}

export interface HomeMsg { t: 'home' }
export interface EstopMsg { t: 'estop' }
export interface PingMsg { t: 'ping'; id: number }
/** Ask the board to (re)send its hello. */
export interface HelloReqMsg { t: 'hello?' }

export type BotToApp = HelloMsg | TelMsg | AckMsg | LogMsg | PongMsg
export type AppToBot = CmdMsg | HomeMsg | EstopMsg | PingMsg | HelloReqMsg
export type BridgeMsg = BotToApp | AppToBot
