import type { WalkerDims } from './geometry'

/* ============================================================
   3-DOF LEG KINEMATICS (coxa yaw, femur pitch, tibia pitch).
   Leg frame: origin on the coxa axis, x radial along the mount yaw,
   y tangential (CCW), z up. Joint convention (see HardwareSpec):
     coxa  γ  + = CCW seen from above (0 = straight out)
     femur α  + = up                  (0 = horizontal)
     tibia β  + = foot out            (0 = perpendicular to the femur,
                                       i.e. vertical when α = 0)
   Knee interior angle = 90° + β. The IK picks the knee-up solution.
   Foot (tip) in the leg plane:
     ρ = L1 + L2 cos α + L3 sin(α + β)
     z =      L2 sin α − L3 cos(α + β)
   ============================================================ */

const DEG = Math.PI / 180

/** Joint limits, degrees: [coxa, femur, tibia]. Same for every leg. */
export const JOINT_LIMITS_DEG: readonly (readonly [number, number])[] = [
  [-70, 70],
  [-85, 85],
  [-80, 80],
]

export const JOINT_MIN = new Float64Array(JOINT_LIMITS_DEG.map((l) => l[0] * DEG))
export const JOINT_MAX = new Float64Array(JOINT_LIMITS_DEG.map((l) => l[1] * DEG))

/** IK status bits. */
export const IK_OK = 0
export const IK_OUT_OF_REACH = 1
export const IK_JOINT_LIMIT = 2

/** Small margin kept from the singular fully-stretched / fully-folded configurations. */
const REACH_EPS = 1e-4

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Inverse kinematics for one leg. Writes [γ, α, β] (radians) to out[o..o+2].
 * Out-of-reach targets are clamped onto the workspace boundary along the same
 * direction, then joints are clamped to their limits. Returns a status bit mask.
 */
export function legIK(d: WalkerDims, x: number, y: number, z: number, out: Float64Array, o: number): number {
  let status = IK_OK
  const gamma = Math.atan2(y, x)
  const rho = Math.hypot(x, y)
  let u = rho - d.coxa
  let v = z
  let D = Math.hypot(u, v)
  const dMin = Math.abs(d.femur - d.tibia) + REACH_EPS
  const dMax = d.femur + d.tibia - REACH_EPS
  if (D < 1e-9) {
    u = dMin
    v = 0
    D = dMin
    status |= IK_OUT_OF_REACH
  } else if (D < dMin || D > dMax) {
    const k = clamp(D, dMin, dMax) / D
    u *= k
    v *= k
    D = clamp(D, dMin, dMax)
    status |= IK_OUT_OF_REACH
  }
  const L2 = d.femur
  const L3 = d.tibia
  const psi = Math.acos(clamp((L2 * L2 + D * D - L3 * L3) / (2 * L2 * D), -1, 1))
  const knee = Math.acos(clamp((L2 * L2 + L3 * L3 - D * D) / (2 * L2 * L3), -1, 1))
  status |= writeClamped(out, o, 0, gamma)
  status |= writeClamped(out, o, 1, Math.atan2(v, u) + psi)
  status |= writeClamped(out, o, 2, knee - Math.PI / 2)
  return status
}

function writeClamped(out: Float64Array, o: number, j: number, v: number): number {
  const c = clamp(v, JOINT_MIN[j], JOINT_MAX[j])
  out[o + j] = c
  return c === v ? IK_OK : IK_JOINT_LIMIT
}

/** Forward kinematics: foot tip in the leg frame, written to out[o..o+2]. */
export function legFK(d: WalkerDims, q: Float64Array, qo: number, out: Float64Array, o: number): void {
  const g = q[qo]
  const a = q[qo + 1]
  const ab = a + q[qo + 2]
  const rho = d.coxa + d.femur * Math.cos(a) + d.tibia * Math.sin(ab)
  out[o] = rho * Math.cos(g)
  out[o + 1] = rho * Math.sin(g)
  out[o + 2] = d.femur * Math.sin(a) - d.tibia * Math.cos(ab)
}

