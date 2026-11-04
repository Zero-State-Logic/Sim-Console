import { DEG, FOOT_HX, FOOT_HY, LIDAR_OFFSET_X } from './constants'
import type { Twist } from './mecanum'

/*
 * Reactive safety layer. The LiDAR measures from its own center, so the clearance in a
 * direction is the range minus the distance from the sensor to the footprint edge in
 * that direction. Translation scales linearly from 1 at SLOW_DIST down to 0 at STOP_DIST,
 * using the worst clearance in a cone around the direction of motion.
 */

export const STOP_DIST = 0.04
export const SLOW_DIST = 0.32
export const CONE_HALF_DEG = 32

/** Distance from the origin to the edge of the rectangle [xmin,xmax]x[ymin,ymax] along phi. */
export function exitDistance(phi: number, xmin: number, xmax: number, ymin: number, ymax: number): number {
  const c = Math.cos(phi), s = Math.sin(phi)
  let t = Infinity
  if (c > 1e-9) t = Math.min(t, xmax / c)
  else if (c < -1e-9) t = Math.min(t, xmin / c)
  if (s > 1e-9) t = Math.min(t, ymax / s)
  else if (s < -1e-9) t = Math.min(t, ymin / s)
  return t
}

/** Sensor-to-footprint-edge distance for each whole degree (body frame). */
export const FOOTPRINT_EXIT: Float32Array = (() => {
  const t = new Float32Array(360)
  for (let d = 0; d < 360; d++) {
    t[d] = exitDistance(d * DEG, -FOOT_HX - LIDAR_OFFSET_X, FOOT_HX - LIDAR_OFFSET_X, -FOOT_HY, FOOT_HY)
  }
  return t
})()

/** Worst clearance (m) within +-halfDeg of body direction phi, Infinity if nothing returned. */
export function clearanceToward(bins: Float32Array, phi: number, halfDeg = CONE_HALF_DEG): number {
  const center = Math.round(phi / DEG)
  let m = Infinity
  for (let d = -halfDeg; d <= halfDeg; d++) {
    const b = (((center + d) % 360) + 360) % 360
    const r = bins[b]
    if (r > 0) m = Math.min(m, r - FOOTPRINT_EXIT[b])
  }
  return m
}

/** Smallest clearance around the whole footprint. */
export function minClearance(bins: Float32Array): number {
  let m = Infinity
  for (let b = 0; b < 360; b++) if (bins[b] > 0) m = Math.min(m, bins[b] - FOOTPRINT_EXIT[b])
  return m
}

export function safetyScale(clearance: number, stop = STOP_DIST, slow = SLOW_DIST): number {
  if (!(clearance < slow)) return 1
  return Math.max(0, Math.min(1, (clearance - stop) / (slow - stop)))
}

/** Scale the translation of a twist by the clearance in its direction. Returns the factor. */
export function applySafety(bins: Float32Array, tw: Twist): number {
  const v = Math.hypot(tw.vx, tw.vy)
  if (v < 1e-4) return 1
  const k = safetyScale(clearanceToward(bins, Math.atan2(tw.vy, tw.vx)))
  tw.vx *= k
  tw.vy *= k
  return k
}
