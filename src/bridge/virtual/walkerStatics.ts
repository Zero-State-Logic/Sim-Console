import type { WalkerGeom } from '../../codegen/walkerGeom'
import { clamp } from './common'

/* ============================================================
   VIRTUAL WALKER STATICS — what the IMU and the leg load cells of
   the virtual walker read, derived from its actual (lagging) joint
   angles, so HARDWARE telemetry stays physically consistent with
   the pose the servos really reached. Quasi-static rigid body on
   flat ground, CoM at the body origin (leg mass neglected), no slip.

   1. Forward kinematics: foot of each leg in the REP-103 body frame
        ρ = L1 + L2·cos α + L3·sin(α + β),  z = L2·sin α − L3·cos(α + β)
   2. Ground = the facet of the feet's lower convex hull that the
      CoM's gravity line passes through: a plane through three feet
      with no foot below it and the CoM projected (along the plane
      normal) inside their triangle. Feet within SWING_TOL of it are
      planted. A CoM outside the planted triangle therefore tips the
      body onto the next feet, like a real robot; between two such
      equilibria it falls the way gravity pulled from the last pose.
   3. Tilt, REP-103 ZYX: the ground normal seen from the body is
      u = Rᵀ·ẑ = (−sin θ, cos θ·sin φ, cos θ·cos φ), so
        roll φ = atan2(u_y, u_z),  pitch θ = atan2(−u_x, √(u_y² + u_z²))
   4. Loads: planted feet rotated into the level frame; the minimum-
      norm vertical forces with Σf = W and zero moment about the CoM,
      f_i = 1/n + β·(x_i − x̄) + γ·(y_i − ȳ). A negative force means
      that foot would pull: drop it and re-solve.
   5. Yaw: planted feet are fixed in the world, so between samples
      they turn by −Δψ in the body frame (2D Kabsch).
   ============================================================ */

const RAD = Math.PI / 180
/** A foot within this of the ground plane is planted, m. */
export const SWING_TOL = 0.002
/** Numerical slack for "no foot below the ground" and "inside the triangle", m. */
const CONTACT_EPS = 1e-6
/** 2×2 systems with det below this fraction of trace² are singular (collinear feet). */
const SINGULAR = 1e-6

/**
 * Minimum-norm non-negative vertical loads (fractions of the weight, Σ = 1) for the
 * feet in `mask`, CoM at the origin of the level frame (lx, ly). Feet that would pull
 * are dropped (active set). `mask` is modified; returns false when no foot is set.
 */
export function distributeLoads(lx: ArrayLike<number>, ly: ArrayLike<number>, mask: Uint8Array, out: Float64Array): boolean {
  for (let pass = 0; pass <= mask.length; pass++) {
    if (!solveLoads(lx, ly, mask, out)) return false
    let worst = -1
    for (let i = 0; i < mask.length; i++) if (mask[i] && out[i] < 0 && (worst < 0 || out[i] < out[worst])) worst = i
    if (worst < 0) return true
    mask[worst] = 0
  }
  return true
}

function solveLoads(lx: ArrayLike<number>, ly: ArrayLike<number>, mask: Uint8Array, out: Float64Array): boolean {
  out.fill(0)
  let n = 0
  let mx = 0
  let my = 0
  let first = -1
  let last = -1
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    if (first < 0) first = i
    last = i
    n++
    mx += lx[i]
    my += ly[i]
  }
  if (n === 0) return false
  if (n === 1) {
    out[first] = 1
    return true
  }
  mx /= n
  my /= n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const dx = lx[i] - mx
    const dy = ly[i] - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  const det = sxx * syy - sxy * sxy
  if (n === 2 || !(det > SINGULAR * (sxx + syy) * (sxx + syy))) return leverLoads(lx, ly, first, last, out)
  // zero moment about the CoM (origin): β·Sxx + γ·Sxy = −x̄,  β·Sxy + γ·Syy = −ȳ
  const beta = (-mx * syy + my * sxy) / det
  const gamma = (-my * sxx + mx * sxy) / det
  for (let i = 0; i < mask.length; i++) if (mask[i]) out[i] = 1 / n + beta * (lx[i] - mx) + gamma * (ly[i] - my)
  return true
}

/** Two feet (or a line of them): split by where the CoM projects onto the line between the end feet. */
function leverLoads(lx: ArrayLike<number>, ly: ArrayLike<number>, a: number, b: number, out: Float64Array): boolean {
  const dx = lx[b] - lx[a]
  const dy = ly[b] - ly[a]
  const dd = dx * dx + dy * dy
  const t = dd > 1e-12 ? clamp(-(lx[a] * dx + ly[a] * dy) / dd, 0, 1) : 0.5
  out.fill(0)
  out[a] = 1 - t
  out[b] = t
  return true
}

