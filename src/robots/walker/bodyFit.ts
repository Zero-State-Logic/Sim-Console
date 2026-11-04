import { quatToRotation } from './pose'

/* ============================================================
   BODY FIT — the rigid body pose (R, p) that best maps body-frame
   points b_i onto world points w_i in the least-squares sense:
   Horn (1987) closed form, the unit quaternion is the eigenvector
   of the largest eigenvalue of a 4×4 symmetric matrix (Jacobi).
   KINEMATIC mode rests the body on the planted stance feet that
   the actual (lagging, compliant) servo angles imply, so a servo
   that yields makes the body sink instead of a foot floating.
   Flat xyz arrays, module scratch, no allocation per call.
   ============================================================ */

export const FIT_NONE = 0
export const FIT_TRANSLATION = 1
export const FIT_RIGID = 2
export type FitKind = typeof FIT_NONE | typeof FIT_TRANSLATION | typeof FIT_RIGID

/** Second-moment ratio below which the points count as collinear (rotation about the line is free). */
const COLLINEAR = 1e-6
const JACOBI_SWEEPS = 24
const JACOBI_EPS = 1e-26

const A = new Float64Array(16)
const V = new Float64Array(16)
const quat = new Float64Array(4)
const mean = new Float64Array(6)

/** Centroids of the masked b and w points into `mean` [b̄, w̄]; returns the count. */
function centroids(b: Float64Array, w: Float64Array, mask: Uint8Array, n: number): number {
  mean.fill(0)
  let c = 0
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue
    for (let k = 0; k < 3; k++) {
      mean[k] += b[i * 3 + k]
      mean[3 + k] += w[i * 3 + k]
    }
    c++
  }
  if (c > 0) for (let k = 0; k < 6; k++) mean[k] /= c
  return c
}

/** True when the masked world points span at least a line's worth of a plane. */
function spread(w: Float64Array, mask: Uint8Array, n: number): boolean {
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue
    const x = w[i * 3] - mean[3]
    const y = w[i * 3 + 1] - mean[4]
    const z = w[i * 3 + 2] - mean[5]
    xx += x * x; yy += y * y; zz += z * z; xy += x * y; xz += x * z; yz += y * z
  }
  const trace = xx + yy + zz
  // sum of the 2×2 principal minors = λ1λ2 + λ1λ3 + λ2λ3: zero for rank ≤ 1
  const minors = xx * yy - xy * xy + xx * zz - xz * xz + yy * zz - yz * yz
  return trace > 1e-12 && minors > COLLINEAR * trace * trace
}

/** Horn's symmetric matrix from the cross-covariance S_ab = Σ b'_a w'_b. */
function hornMatrix(b: Float64Array, w: Float64Array, mask: Uint8Array, n: number): void {
  let sxx = 0, sxy = 0, sxz = 0, syx = 0, syy = 0, syz = 0, szx = 0, szy = 0, szz = 0
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue
    const bx = b[i * 3] - mean[0], by = b[i * 3 + 1] - mean[1], bz = b[i * 3 + 2] - mean[2]
    const wx = w[i * 3] - mean[3], wy = w[i * 3 + 1] - mean[4], wz = w[i * 3 + 2] - mean[5]
    sxx += bx * wx; sxy += bx * wy; sxz += bx * wz
    syx += by * wx; syy += by * wy; syz += by * wz
    szx += bz * wx; szy += bz * wy; szz += bz * wz
  }
  A[0] = sxx + syy + szz; A[1] = syz - szy; A[2] = szx - sxz; A[3] = sxy - syx
  A[5] = sxx - syy - szz; A[6] = sxy + syx; A[7] = szx + sxz
  A[10] = -sxx + syy - szz; A[11] = syz + szy
  A[15] = -sxx - syy + szz
  A[4] = A[1]; A[8] = A[2]; A[12] = A[3]; A[9] = A[6]; A[13] = A[7]; A[14] = A[11]
}

