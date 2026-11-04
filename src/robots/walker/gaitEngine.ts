import { MAX_LEGS, type LegLayout } from './geometry'
import { effectiveDuty, localPhase, type GaitDef } from './gaits'
import { wrapAngle } from './pose'
import { creepPoint, smoothstep, triangleMargin } from './creep'

/* ============================================================
   GAIT ENGINE — leg-count agnostic, pure (no three.js).
   The gait frame G (on the ground: x, y, heading) moves with the
   commanded twist. Stance feet are held fixed in WORLD space, so
   they cannot skate; swing feet travel on a cycloid from lift-off
   to a Raibert-style touchdown target (neutral point + half the
   stance travel ahead), re-targeted every substep. With the
   treadmill on, the ground (all planted points) moves instead of
   the body, so the robot stays centred.
   ============================================================ */

export interface GaitParams {
  /** Gait cycle frequency, Hz. */
  freq: number
  /** Longest stance travel of any foot, meters. */
  stride: number
  stepHeight: number
  /** Requested duty factor (clamped to the gait's valid range). */
  duty: number
  treadmill: boolean
}

export interface TwistCmd {
  vx: number
  vy: number
  /** rad/s, CCW from above. */
  wz: number
}

const PHASE_STEP = 0.02
const MAX_SUBSTEP = 1 / 120
const TWIST_TAU = 0.18
/** Feet closer than this to their target don't bother stepping when idle. */
const SETTLE_EPS = 0.004
/** A leg may still start its swing this late into its swing window. */
const LATE_START = 0.6
/**
 * Creep sway: the body moves only as far as needed to sit this far inside the support
 * triangle (see creepPoint), not all the way to its incentre (~9 cm off-centre on the
 * default quad, which crossed ~14 cm in one 40 ms four-feet window: ~30 g, joint rates
 * of 4000 °/s that no hobby servo reaches, so real servos lagged the CoM out of support).
 */
const CREEP_MARGIN = 0.025
const SWAY_TAU = 0.03
/** The body reaches the next support triangle after this fraction of the four-feet phase. */
const SWAY_ARRIVE = 0.85
/**
 * Top sway speed, m/s: keeps the commanded body shift inside hobby-servo joint rates
 * (~0.35 m/s at the hips ≈ 150 °/s). If the gait is timed too fast for it, the lift-off
 * gate (CREEP_GATE) waits for the body instead of lifting a foot it still needs.
 */
const SWAY_MAX_SPEED = 0.35
/** A creeping leg lifts only once the body is at least this far inside the other three feet. */
const CREEP_GATE = 0.008
const ACTIVITY_TAU = 0.35
const TWO_PI = Math.PI * 2

function cycloid(s: number): number {
  return s - Math.sin(TWO_PI * s) / TWO_PI
}

function bump(s: number): number {
  return (1 - Math.cos(TWO_PI * s)) / 2
}

/** p ← R(c, s) · (p − d), in place. */
function moveXY(arr: Float64Array, o: number, dx: number, dy: number, c: number, s: number): void {
  const x = arr[o] - dx
  const y = arr[o + 1] - dy
  arr[o] = c * x - s * y
  arr[o + 1] = s * x + c * y
}

function filterGain(h: number, tau: number): number {
  return 1 - Math.exp(-h / tau)
}

export class GaitEngine {
  phase = 0
  /** Gait frame in the world: [x, y, heading]. */
  readonly frame = new Float64Array(3)
  /** Smoothed (actual) twist in the gait frame: [vx, vy, wz]. */
  readonly twist = new Float64Array(3)
  /** Commanded twist after the stride limit: [vx, vy, wz]. */
  readonly cmd = new Float64Array(3)
  /** Foot tips in the world, xyz per leg. */
  readonly feet = new Float64Array(MAX_LEGS * 3)
  readonly contact = new Uint8Array(MAX_LEGS)
  readonly swinging = new Uint8Array(MAX_LEGS)
  /** Body offset in the gait frame from the quadruped sway: [x, y]. */
  readonly sway = new Float64Array(2)
  /**
   * Treadmill belt pose [x, y, angle]: a point fixed on the belt at p maps to the world
   * at R(angle)·p + (x, y). Planted feet ride on it, so the belt visual moves with them.
   */
  readonly ground = new Float64Array(3)
  odometer = 0
  /** Fraction of the available stride the current twist uses (0..1). */
  driveUtil = 0
  moving = false