export class WalkerStatics {
  readonly legs: number
  /** Feet in the body frame, [x, y, z] per leg, m. */
  readonly feet: Float64Array
  /** 1 = foot on the ground. */
  readonly stance: Uint8Array
  /** Vertical load per leg as a fraction of the robot's weight (Σ = 1). */
  readonly load: Float64Array
  /** Ground normal in the body frame (unit, pointing from the ground to the body). */
  readonly normal = new Float64Array([0, 0, 1])
  /** REP-103 attitude, rad. */
  roll = 0
  pitch = 0
  yaw = 0
  /** False when no hull facet holds the CoM (belly down or collinear feet): tilt held. */
  supported = false
  private readonly cosM: Float64Array
  private readonly sinM: Float64Array
  private readonly lx: Float64Array
  private readonly ly: Float64Array
  private readonly prevX: Float64Array
  private readonly prevY: Float64Array
  private readonly prevStance: Uint8Array
  private readonly mask: Uint8Array
  /** Ground normal of the last supported pose (gravity's direction before this update). */
  private readonly prevNormal = new Float64Array([0, 0, 1])
  private readonly cand = new Float64Array(3)
  private hasPrev = false

  constructor(private readonly geom: WalkerGeom) {
    const n = geom.legs
    this.legs = n
    this.feet = new Float64Array(3 * n)
    this.stance = new Uint8Array(n)
    this.load = new Float64Array(n)
    this.cosM = Float64Array.from(geom.mountYawDeg, (d) => Math.cos(d * RAD))
    this.sinM = Float64Array.from(geom.mountYawDeg, (d) => Math.sin(d * RAD))
    this.lx = new Float64Array(n)
    this.ly = new Float64Array(n)
    this.prevX = new Float64Array(n)
    this.prevY = new Float64Array(n)
    this.prevStance = new Uint8Array(n)
    this.mask = new Uint8Array(n)
  }

  /** Re-derive feet, stance, tilt, loads and yaw from joint angles (degrees, leg-major). */
  update(qDeg: ArrayLike<number>): void {
    this.forward(qDeg)
    this.supported = this.findSupport()
    if (this.supported) {
      const u = this.normal
      this.roll = Math.atan2(u[1], u[2])
      this.pitch = Math.atan2(-u[0], Math.hypot(u[1], u[2]))
    } else {
      this.lowestStance()
    }
    this.levelFeet()
    this.mask.set(this.stance)
    if (!distributeLoads(this.lx, this.ly, this.mask, this.load)) this.load.fill(0)
    this.trackYaw()
  }

  /** Forget the yaw reference (re-flash, home). */
  resetYaw(): void {
    this.yaw = 0
    this.hasPrev = false
  }

  private forward(q: ArrayLike<number>): void {
    const g = this.geom
    for (let i = 0; i < this.legs; i++) {
      const c = q[3 * i] * RAD
      const a = q[3 * i + 1] * RAD
      const ab = a + q[3 * i + 2] * RAD
      const rho = g.coxa + g.femur * Math.cos(a) + g.tibia * Math.sin(ab)
      const fx = rho * Math.cos(c)
      const fy = rho * Math.sin(c)
      this.feet[3 * i] = g.mountX[i] + this.cosM[i] * fx - this.sinM[i] * fy
      this.feet[3 * i + 1] = g.mountY[i] + this.sinM[i] * fx + this.cosM[i] * fy
      this.feet[3 * i + 2] = g.femur * Math.sin(a) - g.tibia * Math.cos(ab)
    }
  }

