import type { HardwareConfig } from '../../core/hardware'
import type { CmdMsg, TelMsg } from '../../core/protocol'

/* Shared pieces of the virtual bodies (walker, sweeper, swarm). */

/** track = follow commands · hold = keep targets · relax = go limp · frozen = E-STOP */
export type DriveMode = 'track' | 'hold' | 'relax' | 'frozen'

export interface BodyHost {
  /** Rate-limited by the device per key. */
  warn(key: string, msg: string): void
}

export interface VirtualBody {
  readonly caps: string[]
  /** What E-STOP physically does to this robot, for the board log. */
  readonly estopNote: string
  command(cmd: CmdMsg, cfg: HardwareConfig): void
  beginHome(cfg: HardwareConfig): void
  /** Eased homing progress 0..1. */
  homeProgress(u: number): void
  setMode(mode: DriveMode): void
  step(dt: number): void
  /** Fill the robot-specific fields of an outgoing tel message. */
  telemetry(tel: TelMsg): void
}

export const DEG = 180 / Math.PI
export const G = 9.81

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

export function r1(x: number): number {
  return Math.round(x * 10) / 10
}

export function r2(x: number): number {
  return Math.round(x * 100) / 100
}

export function r3(x: number): number {
  return Math.round(x * 1000) / 1000
}