  private readonly lift = new Float64Array(MAX_LEGS * 3)
  private readonly target = new Float64Array(MAX_LEGS * 3)
  private readonly swung = new Uint8Array(MAX_LEGS)
  private readonly swingT = new Float64Array(MAX_LEGS)
  private readonly swingDur = new Float64Array(MAX_LEGS)
  private activity = 0
  /** Seconds the creep sway stays active after a foot asked to re-settle while idle. */
  private settleHold = 0
  /** Creep scratch: [creep point x, y, sway target x, y] and the three support feet (gait frame). */
  private readonly tri = new Float64Array(4)
  private readonly triPts = new Float64Array(6)

  constructor(public layout: LegLayout, public gait: GaitDef) {
    this.reset()
  }

  /** New leg layout (leg count / dimensions): replant every foot at neutral. */
  setLayout(layout: LegLayout, gait: GaitDef): void {
    this.layout = layout
    this.gait = gait
    this.plantNeutral()
  }

  /** Swap the gait. Swings in flight finish on their own clock, so nothing jumps. */
  setGait(gait: GaitDef): void {
    this.gait = gait
  }

  reset(x = 0, y = 0, heading = 0): void {
    this.frame[0] = x
    this.frame[1] = y
    this.frame[2] = heading
    this.phase = 0
    this.twist.fill(0)
    this.cmd.fill(0)
    this.sway.fill(0)
    this.ground.fill(0)
    this.activity = 0
    this.settleHold = 0
    this.odometer = 0
    this.driveUtil = 0
    this.plantNeutral()
  }

  plantNeutral(): void {
    const L = this.layout
    const c = Math.cos(this.frame[2])
    const s = Math.sin(this.frame[2])
    for (let i = 0; i < L.n; i++) {
      const o = i * 3
      this.feet[o] = this.frame[0] + c * L.neutralX[i] - s * L.neutralY[i]
      this.feet[o + 1] = this.frame[1] + s * L.neutralX[i] + c * L.neutralY[i]
      this.feet[o + 2] = 0
      this.contact[i] = 1
      this.swinging[i] = 0
      this.swung[i] = 0
    }
  }

  /** Re-plant feet at given world positions (after restore / mode switch). */
  setFeet(xyz: Float64Array, contact: Uint8Array): void {
    for (let i = 0; i < this.layout.n; i++) {
      for (let k = 0; k < 3; k++) this.feet[i * 3 + k] = xyz[i * 3 + k]
      this.contact[i] = contact[i]
      this.swinging[i] = 0
    }
  }

  stanceCount(): number {
    let c = 0
    for (let i = 0; i < this.layout.n; i++) c += this.contact[i]
    return c
  }

  /** Highest body speed (m/s) the stride allows at this frequency and duty. */
  maxSpeed(p: GaitParams): number {
    return (p.stride * p.freq) / effectiveDuty(this.gait, p.duty)
  }

  /** Highest yaw rate (rad/s) the stride allows: the outermost foot uses the full stride. */
  maxYawRate(p: GaitParams): number {
    let r = 0
    for (let i = 0; i < this.layout.n; i++) r = Math.max(r, Math.hypot(this.layout.neutralX[i], this.layout.neutralY[i]))
    return this.maxSpeed(p) / Math.max(r, 1e-3)
  }

  step(dt: number, cmd: TwistCmd, p: GaitParams): void {
    if (dt <= 0) return
    const duty = effectiveDuty(this.gait, p.duty)
    this.limitTwist(cmd, p, duty)
    const n = Math.max(1, Math.ceil(Math.max((dt * p.freq) / PHASE_STEP, dt / MAX_SUBSTEP)))
    const h = dt / n
    for (let k = 0; k < n; k++) this.substep(h, p, duty)
    this.driveUtil = this.stanceTravel(this.twist[0], this.twist[1], this.twist[2], duty / p.freq) / p.stride
  }

  /** Longest per-foot travel during one stance phase for a twist. */
  private stanceTravel(vx: number, vy: number, wz: number, tst: number): number {
    const L = this.layout
    let m = 0
    for (let i = 0; i < L.n; i++) m = Math.max(m, Math.hypot(vx - wz * L.neutralY[i], vy + wz * L.neutralX[i]))
    return m * tst
  }

  /** Scale the command so no foot travels further than the stride during stance. */
  private limitTwist(cmd: TwistCmd, p: GaitParams, duty: number): void {
    const travel = this.stanceTravel(cmd.vx, cmd.vy, cmd.wz, duty / p.freq)
    const k = travel > p.stride && travel > 0 ? p.stride / travel : 1
    this.cmd[0] = cmd.vx * k
    this.cmd[1] = cmd.vy * k
    this.cmd[2] = cmd.wz * k
    this.moving = Math.abs(this.cmd[0]) + Math.abs(this.cmd[1]) + Math.abs(this.cmd[2]) > 1e-5
  }

