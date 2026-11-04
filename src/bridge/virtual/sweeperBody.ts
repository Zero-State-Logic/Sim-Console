import type { CmdMsg, TelMsg } from '../../core/protocol'
import type { HardwareSpec } from '../../core/types'
import { DEG, r2, r3, type BodyHost, type DriveMode, type VirtualBody } from './common'
import type { Rng } from './random'

/* ============================================================
   VIRTUAL SWEEPER — four mecanum wheels (FL FR RL RR, positive =
   rolling forward) on DC motors: first-order lag capped by the
   torque (acceleration) limit; relax coasts, E-STOP brakes.
   Odometry integrates the forward kinematics with the midpoint
   heading, REP-103 plan frame (x forward, y left, heading CCW).
     IK: w_FL = (vx − vy − k)/r  w_FR = (vx + vy + k)/r
         w_RL = (vx + vy − k)/r  w_RR = (vx − vy + k)/r,  k = (lx + ly)·ωz
   Like the firmware, the speed cap and the acceleration limit
   scale every wheel by one common factor, so a saturated or
   accelerating twist keeps its direction (only its size shrinks).
   step() never allocates.
   ============================================================ */

const WHEEL_TAU = 0.08
const COAST_TAU = 0.6
const ENC_NOISE = 0.05
/** Motor torque limit as wheel acceleration, rad/s² (the sim's MAX_WHEEL_ACCEL); braking is stronger. */
const WHEEL_ACCEL = 40
const BRAKE_ACCEL = 120
/** 3S LiPo, resting. */
const PACK_V = 12.2

export class SweeperBody implements VirtualBody {
  readonly caps = ['enc', 'odom', 'imu']
  readonly estopNote = 'wheels braked'
  private readonly n: number
  private readonly r: number
  private readonly lxy: number
  private readonly wMax: number
  private readonly w: Float64Array
  private readonly wt: Float64Array
  /** Per-step wheel speed change scratch. */
  private readonly dw: Float64Array
  private x = 0
  private y = 0
  private th = 0
  private mode: DriveMode = 'hold'
  private activity = 0

  constructor(spec: HardwareSpec, private readonly rng: Rng, private readonly host: BodyHost) {
    const g = spec.geometry ?? {}
    const num = (k: string, d: number): number => {
      const v = g[k]
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d
    }
    this.n = spec.wheels ?? spec.joints
    this.r = num('wheelRadius', 0.04)
    this.lxy = num('halfLength', 0.1) + num('halfWidth', 0.1)
    this.wMax = num('maxWheelSpeed', 25)
    this.w = new Float64Array(this.n)
    this.wt = new Float64Array(this.n)
    this.dw = new Float64Array(this.n)
  }

  command(cmd: CmdMsg): void {
    if (cmd.w) {
      if (cmd.w.length !== this.n) {
        this.host.warn('wlen', `cmd has ${cmd.w.length} wheel speeds, firmware expects ${this.n}`)
        return
      }
      for (let j = 0; j < this.n; j++) this.wt[j] = cmd.w[j]
    } else if (cmd.v && this.n === 4) {
      const [vx, vy, wz] = cmd.v
      const k = this.lxy * wz
      this.wt[0] = (vx - vy - k) / this.r
      this.wt[1] = (vx + vy + k) / this.r
      this.wt[2] = (vx + vy - k) / this.r
      this.wt[3] = (vx - vy + k) / this.r
    } else return
    this.saturate()
  }

  /** Firmware robotCommand: one factor for every wheel, so the robot keeps its heading and only slows down. */
  private saturate(): void {
    let peak = 0
    for (let j = 0; j < this.n; j++) peak = Math.max(peak, Math.abs(this.wt[j]))
    if (peak <= this.wMax + 1e-6) return
    const s = this.wMax / peak
    for (let j = 0; j < this.n; j++) this.wt[j] *= s
    this.host.warn('wlimit', `wheel speeds limited to ${this.wMax} rad/s (scaled together, heading kept; peak ${peak.toFixed(2)})`)
  }

  beginHome(): void {
    this.wt.fill(0)
  }

  homeProgress(): void {}

  setMode(mode: DriveMode): void {
    this.mode = mode
    if (mode !== 'track') this.wt.fill(0)
  }

  step(dt: number): void {
    if (dt <= 0) return
    const a = 1 - Math.exp(-dt / (this.mode === 'relax' ? COAST_TAU : WHEEL_TAU))
    const maxDw = (this.mode === 'frozen' ? BRAKE_ACCEL : WHEEL_ACCEL) * dt
    let peak = 0
    for (let j = 0; j < this.n; j++) {
      const want = this.mode === 'frozen' ? -this.w[j] : (this.wt[j] - this.w[j]) * a
      this.dw[j] = want
      peak = Math.max(peak, Math.abs(want))
    }
    // firmware robotControl: the slew limit scales all wheels together (no swerve while ramping)
    const k = peak > maxDw ? maxDw / peak : 1
    let sum = 0
    let mag = 0
    for (let j = 0; j < this.n; j++) {
      this.w[j] += k * this.dw[j]
      sum += this.w[j]
      mag += Math.abs(this.w[j])
    }
    let vx = 0
    let vy = 0
    let wz = 0
    if (this.n === 4) {
      const fl = this.w[0]
      const fr = this.w[1]
      const rl = this.w[2]
      const rr = this.w[3]
      vx = (this.r / 4) * (fl + fr + rl + rr)
      vy = (this.r / 4) * (-fl + fr + rl - rr)
      wz = (this.r / (4 * this.lxy)) * (-fl + fr - rl + rr)
    } else if (this.n > 0) {
      // not a mecanum base: treat the wheels as one drive axle (signed mean)
      vx = (this.r * sum) / this.n
    }
    // midpoint heading: second-order accurate for a twist held over the step
    const thm = this.th + 0.5 * wz * dt
    const c = Math.cos(thm)
    const s = Math.sin(thm)
    this.x += (vx * c - vy * s) * dt
    this.y += (vx * s + vy * c) * dt
    this.th = Math.atan2(Math.sin(this.th + wz * dt), Math.cos(this.th + wz * dt))
    this.activity += (mag / Math.max(this.n, 1) - this.activity) * Math.min(1, dt / 0.3)
  }

  telemetry(tel: TelMsg): void {
    const enc = new Array<number>(this.n)
    for (let j = 0; j < this.n; j++) enc[j] = r3(this.w[j] + this.rng.gauss(ENC_NOISE))
    tel.enc = enc
    const hdg = r2(this.th * DEG)
    tel.pose = [r3(this.x), r3(this.y), hdg]
    tel.imu = [r2(this.rng.gauss(0.2)), r2(this.rng.gauss(0.2)), hdg]
    tel.vbat = r2(PACK_V - Math.min(this.activity / this.wMax, 1) * 0.6 + this.rng.gauss(0.01))
  }

  /** Test hook: [x, y, headingRad]. */
  pose(): [number, number, number] {
    return [this.x, this.y, this.th]
  }
}
