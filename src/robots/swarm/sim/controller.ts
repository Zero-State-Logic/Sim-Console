import type { QuadParams } from './params'
import { maxMotorThrust } from './params'
import type { MixerGeom } from './mixer'
import { SAT_RP, SAT_YAW, mix } from './mixer'
import { quatFromColumns } from './quat'

/*
 * Cascaded flight controller, the structure PX4 and Betaflight use:
 *
 *   position --P/D--> velocity --P/I--> accel -> thrust vector -> attitude
 *   attitude --P (quaternion error)--> body rates --P/I/D--> torque -> mixer
 *
 * The position loop runs at the guidance rate (100 Hz); everything below it runs
 * every physics substep. Saturations are explicit: speed limits, tilt limit,
 * thrust limits with conditional-integration anti-windup, rate limits, and the
 * mixer's roll/pitch > thrust > yaw priority. Gains are honest: bad ones oscillate.
 * The rate I term (as in PX4 and Betaflight) rejects persistent moments such as blade
 * flapping in forward flight; without it the attitude sags several degrees short of
 * its setpoint at speed. It is frozen while the mixer saturates and cleared on the ground.
 */

export interface Gains {
  /** Position P, 1/s. */
  posP: number
  /** Position D (on error rate), dimensionless. */
  posD: number
  /** Velocity P, 1/s. */
  velP: number
  /** Velocity I, 1/s². */
  velI: number
  /** Attitude P, 1/s. */
  attP: number
  /** Body-rate P, 1/s. */
  rateP: number
  /** Body-rate I, 1/s². */
  rateI: number
  /** Body-rate D, dimensionless. */
  rateD: number
}

export const DEFAULT_GAINS: Readonly<Gains> = {
  posP: 1.3,
  posD: 0.05,
  velP: 3.2,
  velI: 1.0,
  attP: 7,
  rateP: 20,
  // I/P ≈ 1.5 rad/s, close to PX4's MC_ROLLRATE_I / MC_ROLLRATE_P: well below the
  // rate-loop crossover (≈16 rad/s), so it costs a few degrees of phase margin at most
  rateI: 30,
  rateD: 0.08,
}

/** Bound on the rate integrator's contribution, rad/s² (≈ 20 % of the roll authority of QUAD_250). */
export const RATE_INT_MAX = 40

export interface Limits {
  maxVelXY: number
  maxVelUp: number
  maxVelDown: number
  /** rad */
  maxTilt: number
  /** rad/s */
  maxRateRP: number
  maxRateYaw: number
  /** Bound on the velocity integrator's contribution, m/s². */
  maxIntAcc: number
  /** Yaw share of the attitude error (yaw is the least important axis). */
  yawWeight: number
  /** Gyro low-pass cutoff, Hz (real flight controllers filter the gyro). */
  gyroHz: number
}

export const DEFAULT_LIMITS: Readonly<Limits> = {
  maxVelXY: 6,
  maxVelUp: 2.5,
  maxVelDown: 1.5,
  maxTilt: (35 * Math.PI) / 180,
  maxRateRP: 7,
  maxRateYaw: 2.5,
  // the most horizontal acceleration the 35° tilt limit can deliver (g·tan 35° ≈ 6.9 m/s²):
  // enough to hold station with zero steady error up to the ≈10 m/s wind the tilt allows
  // (a 2 m/s² bound left 0.24 m of offset in a 6 m/s wind and 1.2 m at 10 m/s)
  maxIntAcc: 9.81 * Math.tan((35 * Math.PI) / 180),
  yawWeight: 0.4,
  gyroHz: 120,
}

/** Position P/D -> velocity setpoint with feed-forward, clamped to the speed limits. */
export function positionLoop(
  out: Float64Array,
  s: Float64Array,
  pSp: Float64Array,
  vFf: Float64Array,
  g: Gains,
  lim: Limits,
): void {
  for (let i = 0; i < 3; i++) {
    out[i] = vFf[i] + g.posP * (pSp[i] - s[i]) + g.posD * (vFf[i] - s[3 + i])
  }
  const h = Math.hypot(out[0], out[1])
  if (h > lim.maxVelXY) {
    const k = lim.maxVelXY / h
    out[0] *= k
    out[1] *= k
  }
  if (out[2] > lim.maxVelUp) out[2] = lim.maxVelUp
  else if (out[2] < -lim.maxVelDown) out[2] = -lim.maxVelDown
}