/** Knee (tibia joint) position in the leg frame. */
export function kneeFK(d: WalkerDims, q: Float64Array, qo: number, out: Float64Array, o: number): void {
  const g = q[qo]
  const a = q[qo + 1]
  const rho = d.coxa + d.femur * Math.cos(a)
  out[o] = rho * Math.cos(g)
  out[o + 1] = rho * Math.sin(g)
  out[o + 2] = d.femur * Math.sin(a)
}

/**
 * Foot Jacobian ∂p/∂q in the leg frame, row-major 3×3 into out[0..8]:
 * row r = coordinate (x, y, z), column c = joint (γ, α, β).
 */
export function legJacobian(d: WalkerDims, q: Float64Array, qo: number, out: Float64Array): void {
  const g = q[qo]
  const a = q[qo + 1]
  const ab = a + q[qo + 2]
  const cg = Math.cos(g)
  const sg = Math.sin(g)
  const rho = d.coxa + d.femur * Math.cos(a) + d.tibia * Math.sin(ab)
  const dRhoA = -d.femur * Math.sin(a) + d.tibia * Math.cos(ab)
  const dRhoB = d.tibia * Math.cos(ab)
  const dZA = d.femur * Math.cos(a) + d.tibia * Math.sin(ab)
  const dZB = d.tibia * Math.sin(ab)
  out[0] = -rho * sg
  out[1] = dRhoA * cg
  out[2] = dRhoB * cg
  out[3] = rho * cg
  out[4] = dRhoA * sg
  out[5] = dRhoB * sg
  out[6] = 0
  out[7] = dZA
  out[8] = dZB
}

/**
 * Holding torques τ = −Jᵀ·F for an external force F (leg frame, newtons) acting on
 * the foot: the torque each servo must deliver to keep the leg still. Adds into
 * out[o..o+2]. jac is the 3×3 Jacobian from legJacobian.
 */
export function addHoldingTorque(jac: Float64Array, fx: number, fy: number, fz: number, out: Float64Array, o: number): void {
  for (let c = 0; c < 3; c++) out[o + c] -= jac[c] * fx + jac[3 + c] * fy + jac[6 + c] * fz
}

/**
 * Gravity holding torque of the leg's own links (femur and tibia masses at their
 * midpoints) about the femur and tibia axes, for a level leg frame. Adds into out.
 * upZ is the z component of the world up vector in the leg frame (1 when level).
 */
export function addLinkGravityTorque(
  d: WalkerDims,
  q: Float64Array,
  qo: number,
  mFemur: number,
  mTibia: number,
  upZ: number,
  out: Float64Array,
  o: number,
): void {
  const a = q[qo + 1]
  const ab = a + q[qo + 2]
  const g = 9.81 * upZ
  const femurMid = 0.5 * d.femur * Math.cos(a)
  const tibiaMidFromKnee = 0.5 * d.tibia * Math.sin(ab)
  const tibiaMidFromHip = d.femur * Math.cos(a) + tibiaMidFromKnee
  out[o + 1] += g * (mFemur * femurMid + mTibia * tibiaMidFromHip)
  out[o + 2] += g * mTibia * tibiaMidFromKnee
}

/** Body frame → leg frame (translate to the mount, rotate by −yaw). */
export function bodyToLeg(
  mx: number,
  my: number,
  yaw: number,
  bx: number,
  by: number,
  bz: number,
  out: Float64Array,
  o: number,
): void {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const dx = bx - mx
  const dy = by - my
  out[o] = c * dx + s * dy
  out[o + 1] = -s * dx + c * dy
  out[o + 2] = bz
}

/** Leg frame → body frame. */
export function legToBody(
  mx: number,
  my: number,
  yaw: number,
  lx: number,
  ly: number,
  lz: number,
  out: Float64Array,
  o: number,
): void {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  out[o] = mx + c * lx - s * ly
  out[o + 1] = my + s * lx + c * ly
  out[o + 2] = lz
}

export function clampJoint(j: number, v: number): number {
  return clamp(v, JOINT_MIN[j % 3], JOINT_MAX[j % 3])
}