  private substep(h: number, p: GaitParams, duty: number): void {
    const g = filterGain(h, TWIST_TAU)
    for (let k = 0; k < 3; k++) this.twist[k] += (this.cmd[k] - this.twist[k]) * g
    const vx = this.twist[0]
    const vy = this.twist[1]
    const wz = this.twist[2]
    const mid = this.frame[2] + (wz * h) / 2
    const dx = (vx * Math.cos(mid) - vy * Math.sin(mid)) * h
    const dy = (vx * Math.sin(mid) + vy * Math.cos(mid)) * h
    this.frame[0] += dx
    this.frame[1] += dy
    this.frame[2] += wz * h
    this.odometer += Math.hypot(dx, dy)
    this.phase = (this.phase + p.freq * h) % 1
    this.settleHold = Math.max(0, this.settleHold - h)
    const active = this.moving || this.settleHold > 0 ? 1 : 0
    this.activity += (active - this.activity) * filterGain(h, ACTIVITY_TAU)
    for (let i = 0; i < this.layout.n; i++) this.stepLeg(i, h, p, duty)
    this.updateSway(h, duty)
    if (p.treadmill) this.recentre()
  }

  private stepLeg(i: number, h: number, p: GaitParams, duty: number): void {
    const psi = localPhase(this.gait, i, this.phase)
    const inSwing = psi >= duty
    if (!inSwing) this.swung[i] = 0
    const o = i * 3
    if (this.swinging[i]) {
      this.swingT[i] += h
      const s = Math.min(1, this.swingT[i] / this.swingDur[i])
      this.computeTarget(i, Math.max(0, this.swingDur[i] - this.swingT[i]), duty / p.freq)
      const c = cycloid(s)
      this.feet[o] = this.lift[o] + (this.target[o] - this.lift[o]) * c
      this.feet[o + 1] = this.lift[o + 1] + (this.target[o + 1] - this.lift[o + 1]) * c
      this.feet[o + 2] = p.stepHeight * bump(s)
      if (s >= 1) {
        this.swinging[i] = 0
        this.contact[i] = 1
        this.feet[o + 2] = 0
      }
      return
    }
    if (!inSwing || this.swung[i]) return
    const u = (psi - duty) / (1 - duty)
    if (u > LATE_START) return
    const remaining = ((1 - u) * (1 - duty)) / p.freq
    this.computeTarget(i, remaining, duty / p.freq)
    const far = Math.hypot(this.target[o] - this.feet[o], this.target[o + 1] - this.feet[o + 1]) > SETTLE_EPS
    if (!this.moving && !far) return
    if (this.gait.sway) {
      // keep creeping the body over while feet re-settle; wait until it is safely over
      if (far) this.settleHold = 1 / p.freq
      if (!this.creepSafe(i)) return
    }
    this.swinging[i] = 1
    this.swung[i] = 1
    this.contact[i] = 0
    this.swingT[i] = 0
    this.swingDur[i] = remaining
    for (let k = 0; k < 3; k++) this.lift[o + k] = this.feet[o + k]
  }

  /**
   * Touchdown target in the world: where the gait frame will be at touchdown
   * (extrapolated with the current twist), plus the neutral foot shifted ahead by
   * half the stance travel, so the foot passes neutral at mid-stance.
   */
  private computeTarget(i: number, tRem: number, tStance: number): void {
    const L = this.layout
    const vx = this.twist[0]
    const vy = this.twist[1]
    const wz = this.twist[2]
    const yawT = this.frame[2] + wz * tRem
    const mid = this.frame[2] + (wz * tRem) / 2
    const px = this.frame[0] + (vx * Math.cos(mid) - vy * Math.sin(mid)) * tRem
    const py = this.frame[1] + (vx * Math.sin(mid) + vy * Math.cos(mid)) * tRem
    const nx = L.neutralX[i]
    const ny = L.neutralY[i]
    const half = tStance / 2
    const gx = nx + (vx - wz * ny) * half
    const gy = ny + (vy + wz * nx) * half
    const c = Math.cos(yawT)
    const s = Math.sin(yawT)
    const o = i * 3
    this.target[o] = px + c * gx - s * gy
    this.target[o + 1] = py + s * gx + c * gy
    this.target[o + 2] = 0
  }

