/*
 * Reciprocal collision avoidance, ORCA-lite (after van den Berg et al., RVO2-3D).
 * For every neighbour pair the truncated velocity-obstacle cone gives the smallest
 * relative-velocity change u that leaves it; each moving agent takes half of u
 * (a static neighbour makes the mover take all of it), which defines a half-space
 * of allowed velocities. Instead of RVO2's exact 3-D linear program we project the
 * preferred velocity onto the violated half-spaces a few times (POCS), then clamp
 * the speed. A minimum-separation guard adds a direct push-apart on top.
 *
 * Arrays are flat: pos/vel/pref/out are 3·n (x, y, z per agent), mask is per agent:
 * 0 = ignored, 1 = moving (adjusts), 2 = static obstacle (does not adjust).
 */

export const AGENT_IGNORED = 0
export const AGENT_MOVING = 1
export const AGENT_STATIC = 2

export interface OrcaParams {
  /** Agent radius, m (combined radius is twice this). */
  radius: number
  /** Look-ahead horizon, s. */
  horizon: number
  /** Resolution step used when two agents already overlap, s. */
  timeStep: number
  maxSpeed: number
  iterations: number
}

export const DEFAULT_ORCA: Readonly<OrcaParams> = {
  radius: 0.3,
  horizon: 2,
  timeStep: 0.1,
  maxSpeed: 8,
  iterations: 8,
}

const MAX_PLANES = 16
const normals = new Float64Array(3 * MAX_PLANES)
const points = new Float64Array(3 * MAX_PLANES)
const u = new Float64Array(3)
const nrm = new Float64Array(3)

/**
 * Smallest relative-velocity change u (written to `u`) that takes the relative
 * velocity (rvx, rvy, rvz) out of the truncated VO of the relative position
 * (px, py, pz), combined radius r and horizon tau, plus the outward unit normal
 * of the VO boundary at the nearest point. When the relative velocity is already
 * outside the VO, u points inward (negative along the normal) and the half-space
 * it defines does not bind the current velocity.
 */
export function orcaU(
  out: Float64Array,
  normal: Float64Array,
  px: number, py: number, pz: number,
  rvx: number, rvy: number, rvz: number,
  r: number, tau: number, dt: number,
): void {
  const distSq = px * px + py * py + pz * pz
  const rSq = r * r
  let wx: number, wy: number, wz: number, scale: number
  if (distSq > rSq) {
    wx = rvx - px / tau
    wy = rvy - py / tau
    wz = rvz - pz / tau
    const wLenSq = wx * wx + wy * wy + wz * wz
    const dot = wx * px + wy * py + wz * pz
    if (dot < 0 && dot * dot > rSq * wLenSq) {
      // nearest boundary point is on the cut-off sphere
      scale = r / tau
    } else {
      // nearest boundary point is on the cone's side
      const b = px * rvx + py * rvy + pz * rvz
      const cx = py * rvz - pz * rvy, cy = pz * rvx - px * rvz, cz = px * rvy - py * rvx
      const c = rvx * rvx + rvy * rvy + rvz * rvz - (cx * cx + cy * cy + cz * cz) / (distSq - rSq)
      const t = (b + Math.sqrt(Math.max(0, b * b - distSq * c))) / distSq
      wx = rvx - t * px
      wy = rvy - t * py
      wz = rvz - t * pz
      scale = r * t
    }
  } else {
    // already overlapping: resolve within one time step
    wx = rvx - px / dt
    wy = rvy - py / dt
    wz = rvz - pz / dt
    scale = r / dt
  }
  let len = Math.sqrt(wx * wx + wy * wy + wz * wz)
  let mag = scale - len
  if (len < 1e-9) {
    // exactly head-on: both agents break the tie by keeping right
    wx = py
    wy = -px
    wz = 0
    len = Math.hypot(wx, wy)
    if (len < 1e-9) { wx = 1; wy = 0; len = 1 }
    mag = scale
  }
  normal[0] = wx / len
  normal[1] = wy / len
  normal[2] = wz / len
  out[0] = mag * normal[0]
  out[1] = mag * normal[1]
  out[2] = mag * normal[2]
}

