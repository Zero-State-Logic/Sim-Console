import { JOINT_MAX, JOINT_MIN } from './kinematics'

/* ============================================================
   SERVO ACTUATOR MODEL — per joint:
     deadband → first-order lag (tau) → speed limit shaped by the
     DC-motor torque-speed line ω = ω₀(1 − τ/τ_stall) → backlash →
     compliance (the servo's proportional band: a holding torque τ
     deflects the shaft by PROP_BAND·τ/τ_stall).
   Past stall the joint is saturated: it cannot advance against the
   load and sits at full deflection, and the overload is flagged.
   KINEMATIC mode stops there (the plan holds the body up); DYNAMIC
   mode gives the same stiffness and torque cap to Rapier's motors,
   so there the overloaded joint really gives way.
   Angles in radians, torques in N·m.
   ============================================================ */

export type ActuatorPresetId = 'ideal' | 'sg90' | 'mg996r' | 'ds3218' | 'custom'

export interface ActuatorParams {
  /** First-order time constant, seconds (0 = instant). */
  tau: number
  /** No-load speed, rad/s. */
  speed: number
  /** Stall torque, N·m (Infinity = unlimited). */
  stall: number
  /** Total deadband width, radians. */
  deadband: number
  /** Total gear backlash, radians. */
  backlash: number
  /** Output torque constant through the gearbox, N·m/A (for the current estimate). */
  kt: number
  /** Idle current per servo, amps. */
  idle: number
  /** Supply voltage, volts. */
  volts: number
}

const DEG = Math.PI / 180

/** Position error at which a hobby servo's controller delivers full (stall) torque. */
export const PROP_BAND = 6 * DEG

export const ACTUATOR_PRESETS: Readonly<Record<Exclude<ActuatorPresetId, 'custom'>, Readonly<ActuatorParams>>> = {
  ideal: { tau: 0, speed: Infinity, stall: Infinity, deadband: 0, backlash: 0, kt: 0.4, idle: 0, volts: 6 },
  // datasheet: 0.1 s/60° and 1.8 kg·cm @ 4.8 V, dead band 10 µs; ~0.65 A stall (measured)
  sg90: { tau: 0.03, speed: 600 * DEG, stall: 0.18, deadband: 1.0 * DEG, backlash: 1.5 * DEG, kt: 0.18 / 0.65, idle: 0.006, volts: 5 },
  // datasheet: 0.17 s/60° @ 4.8 V (0.14 @ 6 V), 9.4 kg·cm @ 4.8 V (11 @ 6 V), 2.5 A stall
  // @ 6 V, dead band 5 µs. Speed is the conservative 4.8 V figure, torque between the two.
  mg996r: { tau: 0.04, speed: 350 * DEG, stall: 1.0, deadband: 0.5 * DEG, backlash: 1.0 * DEG, kt: 1.0 / 2.5, idle: 0.01, volts: 6 },
  // datasheet: 0.16 s/60° and 19 kg·cm @ 5 V (0.14 s, 21.5 kg·cm @ 6.8 V), dead band 3 µs;
  // ~2.2 A stall. Supply at the 5 V the speed and torque are quoted for.
  ds3218: { tau: 0.035, speed: 375 * DEG, stall: 1.9, deadband: 0.3 * DEG, backlash: 0.6 * DEG, kt: 1.9 / 2.2, idle: 0.004, volts: 5 },
}

export const ACTUATOR_LABELS: Readonly<Record<ActuatorPresetId, string>> = {
  ideal: 'IDEAL',
  sg90: 'SG90',
  mg996r: 'MG996R',
  ds3218: 'DS3218',
  custom: 'CUSTOM',
}

