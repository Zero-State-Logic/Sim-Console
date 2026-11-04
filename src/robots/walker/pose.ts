/* ============================================================
   RIGID TRANSFORMS — row-major 3×3 rotations in flat arrays.
   World frame is REP-103-like: x, y on the ground, z up.
   Body rotation R = Rz(yaw) · Ry(pitch) · Rx(roll).
   ============================================================ */

export function rotationZYX(yaw: number, pitch: number, roll: number, R: Float64Array): void {
  const cy = Math.cos(yaw), sy = Math.sin(yaw)
  const cp = Math.cos(pitch), sp = Math.sin(pitch)
  const cr = Math.cos(roll), sr = Math.sin(roll)
  R[0] = cy * cp
  R[1] = cy * sp * sr - sy * cr
  R[2] = cy * sp * cr + sy * sr
  R[3] = sy * cp
  R[4] = sy * sp * sr + cy * cr
  R[5] = sy * sp * cr - cy * sr
  R[6] = -sp
  R[7] = cp * sr
  R[8] = cp * cr
}

/** out = Rᵀ · (p − pos): a world point in the body frame. */
export function worldToBody(pos: Float64Array, R: Float64Array, wx: number, wy: number, wz: number, out: Float64Array, o: number): void {
  const dx = wx - pos[0]
  const dy = wy - pos[1]
  const dz = wz - pos[2]
  out[o] = R[0] * dx + R[3] * dy + R[6] * dz
  out[o + 1] = R[1] * dx + R[4] * dy + R[7] * dz
  out[o + 2] = R[2] * dx + R[5] * dy + R[8] * dz
}

/** out = pos + R · b: a body point in the world frame. */
export function bodyToWorld(pos: Float64Array, R: Float64Array, bx: number, by: number, bz: number, out: Float64Array, o: number): void {
  out[o] = pos[0] + R[0] * bx + R[1] * by + R[2] * bz
  out[o + 1] = pos[1] + R[3] * bx + R[4] * by + R[5] * bz
  out[o + 2] = pos[2] + R[6] * bx + R[7] * by + R[8] * bz
}

/** Roll, pitch, yaw (radians) of R = Rz·Ry·Rx, written to out[0..2]. */
export function rpyFromRotation(R: Float64Array, out: Float64Array): void {
  out[0] = Math.atan2(R[7], R[8])
  out[1] = Math.asin(Math.max(-1, Math.min(1, -R[6])))
  out[2] = Math.atan2(R[3], R[0])
}

/** Unit quaternion (x, y, z, w) → rotation matrix. */
export function quatToRotation(x: number, y: number, z: number, w: number, R: Float64Array): void {
  R[0] = 1 - 2 * (y * y + z * z)
  R[1] = 2 * (x * y - z * w)
  R[2] = 2 * (x * z + y * w)
  R[3] = 2 * (x * y + z * w)
  R[4] = 1 - 2 * (x * x + z * z)
  R[5] = 2 * (y * z - x * w)
  R[6] = 2 * (x * z - y * w)
  R[7] = 2 * (y * z + x * w)
  R[8] = 1 - 2 * (x * x + y * y)
}

/** Rotation matrix → unit quaternion (x, y, z, w) in out[0..3] (Shepperd's method). */
export function rotationToQuat(R: Float64Array, out: Float64Array): void {
  const tr = R[0] + R[4] + R[8]
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    out[3] = 0.25 * s
    out[0] = (R[7] - R[5]) / s
    out[1] = (R[2] - R[6]) / s
    out[2] = (R[3] - R[1]) / s
  } else if (R[0] > R[4] && R[0] > R[8]) {
    const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2
    out[3] = (R[7] - R[5]) / s
    out[0] = 0.25 * s
    out[1] = (R[1] + R[3]) / s
    out[2] = (R[2] + R[6]) / s
  } else if (R[4] > R[8]) {
    const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2
    out[3] = (R[2] - R[6]) / s
    out[0] = (R[1] + R[3]) / s
    out[1] = 0.25 * s
    out[2] = (R[5] + R[7]) / s
  } else {
    const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2
    out[3] = (R[3] - R[1]) / s
    out[0] = (R[2] + R[6]) / s
    out[1] = (R[5] + R[7]) / s
    out[2] = 0.25 * s
  }
}

/** Wrap an angle to (−π, π]. */
export function wrapAngle(a: number): number {
  const t = a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI))
  return t <= -Math.PI ? t + 2 * Math.PI : t
}
