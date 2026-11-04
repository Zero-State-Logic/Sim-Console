import type { HardwareSpec, TelemetryTable } from '../../core/types'
import type { CmdMsg, TelMsg } from '../../core/protocol'
import { MAX_JOINTS, jointName, legLabel } from './geometry'
import { JOINT_LIMITS_DEG } from './kinematics'
import type { WalkerSim } from './sim'

/* ============================================================
   HARDWARE SIDE — spec for codegen / bridge, wire commands and the
   live telemetry table. Degrees on the wire, REP-103 body frame.
   ============================================================ */

const DEG = 180 / Math.PI
/** Normalised loads above this are taken to already be newtons. */
const NORMALISED_MAX = 1.5

function round(v: number, digits: number): number {
  const k = 10 ** digits
  return Math.round(v * k) / k
}

const homeScratch = new Float64Array(MAX_JOINTS)

export function walkerHardwareSpec(sim: WalkerSim): HardwareSpec {
  const L = sim.layout
  const n = L.n
  const joints = n * 3
  sim.homePose(homeScratch)
  return {
    robot: 'walker',
    joints,
    jointNames: Array.from({ length: joints }, (_, j) => jointName(j)),
    jointLimits: Array.from({ length: joints }, (_, j) => [JOINT_LIMITS_DEG[j % 3][0], JOINT_LIMITS_DEG[j % 3][1]] as [number, number]),
    homePose: Array.from({ length: joints }, (_, j) => round(homeScratch[j] * DEG, 1)),
    legs: n,
    defaultLevel: { wired: 'joint', wireless: 'high' },
    geometry: {
      coxa: L.dims.coxa,
      femur: L.dims.femur,
      tibia: L.dims.tibia,
      standHeight: round(sim.pose.height, 4),
      footReach: round(L.footReach, 4),
      mountX: Array.from(L.mountX, (v) => round(v, 4)),
      mountY: Array.from(L.mountY, (v) => round(v, 4)),
      mountYawDeg: Array.from(L.mountYaw, (v) => round(v * DEG, 2)),
    },
  }
}

/** 'joint' level: the servo targets the sim is commanding, degrees, clamped to the limits. */
export function jointCommand(sim: WalkerSim): CmdMsg {
  const q: number[] = []
  for (let j = 0; j < sim.n * 3; j++) {
    const lim = JOINT_LIMITS_DEG[j % 3]
    q.push(round(Math.min(Math.max(sim.qTarget[j] * DEG, lim[0]), lim[1]), 1))
  }
  return { t: 'cmd', q }
}

/** 'high' level: body twist [vx m/s, vy m/s, wz rad/s], gait name and body height. */
export function highCommand(sim: WalkerSim): CmdMsg {
  const c = sim.engine.cmd
  return {
    t: 'cmd',
    v: [round(c[0], 4), round(c[1], 4), round(c[2], 4)],
    mode: sim.gait.id,
    h: round(sim.pose.height, 4),
  }
}

/**
 * Telemetry loads → newtons. The protocol allows 0..1 normalised values; those are
 * read as a fraction of the robot's weight. Values above 1.5 are taken as newtons.
 */
export function loadToNewtons(load: readonly unknown[], weight: number, out: Float64Array, n: number): void {
  // only finite numbers count: one junk value off the wire must not flip the unit guess
  let max = 0
  for (let i = 0; i < n; i++) {
    const v = load[i]
    if (typeof v === 'number' && Number.isFinite(v)) max = Math.max(max, Math.abs(v))
  }
  const k = max > NORMALISED_MAX ? 1 : weight
  for (let i = 0; i < n; i++) {
    const v = load[i]
    out[i] = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v * k) : 0
  }
}

/** Validate a joint-angle array off the wire: right length, all finite. */
export function validAngles(ang: unknown, joints: number): ang is number[] {
  if (!Array.isArray(ang) || ang.length < joints) return false
  for (let j = 0; j < joints; j++) if (typeof ang[j] !== 'number' || !Number.isFinite(ang[j])) return false
  return true
}

export function validImu(imu: unknown): imu is [number, number, number] {
  return Array.isArray(imu) && imu.length >= 3 && imu.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v))
}

/** One row per leg: coxa / femur / tibia degrees, load and contact. cols are the cell headers. */
export function walkerTelemetryTable(sim: WalkerSim, tel: TelMsg | null): TelemetryTable {
  const n = sim.n
  const angOk = tel ? validAngles(tel.ang, n * 3) : false
  const loads = new Float64Array(n)
  const loadOk = !!tel && Array.isArray(tel.load) && tel.load.length >= n
  if (loadOk && tel?.load) loadToNewtons(tel.load, sim.weight, loads, n)
  const rows = Array.from({ length: n }, (_, i) => {
    const ang = (k: number) => (angOk && tel?.ang ? round(tel.ang[i * 3 + k], 1) : round(sim.state.q[i * 3 + k] * DEG, 1))
    const load = loadOk ? loads[i] : sim.state.load[i]
    return {
      label: legLabel(i),
      cells: [ang(0), ang(1), ang(2), round(load, 2), (loadOk ? load > 0.08 * sim.weight / n : sim.state.contact[i] === 1) ? 'DOWN' : 'AIR'],
    }
  })
  return { cols: ['COXA °', 'FEMUR °', 'TIBIA °', 'LOAD N', 'CONTACT'], rows }
}