/** Holding torque below this is "unloaded": the shaft floats inside the backlash. */
const LOAD_EPS = 0.004

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export class ActuatorBank {
  /** Motor-side (pre-backlash) position. */
  readonly motor: Float64Array
  /** Gear output position inside the backlash (before compliance). */
  readonly shaft: Float64Array
  /** Compliance deflection under load (filtered with the servo time constant). */
  readonly deflection: Float64Array
  /** Output position: what the leg actually does. */
  readonly out: Float64Array
  /** Output velocity, rad/s. */
  readonly vel: Float64Array

  constructor(readonly capacity: number) {
    this.motor = new Float64Array(capacity)
    this.shaft = new Float64Array(capacity)
    this.deflection = new Float64Array(capacity)
    this.out = new Float64Array(capacity)
    this.vel = new Float64Array(capacity)
  }

  reset(q: Float64Array, n: number): void {
    for (let j = 0; j < n; j++) {
      this.motor[j] = q[j]
      this.shaft[j] = q[j]
      this.deflection[j] = 0
      this.out[j] = q[j]
      this.vel[j] = 0
    }
  }

  /**
   * Advance n joints by dt toward `target`. `load` is the holding torque each joint
   * must deliver (from statics); pass null to skip the torque-speed, stall and
   * compliance model (DYNAMIC mode, where the physics engine does all three).
   */
  step(dt: number, target: Float64Array, load: Float64Array | null, p: ActuatorParams, n: number): void {
    if (dt <= 0) return
    const lagGain = p.tau > 0 ? 1 - Math.exp(-dt / p.tau) : 1
    const half = p.backlash / 2
    const limited = load !== null && Number.isFinite(p.stall)
    for (let j = 0; j < n; j++) {
      const k = j % 3
      const err = target[j] - this.motor[j]
      let w = Math.abs(err) <= p.deadband / 2 ? 0 : (err * lagGain) / dt
      w = clamp(w, -p.speed, p.speed)
      const tl = load ? load[j] : 0
      if (limited) w = torqueSpeedLimit(w, tl, p)
      this.motor[j] = clamp(this.motor[j] + w * dt, JOINT_MIN[k], JOINT_MAX[k])
      this.shaft[j] = backlash(this.shaft[j], this.motor[j], half, tl, p.speed * dt)
      const want = limited ? complianceDeflection(tl, p.stall) : 0
      this.deflection[j] += (want - this.deflection[j]) * lagGain
      const prev = this.out[j]
      this.out[j] = clamp(this.shaft[j] + this.deflection[j], JOINT_MIN[k], JOINT_MAX[k])
      this.vel[j] = (this.out[j] - prev) / dt
    }
  }
}

/**
 * Clamp a velocity with the torque-speed line. Moving against the load (in the
 * direction of the holding torque) the servo reaches at most ω₀(1 − |τ|/τ_stall);
 * at or past stall that bound is zero: the joint is saturated and cannot advance.
 */
export function torqueSpeedLimit(w: number, holdTorque: number, p: ActuatorParams): number {
  if (holdTorque === 0) return w
  const s = holdTorque > 0 ? 1 : -1
  const speed = Number.isFinite(p.speed) ? p.speed : 50
  const upper = Math.max(0, speed * (1 - Math.abs(holdTorque) / p.stall))
  return Math.max(Math.min(w * s, upper), -speed) * s
}

/**
 * Steady deflection of a position servo holding `holdTorque`: the error its
 * proportional controller needs to produce that torque, in the direction the load
 * pushes (opposite the holding torque). Saturates at the full band past stall.
 */
export function complianceDeflection(holdTorque: number, stall: number): number {
  if (!Number.isFinite(stall) || stall <= 0) return 0
  return -PROP_BAND * clamp(holdTorque / stall, -1, 1)
}

/**
 * Gear backlash. Under load the gravity / ground force takes up the slack on the
 * side opposite the holding torque; unloaded, the shaft stays wherever it is inside
 * the play. maxStep limits how fast the slack is taken up (no teleporting clunks).
 */
export function backlash(out: number, motor: number, half: number, holdTorque: number, maxStep: number): number {
  if (half <= 0) return motor
  if (Math.abs(holdTorque) > LOAD_EPS) {
    const want = motor - Math.sign(holdTorque) * half
    const taken = clamp(want, out - maxStep, out + maxStep)
    return clamp(taken, motor - half, motor + half)
  }
  return clamp(out, motor - half, motor + half)
}

/**
 * Estimated supply current of one servo holding `torque`. Analog hobby servos pulse the
 * motor at full voltage for a duty proportional to the error, so the mean current is
 * linear in torque (an upper bound for high-frequency PWM digital servos). A load past
 * stall cannot draw more than the stall current.
 */
export function servoCurrent(torque: number, p: ActuatorParams): number {
  return p.idle + Math.min(Math.abs(torque), p.stall) / p.kt
}

/**
 * True when a joint needs at least the servo's stall torque. In DYNAMIC mode the motor
 * torque is capped at stall, so a saturated motor reads exactly stall and counts.
 */
export function isOverloaded(torque: number, p: ActuatorParams): boolean {
  return Number.isFinite(p.stall) && Math.abs(torque) >= p.stall
}
