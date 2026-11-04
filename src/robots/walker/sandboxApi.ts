import type { SandboxCommand, SandboxFnDef, SensorSnapshot } from '../../core/types'
import type { WalkerSim } from './sim'

/* ============================================================
   CODE drive source — the robot API user programs see.
   Degrees in the API, meters for positions, indices are 0-based.
   Commands arrive from an untrusted worker: every one is checked
   for arity, finite numbers and index range before it is applied.
   ============================================================ */

const DEG = Math.PI / 180

export const WALKER_SANDBOX_API: SandboxFnDef[] = [
  { name: 'setJoint', kind: 'command', params: ['joint', 'deg'], doc: 'Drive one joint (0..joints-1) to an angle in degrees. Overrides the gait for that joint until the program stops.' },
  { name: 'setLeg', kind: 'command', params: ['leg', 'x', 'y', 'z'], doc: 'Put a foot (leg 0..legs-1) at x, y, z meters in the body frame (x forward, y left, z up) through IK.' },
  { name: 'walk', kind: 'command', params: ['vx', 'vy', 'wz'], doc: 'Walk with a body twist: vx, vy in m/s, wz in deg/s (CCW +). The gait engine limits it to the stride.' },
  { name: 'stop', kind: 'command', params: [], doc: 'Stop walking; the feet settle back to neutral.' },
  { name: 'setGait', kind: 'command', params: ['index'], doc: 'Select a gait by index for the current leg count (0 = tripod / tetrapod / crawl).' },
  { name: 'setBodyHeight', kind: 'command', params: ['h'], doc: 'Body height above the ground, meters (0.04 .. 0.16).' },
  { name: 'setBodyPose', kind: 'command', params: ['roll', 'pitch', 'yaw'], doc: 'Body roll, pitch, yaw in degrees (±15, ±15, ±20). Feet stay planted.' },
  { name: 'readJoint', kind: 'query', params: ['joint'], sensor: 'joint', doc: 'Current joint angle, degrees.' },
  { name: 'readLoad', kind: 'query', params: ['leg'], sensor: 'load', doc: 'Vertical load on a foot, newtons.' },
  { name: 'readContact', kind: 'query', params: ['leg'], sensor: 'contact', doc: '1 when the foot is on the ground, else 0.' },
  { name: 'readImu', kind: 'query', params: ['axis'], sensor: 'imu', doc: 'Body attitude, degrees: axis 0 = roll, 1 = pitch, 2 = yaw.' },
  { name: 'legCount', kind: 'query', params: [], sensor: 'legs', doc: 'Number of legs (4, 6 or 8).' },
  { name: 'jointCount', kind: 'query', params: [], sensor: 'joints', doc: 'Number of joints (3 per leg).' },
]

/** What the module does with a validated command. Angles here are radians. */
export interface SandboxTarget {
  setJoint(joint: number, rad: number): void
  setLeg(leg: number, x: number, y: number, z: number): void
  walk(vx: number, vy: number, wz: number): void
  stop(): void
  setGait(index: number): void
  setBodyHeight(h: number): void
  setBodyPose(roll: number, pitch: number, yaw: number): void
}

const ARITY: Record<string, number> = Object.fromEntries(
  WALKER_SANDBOX_API.filter((f) => f.kind === 'command').map((f) => [f.name, f.params.length]),
)

/** Body-frame foot targets further than this from the body centre are refused. */
const MAX_LEG_TARGET = 1
/** Commands applied per frame at most; a runaway program cannot stall the frame. */
export const MAX_COMMANDS_PER_FRAME = 2048

function validArgs(c: SandboxCommand): boolean {
  const need = ARITY[c.fn]
  if (need === undefined || !Array.isArray(c.args) || c.args.length < need) return false
  for (let k = 0; k < need; k++) if (typeof c.args[k] !== 'number' || !Number.isFinite(c.args[k])) return false
  return true
}

function isIndex(v: number, count: number): boolean {
  return Number.isInteger(v) && v >= 0 && v < count
}

/** Apply a batch of commands in order. Returns how many were accepted. */
export function applyWalkerCommands(cmds: readonly SandboxCommand[], legs: number, t: SandboxTarget): number {
  let ok = 0
  const count = Math.min(cmds.length, MAX_COMMANDS_PER_FRAME)
  for (let k = 0; k < count; k++) {
    const c = cmds[k]
    if (!c || typeof c.fn !== 'string' || !validArgs(c)) continue
    const a = c.args
    switch (c.fn) {
      case 'setJoint':
        if (!isIndex(a[0], legs * 3)) continue
        t.setJoint(a[0], a[1] * DEG)
        break
      case 'setLeg':
        if (!isIndex(a[0], legs) || Math.hypot(a[1], a[2], a[3]) > MAX_LEG_TARGET) continue
        t.setLeg(a[0], a[1], a[2], a[3])
        break
      case 'walk':
        t.walk(a[0], a[1], a[2] * DEG)
        break
      case 'stop':
        t.stop()
        break
      case 'setGait':
        if (!Number.isInteger(a[0]) || a[0] < 0) continue
        t.setGait(a[0])
        break
      case 'setBodyHeight':
        t.setBodyHeight(a[0])
        break
      case 'setBodyPose':
        t.setBodyPose(a[0] * DEG, a[1] * DEG, a[2] * DEG)
        break
      default:
        continue
    }
    ok++
  }
  return ok
}

/**
 * What CODE has asked for beyond per-joint / per-leg overrides (those live in the sim):
 * a walking twist and body pose overrides. NaN = not overridden. Cleared on release.
 */
export class SandboxOverrides {
  walking = false
  vx = 0
  vy = 0
  /** rad/s */
  wz = 0
  height = NaN
  /** radians */
  roll = NaN
  pitch = NaN
  yaw = NaN

  walk(vx: number, vy: number, wz: number): void {
    this.walking = true
    this.vx = vx
    this.vy = vy
    this.wz = wz
  }

  clear(): void {
    this.walking = false
    this.vx = 0
    this.vy = 0
    this.wz = 0
    this.height = NaN
    this.roll = NaN
    this.pitch = NaN
    this.yaw = NaN
  }
}

const RAD = 180 / Math.PI

/** Sensor snapshot posted to the worker each frame (degrees, newtons, 0/1). */
export function walkerSensors(sim: WalkerSim, rpy: Float64Array): SensorSnapshot {
  const n = sim.n
  const s = sim.state
  const joint: number[] = []
  for (let j = 0; j < n * 3; j++) joint.push(Math.round(s.q[j] * RAD * 100) / 100)
  return {
    joint,
    load: Array.from(s.load.subarray(0, n), (v) => Math.round(v * 1000) / 1000),
    contact: Array.from(s.contact.subarray(0, n)),
    imu: [rpy[0] * RAD, rpy[1] * RAD, rpy[2] * RAD],
    legs: n,
    joints: n * 3,
  }
}
