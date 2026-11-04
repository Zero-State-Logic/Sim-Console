import { HALF_LENGTH, HALF_WIDTH, WHEEL_RADIUS } from './constants'

/*
 * Mecanum kinematics, standard X-roller mixing. Body frame REP-103 (x forward,
 * y left, wz CCW). Wheel order FL, FR, RL, RR; positive wheel speed rolls forward.
 *   w_fl = (vx - vy - k wz) / r      w_fr = (vx + vy + k wz) / r
 *   w_rl = (vx + vy - k wz) / r      w_rr = (vx - vy + k wz) / r     k = lx + ly
 * Forward kinematics is the least-squares inverse of that 4x3 mixing matrix.
 */

export interface Twist {
  vx: number
  vy: number
  wz: number
}

export interface Pose2 {
  x: number
  y: number
  th: number
}

export interface WheelGeometry {
  r: number
  lx: number
  ly: number
}

export const ROMI_GEOMETRY: WheelGeometry = { r: WHEEL_RADIUS, lx: HALF_LENGTH, ly: HALF_WIDTH }

/** Body twist -> 4 wheel speeds (rad/s), written into `out`. */
export function mecanumInverse(vx: number, vy: number, wz: number, out: Float64Array | number[], g: WheelGeometry = ROMI_GEOMETRY): void {
  const k = (g.lx + g.ly) * wz
  out[0] = (vx - vy - k) / g.r
  out[1] = (vx + vy + k) / g.r
  out[2] = (vx + vy - k) / g.r
  out[3] = (vx - vy + k) / g.r
}

/** 4 wheel speeds (rad/s) -> body twist, written into `out` and returned. */
export function mecanumForward(w: ArrayLike<number>, out: Twist, g: WheelGeometry = ROMI_GEOMETRY): Twist {
  const q = g.r / 4
  out.vx = q * (w[0] + w[1] + w[2] + w[3])
  out.vy = q * (-w[0] + w[1] + w[2] - w[3])
  out.wz = (q / (g.lx + g.ly)) * (-w[0] + w[1] - w[2] + w[3])
  return out
}

/**
 * Direction-preserving saturation: if any |w_i| exceeds `max`, every wheel is scaled
 * by the same factor, so the body twist keeps its direction and only slows down.
 * Returns the factor applied (1 when nothing saturated).
 */
export function saturateWheels(w: Float64Array | number[], max: number): number {
  let peak = 0
  for (let i = 0; i < 4; i++) peak = Math.max(peak, Math.abs(w[i]))
  if (peak <= max || peak === 0) return 1
  const s = max / peak
  for (let i = 0; i < 4; i++) w[i] *= s
  return s
}

/**
 * Acceleration limit that also preserves direction: the step from `current` toward
 * `target` is scaled as one vector so no wheel changes by more than `maxDelta`.
 */
export function rateLimitWheels(current: Float64Array | number[], target: ArrayLike<number>, maxDelta: number): void {
  let peak = 0
  for (let i = 0; i < 4; i++) peak = Math.max(peak, Math.abs(target[i] - current[i]))
  const s = peak > maxDelta && peak > 0 ? maxDelta / peak : 1
  for (let i = 0; i < 4; i++) current[i] += s * (target[i] - current[i])
}

export function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI)
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI
}

/**
 * Exact pose update for a body twist held constant over dt (the robot moves on a
 * circular arc). Writes into `out` (may alias `p`).
 */
export function integratePose(p: Pose2, vx: number, vy: number, wz: number, dt: number, out: Pose2): Pose2 {
  const phi = wz * dt
  let s: number
  let c: number
  if (Math.abs(phi) < 1e-6) {
    s = dt * (1 - (phi * phi) / 6)
    c = (dt * phi) / 2
  } else {
    s = Math.sin(phi) / wz
    c = (1 - Math.cos(phi)) / wz
  }
  const dxl = s * vx - c * vy
  const dyl = c * vx + s * vy
  const ct = Math.cos(p.th)
  const st = Math.sin(p.th)
  const x = p.x + ct * dxl - st * dyl
  const y = p.y + st * dxl + ct * dyl
  out.x = x
  out.y = y
  out.th = wrapAngle(p.th + phi)
  return out
}