/** One Jacobi rotation zeroing A[p][r]; accumulates the eigenvectors in V's columns. */
function jacobiRotate(p: number, r: number): void {
  const apr = A[p * 4 + r]
  if (Math.abs(apr) < 1e-300) return
  const theta = (A[r * 5] - A[p * 5]) / (2 * apr)
  const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
  const c = 1 / Math.sqrt(t * t + 1)
  const s = t * c
  for (let k = 0; k < 4; k++) {
    const akp = A[k * 4 + p], akr = A[k * 4 + r]
    A[k * 4 + p] = c * akp - s * akr
    A[k * 4 + r] = s * akp + c * akr
  }
  for (let k = 0; k < 4; k++) {
    const apk = A[p * 4 + k], ark = A[r * 4 + k]
    A[p * 4 + k] = c * apk - s * ark
    A[r * 4 + k] = s * apk + c * ark
  }
  for (let k = 0; k < 4; k++) {
    const vkp = V[k * 4 + p], vkr = V[k * 4 + r]
    V[k * 4 + p] = c * vkp - s * vkr
    V[k * 4 + r] = s * vkp + c * vkr
  }
}

/** Unit eigenvector of the largest eigenvalue of the symmetric 4×4 in A (A is destroyed). */
export function largestEigenvector4(out: Float64Array): void {
  V.fill(0)
  V[0] = V[5] = V[10] = V[15] = 1
  let scale = 0
  for (let k = 0; k < 16; k++) scale += A[k] * A[k]
  for (let sweep = 0; sweep < JACOBI_SWEEPS; sweep++) {
    let off = 0
    for (let p = 0; p < 3; p++) for (let r = p + 1; r < 4; r++) off += A[p * 4 + r] * A[p * 4 + r]
    if (off <= JACOBI_EPS * (scale + 1e-300)) break
    for (let p = 0; p < 3; p++) for (let r = p + 1; r < 4; r++) jacobiRotate(p, r)
  }
  let m = 0
  for (let k = 1; k < 4; k++) if (A[k * 5] > A[m * 5]) m = k
  for (let k = 0; k < 4; k++) out[k] = V[k * 4 + m]
}

/** Load a symmetric 4×4 (row-major) into the eigen scratch (tests and callers outside the fit). */
export function loadSymmetric4(m: ArrayLike<number>): void {
  for (let k = 0; k < 16; k++) A[k] = m[k]
}

/**
 * Fit the masked body-frame points b onto the world points w. Writes the body pose to
 * pos / R (R row-major, world ← body). With fewer than three non-collinear points the
 * rotation is not determined, so `Rguess` is kept and only the translation is fitted.
 * Returns FIT_NONE (nothing written) when no point is masked.
 */
export function fitRigid(
  b: Float64Array,
  w: Float64Array,
  mask: Uint8Array,
  n: number,
  Rguess: Float64Array,
  pos: Float64Array,
  R: Float64Array,
): FitKind {
  const c = centroids(b, w, mask, n)
  if (c === 0) return FIT_NONE
  let kind: FitKind = FIT_TRANSLATION
  if (c >= 3 && spread(w, mask, n)) {
    hornMatrix(b, w, mask, n)
    largestEigenvector4(quat)
    quatToRotation(quat[1], quat[2], quat[3], quat[0], R)
    kind = FIT_RIGID
  } else if (R !== Rguess) {
    R.set(Rguess)
  }
  pos[0] = mean[3] - (R[0] * mean[0] + R[1] * mean[1] + R[2] * mean[2])
  pos[1] = mean[4] - (R[3] * mean[0] + R[4] * mean[1] + R[5] * mean[2])
  pos[2] = mean[5] - (R[6] * mean[0] + R[7] * mean[1] + R[8] * mean[2])
  return kind
}

/** Points closer than this to the support plane count as on it (numerical slack). */
const PLANE_EPS = 1e-9

/** Is (0, 0) inside triangle a-b-c in the xy plane (either winding)? */
function originInTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = ax * by - ay * bx
  const d2 = bx * cy - by * cx
  const d3 = cx * ay - cy * ax
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

