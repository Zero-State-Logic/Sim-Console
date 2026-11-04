/*
 * Quaternion helpers on flat number arrays, layout [w, x, y, z] at an offset.
 * Hamilton convention, body -> world. Allocation-free: callers pass the output.
 */

type Arr = Float64Array | number[]

/** out = a ⊗ b (out may alias neither input). */
export function quatMul(out: Arr, a: Arr, b: Arr): Arr {
  const aw = a[0], ax = a[1], ay = a[2], az = a[3]
  const bw = b[0], bx = b[1], by = b[2], bz = b[3]
  out[0] = aw * bw - ax * bx - ay * by - az * bz
  out[1] = aw * bx + ax * bw + ay * bz - az * by
  out[2] = aw * by - ax * bz + ay * bw + az * bx
  out[3] = aw * bz + ax * by - ay * bx + az * bw
  return out
}

/** Normalize the quaternion stored at s[o..o+3] in place. Returns the norm before. */
export function quatNormalizeAt(s: Arr, o: number): number {
  const n = Math.hypot(s[o], s[o + 1], s[o + 2], s[o + 3])
  if (n < 1e-12) {
    s[o] = 1
    s[o + 1] = 0
    s[o + 2] = 0
    s[o + 3] = 0
    return n
  }
  const inv = 1 / n
  s[o] *= inv
  s[o + 1] *= inv
  s[o + 2] *= inv
  s[o + 3] *= inv
  return n
}

/**
 * ZYX (yaw-pitch-roll) Euler angles, radians, from the quaternion at s[o..o+3].
 * REP-103: roll about x (forward), pitch about y (left, + = nose down), yaw about z (up, + = CCW).
 */
export function quatToEuler(out: Arr, s: Arr, o: number): Arr {
  const w = s[o], x = s[o + 1], y = s[o + 2], z = s[o + 3]
  out[0] = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
  const sp = 2 * (w * y - z * x)
  out[1] = Math.abs(sp) >= 1 ? Math.sign(sp) * (Math.PI / 2) : Math.asin(sp)
  out[2] = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
  return out
}

/** Quaternion from ZYX Euler angles (radians), written to out[o..o+3]. */
export function eulerToQuat(out: Arr, o: number, roll: number, pitch: number, yaw: number): Arr {
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2)
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2)
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2)
  out[o] = cr * cp * cy + sr * sp * sy
  out[o + 1] = sr * cp * cy - cr * sp * sy
  out[o + 2] = cr * sp * cy + sr * cp * sy
  out[o + 3] = cr * cp * sy - sr * sp * cy
  return out
}

/** Yaw (rad) of the quaternion at s[o..o+3]. */
export function quatYaw(s: Arr, o: number): number {
  const w = s[o], x = s[o + 1], y = s[o + 2], z = s[o + 3]
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
}

/** Cosine of the tilt angle (body z vs world z) = R[2][2]. */
export function quatCosTilt(s: Arr, o: number): number {
  const x = s[o + 1], y = s[o + 2]
  return 1 - 2 * (x * x + y * y)
}

/**
 * Quaternion from a rotation matrix given by its three columns (b1, b2, b3), each a
 * world-frame unit vector. Shepperd's method, numerically safe for all rotations.
 */
export function quatFromColumns(out: Arr, b1: Arr, b2: Arr, b3: Arr): Arr {
  const m00 = b1[0], m10 = b1[1], m20 = b1[2]
  const m01 = b2[0], m11 = b2[1], m21 = b2[2]
  const m02 = b3[0], m12 = b3[1], m22 = b3[2]
  const tr = m00 + m11 + m22
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    out[0] = 0.25 * s
    out[1] = (m21 - m12) / s
    out[2] = (m02 - m20) / s
    out[3] = (m10 - m01) / s
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    out[0] = (m21 - m12) / s
    out[1] = 0.25 * s
    out[2] = (m01 + m10) / s
    out[3] = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    out[0] = (m02 - m20) / s
    out[1] = (m01 + m10) / s
    out[2] = 0.25 * s
    out[3] = (m12 + m21) / s
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    out[0] = (m10 - m01) / s
    out[1] = (m02 + m20) / s
    out[2] = (m12 + m21) / s
    out[3] = 0.25 * s
  }
  return out
}
