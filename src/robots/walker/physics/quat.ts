/* Small tuple quaternion helpers for spawning bodies (not on the per-frame path). */

export type Vec3 = [number, number, number]
/** Unit quaternion [x, y, z, w]. */
export type Quat = [number, number, number, number]

export function axisQuat(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2)
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]
}

/** Hamilton product a·b (apply b first, then a). */
export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

export function rotateByQuat(q: Quat, v: Vec3): Vec3 {
  // v' = v + 2w(u×v) + 2u×(u×v)
  const [x, y, z, w] = q
  const cx = y * v[2] - z * v[1]
  const cy = z * v[0] - x * v[2]
  const cz = x * v[1] - y * v[0]
  return [
    v[0] + 2 * (w * cx + y * cz - z * cy),
    v[1] + 2 * (w * cy + z * cx - x * cz),
    v[2] + 2 * (w * cz + x * cy - y * cx),
  ]
}

export function addVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