/** Unit normal (z up) and offset of the plane through feet i, j, k into out [nx, ny, nz, d]; false if degenerate. */
function planeThrough(b: Float64Array, i: number, j: number, k: number, out: Float64Array): boolean {
  const ux = b[j * 3] - b[i * 3], uy = b[j * 3 + 1] - b[i * 3 + 1], uz = b[j * 3 + 2] - b[i * 3 + 2]
  const vx = b[k * 3] - b[i * 3], vy = b[k * 3 + 1] - b[i * 3 + 1], vz = b[k * 3 + 2] - b[i * 3 + 2]
  let nx = uy * vz - uz * vy
  let ny = uz * vx - ux * vz
  let nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz)
  if (len < 1e-12 || Math.abs(nz) < 1e-6 * len) return false
  const sgn = nz > 0 ? 1 / len : -1 / len
  nx *= sgn; ny *= sgn; nz *= sgn
  out[0] = nx
  out[1] = ny
  out[2] = nz
  out[3] = nx * b[i * 3] + ny * b[i * 3 + 1] + nz * b[i * 3 + 2]
  return true
}

/**
 * The ground plane a robot rests on, in its body frame: the face of the lower convex
 * hull of its feet that lies under the body origin (≈ the CoM). Every foot is on or
 * above it. Writes [nx, ny, nz, d] (unit normal pointing up into the body, n·p = d on
 * the plane, so the body origin is −d above it). False with fewer than three usable feet
 * or when the origin is not over any face (it would tip off its feet).
 */
export function supportPlane(b: Float64Array, n: number, out: Float64Array): boolean {
  for (let i = 0; i < n - 2; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      for (let k = j + 1; k < n; k++) {
        if (!planeThrough(b, i, j, k, out)) continue
        let below = false
        for (let m = 0; m < n && !below; m++) below = out[0] * b[m * 3] + out[1] * b[m * 3 + 1] + out[2] * b[m * 3 + 2] < out[3] - PLANE_EPS
        if (below) continue
        if (originInTriangle(b[i * 3], b[i * 3 + 1], b[j * 3], b[j * 3 + 1], b[k * 3], b[k * 3 + 1])) return true
      }
    }
  }
  return false
}

/**
 * Body rotation (world ← body, row-major) that turns the body-frame ground normal
 * (nx, ny, nz) to world up, then applies `yaw` about world up. Rodrigues about the
 * horizontal axis n × ẑ.
 */
export function levelOnPlane(nx: number, ny: number, nz: number, yaw: number, R: Float64Array): void {
  // axis a = n × ẑ = (ny, −nx, 0), sin θ = |a|, cos θ = nz
  const s = Math.hypot(nx, ny)
  const c = nz
  const ax = s > 1e-12 ? ny / s : 1
  const ay = s > 1e-12 ? -nx / s : 0
  const t = 1 - c
  // tilt matrix T (rotation about (ax, ay, 0) by θ)
  const t00 = c + ax * ax * t, t01 = ax * ay * t, t02 = ay * s
  const t10 = ax * ay * t, t11 = c + ay * ay * t, t12 = -ax * s
  const t20 = -ay * s, t21 = ax * s, t22 = c
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  R[0] = cy * t00 - sy * t10
  R[1] = cy * t01 - sy * t11
  R[2] = cy * t02 - sy * t12
  R[3] = sy * t00 + cy * t10
  R[4] = sy * t01 + cy * t11
  R[5] = sy * t02 + cy * t12
  R[6] = t20
  R[7] = t21
  R[8] = t22
}

/** World height of the lowest body-frame point b_i under rotation R, relative to the body origin. */
export function lowestPoint(b: Float64Array, n: number, R: Float64Array): number {
  let low = Infinity
  for (let i = 0; i < n; i++) {
    const z = R[6] * b[i * 3] + R[7] * b[i * 3 + 1] + R[8] * b[i * 3 + 2]
    if (z < low) low = z
  }
  return low
}
