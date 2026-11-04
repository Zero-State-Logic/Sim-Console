/*
 * Physical parameters of a 250-class X-frame quadrotor (5" props, 3S pack).
 * Values are representative of real hardware, not tuned for looks.
 */

export interface QuadParams {
  /** kg */
  mass: number
  /** Center to motor axis, m. */
  armLength: number
  /** Principal inertia, kg·m² (FLU body axes). */
  Ixx: number
  Iyy: number
  Izz: number
  /** Thrust coefficient, N/(rad/s)². */
  kT: number
  /** Yaw drag-torque coefficient, N·m/(rad/s)². */
  kQ: number
  /** Motor first-order time constant, s. */
  motorTau: number
  /** Maximum rotor speed, rad/s. */
  omegaMax: number
  /** Linear drag, N/(m/s). */
  dragLin: number
  /** Quadratic drag, N/(m/s)². */
  dragQuad: number
  /** Rotational damping, N·m/(rad/s). */
  dragRot: number
  /**
   * Blade-flapping moment per unit air-relative speed, N·m/(m/s). The advancing
   * blade lifts more, so the rotor disc tilts away from the relative wind.
   */
  kFlap: number
  /** m/s² */
  g: number
  /** Height of the CoM above the ground when resting on the landing gear, m. */
  gearHeight: number
  /** Prop radius, m (5" prop). */
  propRadius: number
  /** Idle thrust per motor while armed, as a fraction of max thrust. */
  idleFrac: number
}

const MAX_THRUST_PER_MOTOR = 2 * ((0.6 * 9.81) / 4) // 2x hover, N
const OMEGA_MAX = 2500 // rad/s, about 24k rpm

export const QUAD_250: Readonly<QuadParams> = {
  // all-up weight with a 3S 850 mAh pack and a small camera
  mass: 0.6,
  // 250 mm motor-to-motor diagonal
  armLength: 0.12,
  // motors (≈28 g) at the arm tips dominate; the scaled AscTec Hummingbird (0.68 kg,
  // 0.17 m arm: 7e-3 / 1.2e-2) gives ≈3e-3 / 5e-3, a bottom-up estimate ≈1.3e-3 / 2.7e-3
  Ixx: 2.4e-3,
  Iyy: 2.4e-3,
  Izz: 4.2e-3,
  // max thrust 2.94 N per motor = 2× hover (thrust-to-weight 2:1)
  kT: MAX_THRUST_PER_MOTOR / (OMEGA_MAX * OMEGA_MAX),
  // kQ/kT ≈ 0.016 m is typical for 5" props
  kQ: (0.016 * MAX_THRUST_PER_MOTOR) / (OMEGA_MAX * OMEGA_MAX),
  // 20-50 ms is typical for 22xx motors on BLHeli ESCs
  motorTau: 0.03,
  omegaMax: OMEGA_MAX,
  // rotor drag ≈ 0.2 N/(m/s) per kg of quad (Faessler et al., RA-L 2018); total drag at
  // 5 m/s is 1.35 N, within 10 % of rotor drag + a CdA ≈ 0.015 m² body
  dragLin: 0.12,
  dragQuad: 0.03,
  dragRot: 2.0e-4,
  // 0.02 N·m at 5 m/s: a few % of the ≈0.47 N·m roll authority at hover
  kFlap: 4.0e-3,
  g: 9.81,
  gearHeight: 0.035,
  propRadius: 0.0635,
  idleFrac: 0.03,
}

/** Maximum thrust of one motor, N. */
export function maxMotorThrust(p: QuadParams): number {
  return p.kT * p.omegaMax * p.omegaMax
}

/** Rotor speed that holds hover with all four motors equal, rad/s. */
export function hoverOmega(p: QuadParams): number {
  return Math.sqrt((p.mass * p.g) / (4 * p.kT))
}
