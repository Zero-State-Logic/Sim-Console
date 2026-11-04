import type { QuadParams } from './params'
import { quatNormalizeAt } from './quat'

/*
 * 12-DOF rigid-body equations of motion (13 numbers: the attitude is a unit
 * quaternion). World frame REP-103 (z up), body FLU. Layout:
 *   [0..2] position  [3..5] velocity  [6..9] q = (w, x, y, z)  [10..12] body rates
 *
 *   ṗ = v
 *   v̇ = (R(q)·[0 0 T] - drag(v - wind)) / m - g·ẑ
 *   q̇ = ½ q ⊗ (0, ω)
 *   ω̇ = J⁻¹ (τ + τ_flap - ω × Jω - c·ω)     τ_flap = k·(v_air,body × ẑ)
 *
 * The wrench [T, τx, τy, τz] is held constant across one substep (zero-order hold of
 * the motor output, which is itself integrated exactly in drone.ts).
 */

export const STATE_LEN = 13
export const P = 0
export const V = 3
export const Q = 6
export const W = 10

export type Integrator = 'rk4' | 'euler'

export function rigidBodyDerivative(
  out: Float64Array,
  s: Float64Array,
  wrench: Float64Array,
  wind: Float64Array,
  p: QuadParams,
): void {
  const vx = s[3], vy = s[4], vz = s[5]
  const qw = s[6], qx = s[7], qy = s[8], qz = s[9]
  const wx = s[10], wy = s[11], wz = s[12]
  const T = wrench[0]
  // third column of R(q): body z expressed in the world
  const bx = 2 * (qx * qz + qw * qy)
  const by = 2 * (qy * qz - qw * qx)
  const bz = 1 - 2 * (qx * qx + qy * qy)
  const rx = vx - wind[0], ry = vy - wind[1], rz = vz - wind[2]
  const c = p.dragLin + p.dragQuad * Math.sqrt(rx * rx + ry * ry + rz * rz)
  const im = 1 / p.mass
  out[0] = vx
  out[1] = vy
  out[2] = vz
  out[3] = (T * bx - c * rx) * im
  out[4] = (T * by - c * ry) * im
  out[5] = (T * bz - c * rz) * im - p.g
  out[6] = 0.5 * (-qx * wx - qy * wy - qz * wz)
  out[7] = 0.5 * (qw * wx + qy * wz - qz * wy)
  out[8] = 0.5 * (qw * wy + qz * wx - qx * wz)
  out[9] = 0.5 * (qw * wz + qx * wy - qy * wx)
  // air-relative velocity in body x/y (first two rows of Rᵀ) for the flapping moment
  const ubx = (1 - 2 * (qy * qy + qz * qz)) * rx + 2 * (qx * qy + qw * qz) * ry + 2 * (qx * qz - qw * qy) * rz
  const uby = 2 * (qx * qy - qw * qz) * rx + (1 - 2 * (qx * qx + qz * qz)) * ry + 2 * (qy * qz + qw * qx) * rz
  const Jx = p.Ixx, Jy = p.Iyy, Jz = p.Izz
  out[10] = (wrench[1] + p.kFlap * uby - (wy * Jz * wz - wz * Jy * wy) - p.dragRot * wx) / Jx
  out[11] = (wrench[2] - p.kFlap * ubx - (wz * Jx * wx - wx * Jz * wz) - p.dragRot * wy) / Jy
  out[12] = (wrench[3] - (wx * Jy * wy - wy * Jx * wx) - p.dragRot * wz) / Jz
}

/* Shared scratch: the sim is single-threaded, so one workspace serves every drone. */
const k1 = new Float64Array(STATE_LEN)
const k2 = new Float64Array(STATE_LEN)
const k3 = new Float64Array(STATE_LEN)
const k4 = new Float64Array(STATE_LEN)
const tmp = new Float64Array(STATE_LEN)

function axpy(out: Float64Array, s: Float64Array, k: Float64Array, h: number): void {
  for (let i = 0; i < STATE_LEN; i++) out[i] = s[i] + h * k[i]
}

/** Classic fourth-order Runge-Kutta step, quaternion renormalized afterwards. */
export function rk4Step(s: Float64Array, h: number, wrench: Float64Array, wind: Float64Array, p: QuadParams): void {
  rigidBodyDerivative(k1, s, wrench, wind, p)
  axpy(tmp, s, k1, h / 2)
  rigidBodyDerivative(k2, tmp, wrench, wind, p)
  axpy(tmp, s, k2, h / 2)
  rigidBodyDerivative(k3, tmp, wrench, wind, p)
  axpy(tmp, s, k3, h)
  rigidBodyDerivative(k4, tmp, wrench, wind, p)
  const h6 = h / 6
  for (let i = 0; i < STATE_LEN; i++) s[i] += h6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])
  quatNormalizeAt(s, Q)
}

/** Semi-implicit (symplectic) Euler: velocities first, then positions with the new velocities. */
export function eulerStep(s: Float64Array, h: number, wrench: Float64Array, wind: Float64Array, p: QuadParams): void {
  rigidBodyDerivative(k1, s, wrench, wind, p)
  for (let i = 0; i < 3; i++) {
    s[V + i] += h * k1[V + i]
    s[W + i] += h * k1[W + i]
    s[P + i] += h * s[V + i]
  }
  const qw = s[6], qx = s[7], qy = s[8], qz = s[9]
  const wx = s[10], wy = s[11], wz = s[12]
  s[6] = qw + 0.5 * h * (-qx * wx - qy * wy - qz * wz)
  s[7] = qx + 0.5 * h * (qw * wx + qy * wz - qz * wy)
  s[8] = qy + 0.5 * h * (qw * wy + qz * wx - qx * wz)
  s[9] = qz + 0.5 * h * (qw * wz + qx * wy - qy * wx)
  quatNormalizeAt(s, Q)
}

export function integrate(kind: Integrator, s: Float64Array, h: number, wrench: Float64Array, wind: Float64Array, p: QuadParams): void {
  if (kind === 'euler') eulerStep(s, h, wrench, wind, p)
  else rk4Step(s, h, wrench, wind, p)
}

/**
 * Exact discretization of the first-order motor lag over one substep:
 * ω ← ω_cmd + (ω - ω_cmd)·e^(-h/τ). Writes the resulting thrusts (kT·ω²).
 */
export function stepMotors(
  omega: Float64Array,
  omegaCmd: Float64Array,
  thrust: Float64Array,
  h: number,
  p: QuadParams,
): void {
  const a = 1 - Math.exp(-h / p.motorTau)
  for (let i = 0; i < 4; i++) {
    const w = omega[i] + (omegaCmd[i] - omega[i]) * a
    omega[i] = w
    thrust[i] = p.kT * w * w
  }
}

/** Thrust (N) -> commanded rotor speed (rad/s), clamped to the motor range. */
export function thrustToOmega(thrust: number, p: QuadParams): number {
  if (thrust <= 0) return 0
  const w = Math.sqrt(thrust / p.kT)
  return w > p.omegaMax ? p.omegaMax : w
}