  /*
   * Quadruped creep (McGhee): a leg may only lift with the body over the triangle of the
   * other three planted feet. The sway target is that triangle's creep point (CREEP_MARGIN
   * inside it), held through the leg's swing and blended across the four-feet phase to the
   * next leg's triangle, arriving before that leg lifts. It is computed from the planted
   * feet, so it stays right while turning and strafing. The body follows it through a
   * low-pass and a speed cap, so the plan never asks for a jump.
   */
  private updateSway(h: number, duty: number): void {
    let tx = 0
    let ty = 0
    if (this.gait.sway && this.layout.n === 4 && this.activity > 1e-4 && this.creepTarget(duty)) {
      tx = this.tri[2] * this.activity
      ty = this.tri[3] * this.activity
    }
    const g = filterGain(h, SWAY_TAU)
    let dx = (tx - this.sway[0]) * g
    let dy = (ty - this.sway[1]) * g
    const step = Math.hypot(dx, dy)
    const cap = SWAY_MAX_SPEED * h
    if (step > cap) {
      dx *= cap / step
      dy *= cap / step
    }
    this.sway[0] += dx
    this.sway[1] += dy
  }

  /** Creep sway target in the gait frame into tri[2..3]. */
  private creepTarget(duty: number): boolean {
    let swing = -1
    let next = -1
    let prev = -1
    let wait = Infinity
    let ago = Infinity
    for (let k = 0; k < 4; k++) {
      const psi = localPhase(this.gait, k, this.phase)
      if (psi >= duty || this.swinging[k]) {
        swing = k
        break
      }
      if (duty - psi < wait) { wait = duty - psi; next = k }
      if (psi < ago) { ago = psi; prev = k }
    }
    if (swing >= 0) return this.triangleTarget(swing)
    if (!this.triangleTarget(prev)) return false
    const u = smoothstep(ago / Math.max((ago + wait) * SWAY_ARRIVE, 1e-9))
    const ax = this.tri[0]
    const ay = this.tri[1]
    if (!this.triangleTarget(next)) return false
    this.tri[2] = ax + (this.tri[0] - ax) * u
    this.tri[3] = ay + (this.tri[1] - ay) * u
    return true
  }

  /**
   * Creep point of the triangle of the three feet other than `skip`, in the gait frame,
   * into tri[0..1] and tri[2..3].
   */
  private triangleTarget(skip: number): boolean {
    const f = this.feet
    const p = this.triPts
    const c = Math.cos(this.frame[2])
    const s = Math.sin(this.frame[2])
    let m = 0
    for (let k = 0; k < 4; k++) {
      if (k === skip) continue
      const dx = f[k * 3] - this.frame[0]
      const dy = f[k * 3 + 1] - this.frame[1]
      p[m * 2] = c * dx + s * dy
      p[m * 2 + 1] = -s * dx + c * dy
      m++
    }
    if (!creepPoint(p[0], p[1], p[2], p[3], p[4], p[5], CREEP_MARGIN, this.tri, 0)) return false
    this.tri[2] = this.tri[0]
    this.tri[3] = this.tri[1]
    return true
  }

  /** Is the body (gait frame origin + sway) at least CREEP_GATE inside the other three feet of leg i? */
  private creepSafe(i: number): boolean {
    if (this.layout.n !== 4) return true
    const f = this.feet
    const c = Math.cos(this.frame[2])
    const s = Math.sin(this.frame[2])
    const bx = this.frame[0] + c * this.sway[0] - s * this.sway[1]
    const by = this.frame[1] + s * this.sway[0] + c * this.sway[1]
    const a = (i + 1) % 4
    const b = (i + 2) % 4
    const d = (i + 3) % 4
    return triangleMargin(f[a * 3], f[a * 3 + 1], f[b * 3], f[b * 3 + 1], f[d * 3], f[d * 3 + 1], bx, by) >= CREEP_GATE
  }

  /** Treadmill: move every planted point by the inverse of the frame motion. */
  private recentre(): void {
    const dx = this.frame[0]
    const dy = this.frame[1]
    const c = Math.cos(-this.frame[2])
    const s = Math.sin(-this.frame[2])
    for (let i = 0; i < this.layout.n; i++) {
      moveXY(this.feet, i * 3, dx, dy, c, s)
      moveXY(this.lift, i * 3, dx, dy, c, s)
    }
    moveXY(this.ground, 0, dx, dy, c, s)
    this.ground[2] = wrapAngle(this.ground[2] - this.frame[2])
    this.frame[0] = 0
    this.frame[1] = 0
    this.frame[2] = 0
  }
}
