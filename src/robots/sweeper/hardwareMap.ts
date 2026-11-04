import type { CmdMsg, LidarScan, TelMsg } from '../../core/protocol'
import type { CommandLevel, HardwareSpec, TelemetryTable } from '../../core/types'
import { HALF_LENGTH, HALF_WIDTH, MAX_WHEEL_SPEED, WHEEL_NAMES, WHEEL_RADIUS } from './constants'
import type { Twist } from './mecanum'

/*
 * HARDWARE mapping for the romi_nav board. 'joint' level (USB) streams the four wheel
 * speeds in rad/s (`w`); 'high' level (wireless) sends the body twist `v` = [vx, vy, wz]
 * (m/s, m/s, rad/s) and the behaviour name, and the board mixes its own wheels.
 * Inbound telemetry is untrusted: every field is validated before use.
 */

const RAD2DEG = 180 / Math.PI
const MAX_WHEEL_DEG_S = Math.round(MAX_WHEEL_SPEED * RAD2DEG)
const MAX_SCAN_SAMPLES = 2048

export function hardwareSpec(): HardwareSpec {
  return {
    robot: 'sweeper',
    joints: 4,
    jointNames: WHEEL_NAMES.map((n) => `WHEEL ${n}`),
    // continuous wheels: the limits are wheel speeds in deg/s, not angles
    jointLimits: WHEEL_NAMES.map((): [number, number] => [-MAX_WHEEL_DEG_S, MAX_WHEEL_DEG_S]),
    homePose: [0, 0, 0, 0],
    wheels: 4,
    defaultLevel: { wired: 'joint', wireless: 'high' },
    geometry: { wheelRadius: WHEEL_RADIUS, halfLength: HALF_LENGTH, halfWidth: HALF_WIDTH, maxWheelSpeed: MAX_WHEEL_SPEED },
  }
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000

export function buildCmd(level: CommandLevel, wheels: ArrayLike<number>, twist: Twist, mode: string): CmdMsg {
  if (level === 'joint') return { t: 'cmd', w: [r3(wheels[0]), r3(wheels[1]), r3(wheels[2]), r3(wheels[3])], mode }
  return { t: 'cmd', v: [r3(twist.vx), r3(twist.vy), r3(twist.wz)], mode }
}

export interface ParsedTel {
  enc: [number, number, number, number] | null
  /** [x m, y m, heading rad] */
  pose: [number, number, number] | null
  scan: LidarScan | null
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Validate the sweeper-relevant parts of a telemetry message. */
export function parseTelemetry(tel: TelMsg): ParsedTel {
  const out: ParsedTel = { enc: null, pose: null, scan: null }
  const enc = tel.enc
  if (Array.isArray(enc) && enc.length >= 4 && enc.slice(0, 4).every(finite)) {
    const clamp = (v: number) => Math.max(-4 * MAX_WHEEL_SPEED, Math.min(4 * MAX_WHEEL_SPEED, v))
    out.enc = [clamp(enc[0]), clamp(enc[1]), clamp(enc[2]), clamp(enc[3])]
  }
  const p = tel.pose
  if (Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every(finite) && Math.abs(p[0]) < 1e3 && Math.abs(p[1]) < 1e3) {
    out.pose = [p[0], p[1], p[2] / RAD2DEG]
  }
  const s = tel.scan
  if (s && typeof s === 'object' && finite(s.a0) && finite(s.da) && Array.isArray(s.r) && s.r.length > 0 && s.r.length <= MAX_SCAN_SAMPLES) {
    out.scan = { a0: s.a0, da: s.da, r: s.r }
  }
  return out
}

/** Per-wheel table for the bridge: commanded vs measured speed and rpm. */
export function telemetryRows(cmd: ArrayLike<number>, tel: TelMsg | null): TelemetryTable {
  const enc = tel ? parseTelemetry(tel).enc : null
  return {
    cols: ['WHEEL', 'CMD rad/s', 'MEAS rad/s', 'RPM'],
    rows: WHEEL_NAMES.map((label, i) => {
      const meas = enc ? enc[i] : null
      return {
        label,
        cells: [r3(cmd[i]), meas === null ? '—' : r3(meas), meas === null ? '—' : Math.round((meas * 60) / (2 * Math.PI))],
      }
    }),
  }
}
