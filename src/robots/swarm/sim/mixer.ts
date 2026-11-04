import type { QuadParams } from './params'
import { maxMotorThrust } from './params'

/*
 * X-frame mixer (FLU body axes, looking down):
 *
 *        x (forward)
 *   M3 RL  ↑  M0 FL         M0 (+d,+d) CW    M1 (+d,-d) CCW
 *      \   |   /            M2 (-d,-d) CW    M3 (-d,+d) CCW
 *   y ←----+                d = armLength/√2
 *      /       \
 *   M2 RR     M1 FR
 *
 * Each motor pushes along body +z with thrust T_i and reacts a yaw torque
 * -spin_i·κ·T_i (κ = kQ/kT). The 4×4 map is a scaled Hadamard matrix, so the inverse
 * is its transpose with per-row scaling. Priority under saturation:
 * roll/pitch > collective thrust > yaw.
 */

/** Roll-torque sign per motor (τx = d·Σ SX_i T_i). */
export const SX: readonly number[] = [1, -1, -1, 1]
/** Pitch-torque sign per motor (τy = d·Σ SY_i T_i). */
export const SY: readonly number[] = [-1, -1, 1, 1]
/** Yaw-torque sign per motor (τz = κ·Σ SZ_i T_i). CW props react CCW (+). */
export const SZ: readonly number[] = [1, -1, 1, -1]
/** Spin direction seen from above: +1 = CCW, -1 = CW. */
export const SPIN: readonly number[] = [-1, 1, -1, 1]

export interface MixerGeom {
  /** Lever arm per axis, m (armLength/√2). */
  d: number
  /** kQ/kT, m. */
  kappa: number
  tMax: number
  tMin: number
}

export function mixerGeom(p: QuadParams, armed = true): MixerGeom {
  const tMax = maxMotorThrust(p)
  return {
    d: p.armLength / Math.SQRT2,
    kappa: p.kQ / p.kT,
    tMax,
    tMin: armed ? p.idleFrac * tMax : 0,
  }
}

/** Forward map: motor thrusts (N) -> [T, τx, τy, τz]. */
export function unmix(out: Float64Array | number[], th: Float64Array | number[], g: MixerGeom): void {
  let T = 0, tx = 0, ty = 0, tz = 0
  for (let i = 0; i < 4; i++) {
    const f = th[i]
    T += f
    tx += SX[i] * f
    ty += SY[i] * f
    tz += SZ[i] * f
  }
  out[0] = T
  out[1] = g.d * tx
  out[2] = g.d * ty
  out[3] = g.kappa * tz
}

/** Bit flags returned by mix(). */
export const SAT_RP = 1
export const SAT_THRUST = 2
export const SAT_YAW = 4

/**
 * Inverse map with saturation: writes four motor thrusts in [tMin, tMax].
 * Returns SAT_* flags describing what had to give.
 */
export function mix(out: Float64Array | number[], T: number, tx: number, ty: number, tz: number, g: MixerGeom): number {
  let flags = 0
  const kRP = 1 / (4 * g.d)
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < 4; i++) {
    const rp = (SX[i] * tx + SY[i] * ty) * kRP
    out[i] = rp
    if (rp < lo) lo = rp
    if (rp > hi) hi = rp
  }
  const span = g.tMax - g.tMin
  // 1) roll/pitch alone must fit the motor range; scale it down if not
  if (hi - lo > span) {
    const s = span / (hi - lo)
    for (let i = 0; i < 4; i++) out[i] *= s
    lo *= s
    hi *= s
    flags |= SAT_RP
  }
  // 2) collective is shifted (not the attitude) to keep every motor in range
  const want = T / 4
  const base = Math.min(Math.max(want, g.tMin - lo), g.tMax - hi)
  if (Math.abs(base - want) > 1e-9) flags |= SAT_THRUST
  for (let i = 0; i < 4; i++) out[i] += base
  // 3) yaw gets whatever headroom is left
  return flags | addYaw(out, tz / (4 * g.kappa), g)
}

function addYaw(out: Float64Array | number[], y: number, g: MixerGeom): number {
  const sgn = y >= 0 ? 1 : -1
  let room = Math.abs(y)
  for (let i = 0; i < 4; i++) {
    const up = SZ[i] * sgn > 0
    const avail = up ? g.tMax - out[i] : out[i] - g.tMin
    if (avail < room) room = Math.max(0, avail)
  }
  for (let i = 0; i < 4; i++) out[i] += SZ[i] * sgn * room
  return room < Math.abs(y) - 1e-9 ? SAT_YAW : 0
}