const b1 = new Float64Array(3)
const b2 = new Float64Array(3)
const b3 = new Float64Array(3)

export class CascadeController {
  readonly velInt = new Float64Array(3)
  /** Desired force, world frame, N. */
  readonly force = new Float64Array(3)
  readonly qSp = new Float64Array([1, 0, 0, 0])
  readonly rateSp = new Float64Array(3)
  readonly torque = new Float64Array(3)
  private readonly rateF = new Float64Array(3)
  private readonly ratePrev = new Float64Array(3)
  /** Integrated body-rate error, rad. */
  readonly rateInt = new Float64Array(3)
  /** Collective thrust command, N. */
  thrust = 0
  /** Mixer saturation flags of the last step. */
  satFlags = 0
  /** Set by the airframe while its gear touches the ground: the rate integrator is held at zero. */
  grounded = false
  private primed = false

  reset(): void {
    this.velInt.fill(0)
    this.rateInt.fill(0)
    this.rateF.fill(0)
    this.ratePrev.fill(0)
    this.torque.fill(0)
    this.rateSp.fill(0)
    this.thrust = 0
    this.satFlags = 0
    this.primed = false
  }

  /** Velocity setpoint + yaw -> four motor thrust commands (N), written to out. */
  step(
    h: number,
    s: Float64Array,
    vSp: Float64Array,
    yawSp: number,
    p: QuadParams,
    g: Gains,
    lim: Limits,
    geom: MixerGeom,
    out: Float64Array,
  ): void {
    this.velocityLoop(h, s, vSp, p, g, lim)
    this.attitudeSetpoint(yawSp)
    this.attitudeLoop(s, g, lim)
    this.rateLoop(h, s, p, g, lim)
    this.satFlags = mix(out, this.thrust, this.torque[0], this.torque[1], this.torque[2], geom)
  }

  private velocityLoop(h: number, s: Float64Array, vSp: Float64Array, p: QuadParams, g: Gains, lim: Limits): void {
    const m = p.mass
    const ex = vSp[0] - s[3], ey = vSp[1] - s[4], ez = vSp[2] - s[5]
    const vi = this.velInt
    let fx = m * (g.velP * ex + g.velI * vi[0])
    let fy = m * (g.velP * ey + g.velI * vi[1])
    let fz = m * (g.velP * ez + g.velI * vi[2] + p.g)
    // keep 8% of the thrust range in reserve for attitude control
    const fMax = 4 * maxMotorThrust(p) * 0.92
    const fMin = 0.1 * m * p.g
    let satZ = false
    if (fz < fMin) { fz = fMin; satZ = ez < 0 }
    else if (fz > fMax) { fz = fMax; satZ = ez > 0 }
    const hMax = Math.min(fz * Math.tan(lim.maxTilt), Math.sqrt(Math.max(0, fMax * fMax - fz * fz)))
    const fh = Math.hypot(fx, fy)
    const satXY = fh > hMax
    if (satXY) {
      const k = hMax / fh
      fx *= k
      fy *= k
    }
    // conditional integration: freeze an axis while its output is saturated
    const iMax = lim.maxIntAcc / Math.max(g.velI, 1e-3)
    if (!satXY) {
      vi[0] = clampAbs(vi[0] + ex * h, iMax)
      vi[1] = clampAbs(vi[1] + ey * h, iMax)
    }
    if (!satZ) vi[2] = clampAbs(vi[2] + ez * h, iMax)
    this.force[0] = fx
    this.force[1] = fy
    this.force[2] = fz
    // collective = desired force projected on the current body z axis
    const qw = s[6], qx = s[7], qy = s[8], qz = s[9]
    const bx = 2 * (qx * qz + qw * qy)
    const by = 2 * (qy * qz - qw * qx)
    const bz = 1 - 2 * (qx * qx + qy * qy)
    const t = fx * bx + fy * by + fz * bz
    this.thrust = Math.min(Math.max(t, 0), 4 * maxMotorThrust(p))
  }

