/*
 * Mecanum roller layout in the body frame (x forward, y left, z up), relative to the
 * wheel center. Roller k sits at angle psi_k around the axle, psi = 0 at the floor
 * contact. A wheel can only push the floor along the axis of the roller it stands on, so
 * that axis fixes the inverse kinematics in mecanum.ts:
 *   FL, RR contact axis (1, -1)/sqrt2  ->  r w = vx - vy -/+ k wz
 *   FR, RL contact axis (1,  1)/sqrt2  ->  r w = vx + vy +/- k wz
 * Seen from above, the top rollers are the mirror image and form the usual "X".
 */

export interface RollerPose {
  /** Roller center, meters. */
  px: number
  py: number
  pz: number
  /** Unit roller axis. */
  ax: number
  ay: number
  az: number
}

/** Lateral sign of the contact-roller axis per wheel, order FL, FR, RL, RR. */
export const ROLLER_SIGN: readonly [number, number, number, number] = [-1, 1, 1, -1]

/**
 * `n` rollers on a circle of radius `centerRadius` around the axle (body y), each axis
 * the contact axis (1, sign, 0)/sqrt2 rotated with the roller about the axle.
 */
export function rollerLayout(n: number, centerRadius: number, sign: number): RollerPose[] {
  const out: RollerPose[] = []
  const k = Math.SQRT1_2
  for (let i = 0; i < n; i++) {
    const psi = (i / n) * 2 * Math.PI
    const c = Math.cos(psi), s = Math.sin(psi)
    // rotation about +y by psi applied to the contact point (0, 0, -R) and axis (1, sign, 0)
    out.push({ px: -centerRadius * s, py: 0, pz: -centerRadius * c, ax: k * c, ay: k * sign, az: -k * s })
  }
  return out
}
