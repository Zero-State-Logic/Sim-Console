/*
 * Frame conventions for the swarm.
 *
 * The flight dynamics run in a REP-103 world frame (x forward/east, y left/north,
 * z up) with FLU body axes, which is what the quadrotor equations and the firmware
 * expect. Everything that leaves the sim (three.js scene, wire protocol, sandbox API,
 * clicked waypoints) is in the three.js Y-up world. The mapping is a proper rotation:
 *
 *   three (X, Y, Z) = sim (x, z, -y)        sim (x, y, z) = three (X, -Z, Y)
 *
 * Quaternions map the same way on their vector part: three (w, x, z, -y).
 */

/** Minimal mutable 3-vector shape (THREE.Vector3 satisfies it). */
export interface XYZ {
  x: number
  y: number
  z: number
}

export function simToThree(out: XYZ, x: number, y: number, z: number): XYZ {
  out.x = x
  out.y = z
  out.z = -y
  return out
}

export function threeToSim(out: XYZ, X: number, Y: number, Z: number): XYZ {
  out.x = X
  out.y = -Z
  out.z = Y
  return out
}

/** Minimal mutable quaternion shape (THREE.Quaternion satisfies it). */
export interface WXYZ {
  w: number
  x: number
  y: number
  z: number
}

/** Sim quaternion [w, x, y, z] (body -> world) to a three.js quaternion. */
export function simQuatToThree(out: WXYZ, w: number, x: number, y: number, z: number): WXYZ {
  out.w = w
  out.x = x
  out.y = z
  out.z = -y
  return out
}

export const DEG = Math.PI / 180
export const RAD = 180 / Math.PI

/** Wrap an angle to (-pi, pi]. */
export function wrapPi(a: number): number {
  const TWO_PI = Math.PI * 2
  let r = a % TWO_PI
  if (r <= -Math.PI) r += TWO_PI
  else if (r > Math.PI) r -= TWO_PI
  return r
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