/** ORCA-lite: writes collision-free velocities into out for every moving agent. */
export function orcaVelocities(
  out: Float64Array,
  pos: Float64Array,
  vel: Float64Array,
  pref: Float64Array,
  mask: ArrayLike<number>,
  n: number,
  prm: OrcaParams = DEFAULT_ORCA,
): void {
  const r = 2 * prm.radius
  const reach = (prm.horizon * 2 * prm.maxSpeed + r) ** 2
  for (let i = 0; i < n; i++) {
    const i3 = 3 * i
    out[i3] = pref[i3]
    out[i3 + 1] = pref[i3 + 1]
    out[i3 + 2] = pref[i3 + 2]
    if (mask[i] !== AGENT_MOVING) continue
    let planes = 0
    for (let j = 0; j < n && planes < MAX_PLANES; j++) {
      if (j === i || mask[j] === AGENT_IGNORED) continue
      const j3 = 3 * j
      const px = pos[j3] - pos[i3], py = pos[j3 + 1] - pos[i3 + 1], pz = pos[j3 + 2] - pos[i3 + 2]
      if (px * px + py * py + pz * pz > reach) continue
      orcaU(u, nrm, px, py, pz, vel[i3] - vel[j3], vel[i3 + 1] - vel[j3 + 1], vel[i3 + 2] - vel[j3 + 2], r, prm.horizon, prm.timeStep)
      keepRight(out, i3, px, py, pz, vel[i3] - vel[j3], vel[i3 + 1] - vel[j3 + 1], vel[i3 + 2] - vel[j3 + 2], r, prm.horizon)
      const share = mask[j] === AGENT_STATIC ? 1 : 0.5
      const p3 = 3 * planes
      for (let a = 0; a < 3; a++) {
        normals[p3 + a] = nrm[a]
        points[p3 + a] = vel[i3 + a] + share * u[a]
      }
      planes++
    }
    project(out, i3, planes, prm)
  }
}

/**
 * Symmetry breaking. A perfectly head-on pair sits on the VO axis, where ORCA's
 * nearest exit is straight back: both brake to a standstill (the classic
 * reciprocal deadlock). RVO2's demos jitter the preferred velocity randomly; we
 * bias it deterministically to the right of the line of approach instead, so
 * replays stay reproducible and both agents pick opposite sides.
 */
function keepRight(
  out: Float64Array, i3: number,
  px: number, py: number, pz: number,
  rvx: number, rvy: number, rvz: number,
  r: number, horizon: number,
): void {
  const dist = Math.sqrt(px * px + py * py + pz * pz)
  if (dist < 1e-9) return
  const closing = (rvx * px + rvy * py + rvz * pz) / dist
  if (closing < 0.05 || dist > closing * horizon * 2 + r) return
  const cx = py * rvz - pz * rvy, cy = pz * rvx - px * rvz, cz = px * rvy - py * rvx
  const lateral = Math.sqrt(cx * cx + cy * cy + cz * cz) / dist
  if (lateral > 0.25 * closing) return
  const h = Math.hypot(px, py)
  if (h < 1e-9) return
  const bias = 0.35 * closing
  out[i3] += (bias * py) / h
  out[i3 + 1] -= (bias * px) / h
}

/** Alternating projection of out[i3..] onto the planes' half-spaces, then a speed clamp. */
function project(out: Float64Array, i3: number, planes: number, prm: OrcaParams): void {
  for (let it = 0; it < prm.iterations; it++) {
    let moved = false
    for (let k = 0; k < planes; k++) {
      const k3 = 3 * k
      const d =
        (out[i3] - points[k3]) * normals[k3] +
        (out[i3 + 1] - points[k3 + 1]) * normals[k3 + 1] +
        (out[i3 + 2] - points[k3 + 2]) * normals[k3 + 2]
      if (d >= 0) continue
      out[i3] -= d * normals[k3]
      out[i3 + 1] -= d * normals[k3 + 1]
      out[i3 + 2] -= d * normals[k3 + 2]
      moved = true
    }
    const sp = Math.hypot(out[i3], out[i3 + 1], out[i3 + 2])
    if (sp > prm.maxSpeed) {
      const k = prm.maxSpeed / sp
      out[i3] *= k
      out[i3 + 1] *= k
      out[i3 + 2] *= k
    }
    if (!moved) break
  }
}

/**
 * Minimum-separation guard: pairs closer than dMin get a push-apart velocity that
 * grows linearly to `gain` m/s at contact. Returns the minimum pairwise distance.
 */
export function separationGuard(
  out: Float64Array,
  pos: Float64Array,
  mask: ArrayLike<number>,
  n: number,
  dMin: number,
  gain: number,
): number {
  let minD = Infinity
  for (let i = 0; i < n; i++) {
    if (mask[i] === AGENT_IGNORED) continue
    for (let j = i + 1; j < n; j++) {
      if (mask[j] === AGENT_IGNORED) continue
      const i3 = 3 * i, j3 = 3 * j
      const dx = pos[i3] - pos[j3], dy = pos[i3 + 1] - pos[j3 + 1], dz = pos[i3 + 2] - pos[j3 + 2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d < minD) minD = d
      if (d >= dMin || d < 1e-6) continue
      const push = (gain * (dMin - d)) / dMin / d
      if (mask[i] === AGENT_MOVING) {
        out[i3] += push * dx
        out[i3 + 1] += push * dy
        out[i3 + 2] += push * dz
      }
      if (mask[j] === AGENT_MOVING) {
        out[j3] -= push * dx
        out[j3 + 1] -= push * dy
        out[j3 + 2] -= push * dz
      }
    }
  }
  return minD
}