  /**
   * Search the hull facets (feet triples) for static equilibria. A high CoM can rest on
   * either side of a knife edge (a trot diagonal), so the body falls the way gravity pulls
   * from its previous attitude: prefer the facet that holds the CoM's projection along the
   * previous ground normal, then the smallest attitude change. On success `normal` and
   * `stance` describe the ground.
   */
  private findSupport(): boolean {
    const n = this.legs
    let best = -Infinity
    let anchor = -1
    for (let i = 0; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        for (let k = j + 1; k < n; k++) {
          const score = this.scoreFacet(i, j, k)
          if (score <= best) continue
          best = score
          anchor = i
          this.normal.set(this.cand)
        }
      }
    }
    if (anchor < 0) return false
    const f = this.feet
    const u = this.normal
    for (let m = 0; m < this.legs; m++) {
      const d = u[0] * (f[3 * m] - f[3 * anchor]) + u[1] * (f[3 * m + 1] - f[3 * anchor + 1]) + u[2] * (f[3 * m + 2] - f[3 * anchor + 2])
      this.stance[m] = d <= SWING_TOL ? 1 : 0
    }
    this.prevNormal.set(u)
    return true
  }

  /** −Infinity when feet i, j, k are not an equilibrium facet; else a preference score (normal in `cand`). */
  private scoreFacet(i: number, j: number, k: number): number {
    const f = this.feet
    const ax = f[3 * i]
    const ay = f[3 * i + 1]
    const az = f[3 * i + 2]
    const ux = f[3 * j] - ax
    const uy = f[3 * j + 1] - ay
    const uz = f[3 * j + 2] - az
    const vx = f[3 * k] - ax
    const vy = f[3 * k + 1] - ay
    const vz = f[3 * k + 2] - az
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len < 1e-9) return -Infinity
    nx /= len
    ny /= len
    nz /= len
    // orient the normal toward the body (the origin sits above the ground)
    let s = -(nx * ax + ny * ay + nz * az)
    if (s < 0) {
      nx = -nx
      ny = -ny
      nz = -nz
      s = -s
    }
    for (let m = 0; m < this.legs; m++) {
      const d = nx * (f[3 * m] - ax) + ny * (f[3 * m + 1] - ay) + nz * (f[3 * m + 2] - az)
      if (d < -CONTACT_EPS) return -Infinity
    }
    // equilibrium: the CoM projected along −normal lands inside the triangle
    if (!this.inTriangle(i, j, k, -s * nx, -s * ny, -s * nz, nx, ny, nz)) return -Infinity
    this.cand[0] = nx
    this.cand[1] = ny
    this.cand[2] = nz
    const p = this.prevNormal
    const dot = nx * p[0] + ny * p[1] + nz * p[2]
    // where the previous gravity line meets this plane: is that inside too?
    const t = dot > 1e-6 ? s / dot : -1
    const reached = t > 0 && this.inTriangle(i, j, k, -t * p[0], -t * p[1], -t * p[2], nx, ny, nz)
    return (reached ? 2 : 0) + dot
  }

  /** Point p (on the plane with normal n) inside triangle a, b, c of the feet, edges included. */
  private inTriangle(a: number, b: number, c: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number): boolean {
    const s1 = this.edgeSide(a, b, px, py, pz, nx, ny, nz)
    const s2 = this.edgeSide(b, c, px, py, pz, nx, ny, nz)
    const s3 = this.edgeSide(c, a, px, py, pz, nx, ny, nz)
    // same side of every edge (0 = on the edge) = inside
    return !((s1 > 0 || s2 > 0 || s3 > 0) && (s1 < 0 || s2 < 0 || s3 < 0))
  }

  /** Sign of (edge p→q × (point − p)) · n, 0 within tolerance. */
  private edgeSide(p: number, q: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number): number {
    const f = this.feet
    const ex = f[3 * q] - f[3 * p]
    const ey = f[3 * q + 1] - f[3 * p + 1]
    const ez = f[3 * q + 2] - f[3 * p + 2]
    const wx = px - f[3 * p]
    const wy = py - f[3 * p + 1]
    const wz = pz - f[3 * p + 2]
    const side = (ey * wz - ez * wy) * nx + (ez * wx - ex * wz) * ny + (ex * wy - ey * wx) * nz
    return Math.abs(side) <= CONTACT_EPS * Math.hypot(ex, ey, ez) ? 0 : side > 0 ? 1 : -1
  }

  /** No facet holds the CoM: the lowest feet (body frame) carry the robot, tilt held. */
  private lowestStance(): void {
    let lo = Infinity
    for (let i = 0; i < this.legs; i++) lo = Math.min(lo, this.feet[3 * i + 2])
    for (let i = 0; i < this.legs; i++) this.stance[i] = this.feet[3 * i + 2] - lo <= SWING_TOL ? 1 : 0
  }

  /** Feet rotated by the tilt into the level frame (x, y horizontal; CoM at the origin). */
  private levelFeet(): void {
    const cr = Math.cos(this.roll)
    const sr = Math.sin(this.roll)
    const cp = Math.cos(this.pitch)
    const sp = Math.sin(this.pitch)
    for (let i = 0; i < this.legs; i++) {
      const x = this.feet[3 * i]
      const y = this.feet[3 * i + 1]
      const z = this.feet[3 * i + 2]
      // p_level = Ry(θ)·Rx(φ)·p_body
      const z1 = y * sr + z * cr
      this.lx[i] = x * cp + z1 * sp
      this.ly[i] = y * cr - z * sr
    }
  }

  private trackYaw(): void {
    const { lx, ly, prevX, prevY, prevStance, stance } = this
    if (this.hasPrev) {
      let n = 0
      let cx = 0
      let cy = 0
      let px = 0
      let py = 0
      for (let i = 0; i < this.legs; i++) {
        if (!stance[i] || !prevStance[i]) continue
        n++
        cx += lx[i]
        cy += ly[i]
        px += prevX[i]
        py += prevY[i]
      }
      if (n >= 2) {
        cx /= n
        cy /= n
        px /= n
        py /= n
        let cross = 0
        let dot = 0
        for (let i = 0; i < this.legs; i++) {
          if (!stance[i] || !prevStance[i]) continue
          const ax = prevX[i] - px
          const ay = prevY[i] - py
          const bx = lx[i] - cx
          const by = ly[i] - cy
          cross += ax * by - ay * bx
          dot += ax * bx + ay * by
        }
        // planted feet turn by −Δψ in the body frame
        if (dot > 0) this.yaw = wrapRad(this.yaw - Math.atan2(cross, dot))
      }
    }
    prevX.set(lx)
    prevY.set(ly)
    prevStance.set(stance)
    this.hasPrev = true
  }
}

function wrapRad(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a))
}