  /** Desired attitude: body z along the force, heading from the yaw setpoint. */
  private attitudeSetpoint(yawSp: number): void {
    const f = this.force
    const n = Math.hypot(f[0], f[1], f[2]) || 1
    b3[0] = f[0] / n
    b3[1] = f[1] / n
    b3[2] = f[2] / n
    const cx = Math.cos(yawSp), cy = Math.sin(yawSp)
    // b2 = b3 × (cos ψ, sin ψ, 0)
    b2[0] = -b3[2] * cy
    b2[1] = b3[2] * cx
    b2[2] = b3[0] * cy - b3[1] * cx
    const m = Math.hypot(b2[0], b2[1], b2[2])
    if (m < 1e-6) {
      b2[0] = 0
      b2[1] = 1
      b2[2] = 0
    } else {
      b2[0] /= m
      b2[1] /= m
      b2[2] /= m
    }
    // b1 = b2 × b3
    b1[0] = b2[1] * b3[2] - b2[2] * b3[1]
    b1[1] = b2[2] * b3[0] - b2[0] * b3[2]
    b1[2] = b2[0] * b3[1] - b2[1] * b3[0]
    quatFromColumns(this.qSp, b1, b2, b3)
  }

  /** Quaternion error q⁻¹ ⊗ q_sp (body frame) -> rate setpoint. */
  private attitudeLoop(s: Float64Array, g: Gains, lim: Limits): void {
    const aw = s[6], ax = -s[7], ay = -s[8], az = -s[9]
    const q = this.qSp
    const bw = q[0], bx = q[1], by = q[2], bz = q[3]
    let ew = aw * bw - ax * bx - ay * by - az * bz
    let ex = aw * bx + ax * bw + ay * bz - az * by
    let ey = aw * by - ax * bz + ay * bw + az * bx
    let ez = aw * bz + ax * by - ay * bx + az * bw
    if (ew < 0) { ew = -ew; ex = -ex; ey = -ey; ez = -ez }
    const k = 2 * g.attP
    this.rateSp[0] = clampAbs(k * ex, lim.maxRateRP)
    this.rateSp[1] = clampAbs(k * ey, lim.maxRateRP)
    this.rateSp[2] = clampAbs(k * lim.yawWeight * ez, lim.maxRateYaw)
  }

  /** Rate P/D on the filtered gyro, scaled by inertia, plus gyroscopic feed-forward. */
  private rateLoop(h: number, s: Float64Array, p: QuadParams, g: Gains, lim: Limits): void {
    const a = h / (h + 1 / (2 * Math.PI * lim.gyroHz))
    const rf = this.rateF
    for (let i = 0; i < 3; i++) rf[i] += a * (s[10 + i] - rf[i])
    const J0 = p.Ixx, J1 = p.Iyy, J2 = p.Izz
    const w0 = rf[0], w1 = rf[1], w2 = rf[2]
    this.torque[0] = J0 * this.rateCmd(0, h, g)
    this.torque[1] = J1 * this.rateCmd(1, h, g)
    this.torque[2] = J2 * this.rateCmd(2, h, g)
    this.primed = true
    this.torque[0] += w1 * J2 * w2 - w2 * J1 * w1
    this.torque[1] += w2 * J0 * w0 - w0 * J2 * w2
    this.torque[2] += w0 * J1 * w1 - w1 * J0 * w0
  }

  /** Angular-acceleration command for one axis: P and I on rate error, D on measurement. */
  private rateCmd(i: number, h: number, g: Gains): number {
    const rf = this.rateF[i]
    const d = this.primed ? (rf - this.ratePrev[i]) / h : 0
    this.ratePrev[i] = rf
    const e = this.rateSp[i] - rf
    this.integrateRate(i, e, h, g.rateI)
    return g.rateP * e + g.rateI * this.rateInt[i] - g.rateD * d
  }

  /** Conditional integration: frozen while the mixer saturates this axis, cleared on the ground. */
  private integrateRate(i: number, e: number, h: number, ki: number): void {
    const ri = this.rateInt
    if (this.grounded || !(ki > 0)) {
      ri[i] = 0
      return
    }
    const sat = i < 2 ? SAT_RP : SAT_RP | SAT_YAW
    if ((this.satFlags & sat) !== 0) return
    ri[i] = clampAbs(ri[i] + e * h, RATE_INT_MAX / ki)
  }
}

function clampAbs(v: number, m: number): number {
  return v > m ? m : v < -m ? -m : v
}
