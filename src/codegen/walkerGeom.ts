import type { HardwareSpec } from '../core/types'

/* ============================================================
   WALKER GEOMETRY FOR ON-BOARD IK — read from HardwareSpec.geometry
   (REP-103 body frame: x forward, y left, z up; meters, degrees),
   plus a reference IK / FK that the generated C++ and Python
   transliterate line by line. Joint conventions (src/core/types.ts):
   zero = coxa straight out, femur horizontal, tibia vertical down;
   coxa + = CCW from above, femur + = up, tibia + = foot out.
   ============================================================ */

export interface WalkerGeom {
  legs: number
  coxa: number
  femur: number
  tibia: number
  standHeight: number
  footReach: number
  mountX: number[]
  mountY: number[]
  mountYawDeg: number[]
}

export interface GeomRead<T> {
  geom: T | null
  errors: string[]
}

const DEG = Math.PI / 180

function scalar(g: Record<string, number | number[]>, key: string, errors: string[]): number {
  const v = g[key]
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    errors.push(`walker geometry '${key}' is missing or not a positive number`)
    return 0
  }
  return v
}

function vector(g: Record<string, number | number[]>, key: string, n: number, errors: string[]): number[] {
  const v = g[key]
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    errors.push(`walker geometry '${key}' must be ${n} finite numbers (one per leg)`)
    return new Array<number>(n).fill(0)
  }
  return v.slice()
}

/** Everything the on-board gait needs; errors name each missing or bad field. */
export function readWalkerGeometry(spec: HardwareSpec): GeomRead<WalkerGeom> {
  const errors: string[] = []
  const legs = spec.legs ?? Math.floor(spec.joints / 3)
  const g = spec.geometry
  if (!g) return { geom: null, errors: ['the robot spec has no geometry, so on-board IK cannot be generated'] }
  const geom: WalkerGeom = {
    legs,
    coxa: scalar(g, 'coxa', errors),
    femur: scalar(g, 'femur', errors),
    tibia: scalar(g, 'tibia', errors),
    standHeight: scalar(g, 'standHeight', errors),
    footReach: scalar(g, 'footReach', errors),
    mountX: vector(g, 'mountX', legs, errors),
    mountY: vector(g, 'mountY', legs, errors),
    mountYawDeg: vector(g, 'mountYawDeg', legs, errors),
  }
  if (errors.length === 0 && geom.standHeight >= geom.femur + geom.tibia) {
    errors.push('walker standHeight is taller than femur + tibia; the legs cannot reach the ground')
  }
  return errors.length ? { geom: null, errors } : { geom, errors }
}

/** Neutral foot point of each leg: footReach out along the mount yaw. */
export function neutralFeet(g: WalkerGeom): { x: number[]; y: number[] } {
  const x: number[] = []
  const y: number[] = []
  for (let i = 0; i < g.legs; i++) {
    const yaw = g.mountYawDeg[i] * DEG
    x.push(g.mountX[i] + g.footReach * Math.cos(yaw))
    y.push(g.mountY[i] + g.footReach * Math.sin(yaw))
  }
  return { x, y }
}

/** Gait tuning constants written into the firmware (all user-editable there). */
export interface GaitTuning {
  stepHeight: number
  maxStride: number
  cycleMinS: number
  cycleMaxS: number
  /** Shortest swing, s: the tripod's at its fastest cycle and the sim's crawl (~270 °/s peak joint rate). High-duty gaits get a longer cycle. */
  swingMinS: number
  cmdTauS: number
  heightMin: number
  heightMax: number
}

export function gaitTuning(g: WalkerGeom): GaitTuning {
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
  return {
    stepHeight: clamp(0.3 * g.standHeight, 0.01, 0.06),
    maxStride: 0.5 * g.footReach,
    cycleMinS: 0.6,
    cycleMaxS: 1.2,
    swingMinS: 0.3,
    cmdTauS: 0.2,
    heightMin: 0.5 * g.standHeight,
    heightMax: Math.min(1.6 * g.standHeight, 0.95 * (g.femur + g.tibia)),
  }
}

export interface IkResult {
  /** Degrees, joint space [coxa, femur, tibia]. */
  q: [number, number, number]
  /** False when the target was outside the reachable shell and got clamped onto it. */
  reachable: boolean
}

const REACH_EPS = 0.001

/** Closed-form 3-DOF leg IK, knee up. Foot target in the body frame (m). */
export function legIk(g: WalkerGeom, leg: number, px: number, py: number, pz: number): IkResult {
  const dx = px - g.mountX[leg]
  const dy = py - g.mountY[leg]
  const yaw = g.mountYawDeg[leg] * DEG
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const lx = c * dx + s * dy
  const ly = -s * dx + c * dy
  const coxa = Math.atan2(ly, lx)
  let r = Math.hypot(lx, ly) - g.coxa
  let z = pz
  let d = Math.hypot(r, z)
  const dMax = g.femur + g.tibia - REACH_EPS
  const dMin = Math.abs(g.femur - g.tibia) + REACH_EPS
  let reachable = true
  if (d > dMax || d < dMin) {
    reachable = false
    const target = d > dMax ? dMax : dMin
    if (d < 1e-9) {
      r = target
      z = 0
    } else {
      r *= target / d
      z *= target / d
    }
    d = target
  }
  const F = g.femur
  const T = g.tibia
  const unit = (v: number) => Math.min(Math.max(v, -1), 1)
  const a1 = Math.acos(unit((F * F + d * d - T * T) / (2 * F * d)))
  const a2 = Math.acos(unit((F * F + T * T - d * d) / (2 * F * T)))
  const gamma = Math.atan2(z, r)
  return { q: [coxa / DEG, (gamma + a1) / DEG, (a2 - Math.PI / 2) / DEG], reachable }
}

/** Forward kinematics, the exact inverse of legIk (used to verify it). */
export function legFk(g: WalkerGeom, leg: number, qDeg: [number, number, number]): [number, number, number] {
  const t1 = qDeg[0] * DEG
  const t2 = qDeg[1] * DEG
  const beta = t2 - Math.PI / 2 + qDeg[2] * DEG
  const r = g.coxa + g.femur * Math.cos(t2) + g.tibia * Math.cos(beta)
  const z = g.femur * Math.sin(t2) + g.tibia * Math.sin(beta)
  const lx = r * Math.cos(t1)
  const ly = r * Math.sin(t1)
  const yaw = g.mountYawDeg[leg] * DEG
  return [g.mountX[leg] + Math.cos(yaw) * lx - Math.sin(yaw) * ly, g.mountY[leg] + Math.sin(yaw) * lx + Math.cos(yaw) * ly, z]
}

/**
 * Foot target for one leg in the gait (reference for the firmware loop).
 * Stance (phase < duty): the foot slides from +stride/2 to -stride/2 at ground level, so a
 * planted foot moves at exactly -(v + w x r) relative to the body. Swing: cosine return
 * with a sine lift.
 */
export function gaitFoot(
  nx: number,
  ny: number,
  strideX: number,
  strideY: number,
  phase: number,
  duty: number,
  liftM: number,
  height: number,
): [number, number, number] {
  let k: number
  let z = 0
  if (phase < duty) {
    k = 0.5 - phase / duty
  } else {
    const u = (phase - duty) / (1 - duty)
    k = -0.5 + 0.5 * (1 - Math.cos(Math.PI * u))
    z = liftM * Math.sin(Math.PI * u)
  }
  return [nx + k * strideX, ny + k * strideY, -height + z]
}
