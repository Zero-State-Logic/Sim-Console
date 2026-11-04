import { jointToServoDeg } from '../../core/hardware'
import type { HardwareConfig } from '../../core/hardware'
import type { CmdMsg, TelMsg } from '../../core/protocol'
import type { HardwareSpec } from '../../core/types'
import { DEG, clamp, r2, r3, type BodyHost, type DriveMode, type VirtualBody } from './common'
import type { Rng } from './random'
import { OnboardGait } from './walkerGait'
import { WalkerStatics } from './walkerStatics'

/* ============================================================
   VIRTUAL WALKER — per-joint hobby servo: first-order lag plus a
   slew limit, read back through a hidden "true" mounting offset /
   scale so the calibration tab has a real error to find.
   JOINT level: cmd q is clamped to the limits and tracked.
   HIGH level : cmd v / mode / h drive the on-board gait (the same
   loop the generated firmware runs), blended in over 0.8 s.
   Telemetry: ang = true joint angles + noise; imu and load come
   from the statics of the pose the servos actually reached.
   step() never allocates.
   ============================================================ */

const LIMIT_EPS = 0.05
const SERVO_TAU = 0.06
const SERVO_MAX_DEG_S = 400
const ANG_NOISE_DEG = 0.25
const IMU_NOISE_DEG = 0.3
const RELAX_TAU = 1.2
/** Boot / limp pose relative to home, per joint in a leg (coxa, femur, tibia): sitting. */
const REST_DELTA = [0, 25, -20]
/** Hidden mounting error of the virtual servos (the calibration target). */
const MISCAL_OFFSET_DEG = 3
const MISCAL_SCALE = 0.04
/** Firmware KIYO_HOME_RAMP_MS: the gait eases in from the current pose. */
const GAIT_BLEND_S = 0.8
/** 2S LiPo. */
const PACK_FULL_V = 8.2
const PACK_EMPTY_V = 6.4

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u)
}

export class WalkerBody implements VirtualBody {
  readonly caps: string[]
  readonly estopNote = 'servos frozen in place'
  private readonly n: number
  private readonly q: Float64Array
  private readonly target: Float64Array
  private readonly homeFrom: Float64Array
  private readonly homeTo: Float64Array
  private readonly rest: Float64Array
  private readonly gaitQ: Float64Array
  private readonly blendFrom: Float64Array
  /** The calibration that would make commanded == measured (config units). */
  readonly trueOffset: Float64Array
  readonly trueScale: Float64Array
  /** null when the spec carries no walker geometry (the placeholder module). */
  readonly gait: OnboardGait | null
  readonly statics: WalkerStatics | null
  private cfg: HardwareConfig | null = null
  private mode: DriveMode = 'hold'
  private blendLeft = 0
  private activity = 0
  private drainV = 0

  constructor(private readonly spec: HardwareSpec, private readonly rng: Rng, miscal: boolean, private readonly host: BodyHost) {
    const n = spec.joints
    this.n = n
    this.q = new Float64Array(n)
    this.target = new Float64Array(n)
    this.homeFrom = new Float64Array(n)
    this.homeTo = new Float64Array(n)
    this.rest = new Float64Array(n)
    this.gaitQ = new Float64Array(n)
    this.blendFrom = new Float64Array(n)
    this.trueOffset = new Float64Array(n)
    this.trueScale = new Float64Array(n).fill(1)
    this.gait = OnboardGait.fromSpec(spec)
    this.statics = this.gait ? new WalkerStatics(this.gait.geom) : null
    this.caps = ['feedback', 'imu', 'virtual-servo', ...(this.gait ? ['onboard-ik', 'load'] : [])]
    const perLeg = spec.legs !== undefined && spec.legs * 3 === n
    for (let j = 0; j < n; j++) {
      const [lo, hi] = spec.jointLimits[j] ?? [-180, 180]
      this.rest[j] = clamp((spec.homePose[j] ?? 0) + (perLeg ? REST_DELTA[j % 3] : 0), lo, hi)
      if (miscal) {
        this.trueOffset[j] = rng.range(-MISCAL_OFFSET_DEG, MISCAL_OFFSET_DEG)
        this.trueScale[j] = 1 + rng.range(-MISCAL_SCALE, MISCAL_SCALE)
      }
    }
    this.q.set(this.rest)
    this.target.set(this.rest)
  }

  /** Clamp a joint target to its limits (warning when it was outside). */
  private clampJoint(j: number, v: number): number {
    const [lo, hi] = this.spec.jointLimits[j] ?? [-180, 180]
    if (v >= lo - LIMIT_EPS && v <= hi + LIMIT_EPS) return v
    const name = this.spec.jointNames[j] ?? `J${j}`
    this.host.warn(`clamp${j}`, `servo ${j} clamped (${name} ${v.toFixed(1)}° outside ${lo}..${hi}°)`)
    return clamp(v, lo, hi)
  }

  /** Commanded joint degrees → where the joint really ends up (through the hidden mounting). */
  private toTrue(cfg: HardwareConfig, j: number, qCmd: number, warn: boolean): number {
    const s = jointToServoDeg(cfg, j, qCmd)
    const sc = clamp(s, 0, cfg.servoRangeDeg)
    if (warn && sc !== s) this.host.warn(`range${j}`, `servo ${j} at mechanical stop (${s.toFixed(1)}° of 0..${cfg.servoRangeDeg}°)`)
    const dir = cfg.jointInvert[j] ? -1 : 1
    return (dir * (sc - cfg.servoRangeDeg / 2 - this.trueOffset[j])) / this.trueScale[j]
  }

  command(cmd: CmdMsg, cfg: HardwareConfig): void {
    this.cfg = cfg
    if (cmd.q) return this.commandJoints(cmd.q, cfg)
    if (cmd.v) this.commandTwist(cmd, cfg)
  }

  private commandJoints(q: readonly number[], cfg: HardwareConfig): void {
    if (q.length !== this.n) {
      this.host.warn('qlen', `cmd q has ${q.length} values, this robot has ${this.n}`)
      return
    }
    // joint streaming takes over from a running gait
    this.gait?.stop()
    this.blendLeft = 0
    for (let j = 0; j < this.n; j++) this.target[j] = this.toTrue(cfg, j, this.clampJoint(j, q[j]), true)
  }

  private commandTwist(cmd: CmdMsg, cfg: HardwareConfig): void {
    const gait = this.gait
    const v = cmd.v
    if (!gait || !v) {
      this.host.warn('high', 'cmd v needs the walker geometry for on-board IK: holding pose (use JOINT level)')
      return
    }
    const note = gait.command(v, cmd.mode, cmd.h)
    if (note) this.host.warn('gait', note)
    if (gait.active) return
    gait.activate(this.gaitQ)
    this.blendFrom.set(this.target)
    this.blendLeft = GAIT_BLEND_S
    this.applyGait(cfg, 0)
  }

  beginHome(cfg: HardwareConfig): void {
    this.cfg = cfg
    // HOME always wins over a running gait
    this.gait?.stop()
    this.blendLeft = 0
    this.statics?.resetYaw()
    for (let j = 0; j < this.n; j++) {
      this.homeFrom[j] = this.q[j]
      this.homeTo[j] = this.toTrue(cfg, j, this.spec.homePose[j] ?? 0, false)
    }
  }

  homeProgress(u: number): void {
    for (let j = 0; j < this.n; j++) this.target[j] = this.homeFrom[j] + (this.homeTo[j] - this.homeFrom[j]) * u
  }

  setMode(mode: DriveMode): void {
    this.mode = mode
    if (mode === 'hold') this.gait?.halt()
    else if (mode === 'relax' || mode === 'frozen') {
      this.gait?.stop()
      this.blendLeft = 0
    }
    if (mode === 'frozen') this.target.set(this.q)
  }

  /** Gait joint targets (clamped like any command) → true-angle targets, eased in while blending. */
  private applyGait(cfg: HardwareConfig, dt: number): void {
    const gaitQ = this.gaitQ
    const u = this.blendLeft > 0 ? smoothstep(clamp(1 - this.blendLeft / GAIT_BLEND_S, 0, 1)) : 1
    for (let j = 0; j < this.n; j++) {
      const t = this.toTrue(cfg, j, this.clampJoint(j, gaitQ[j]), true)
      this.target[j] = u < 1 ? this.blendFrom[j] + (t - this.blendFrom[j]) * u : t
    }
    this.blendLeft = Math.max(0, this.blendLeft - dt)
  }

  private stepGait(dt: number): void {
    const gait = this.gait
    if (!gait || !gait.active || !this.cfg) return
    gait.step(dt, this.gaitQ)
    this.applyGait(this.cfg, dt)
    const miss = gait.takeIkMisses()
    if (miss === 0) return
    let legs = ''
    for (let i = 0; i < gait.legs; i++) if (miss & (1 << i)) legs += ` L${i + 1}`
    this.host.warn('ik', `IK: foot target out of reach on leg${legs}`)
  }

  step(dt: number): void {
    if (dt <= 0) return
    this.stepGait(dt)
    if (this.mode === 'relax') {
      const k = 1 - Math.exp(-dt / RELAX_TAU)
      for (let j = 0; j < this.n; j++) this.target[j] += (this.rest[j] - this.target[j]) * k
    }
    const a = 1 - Math.exp(-dt / SERVO_TAU)
    const maxStep = SERVO_MAX_DEG_S * dt
    let moved = 0
    for (let j = 0; j < this.n; j++) {
      const dq = clamp((this.target[j] - this.q[j]) * a, -maxStep, maxStep)
      this.q[j] += dq
      moved += Math.abs(dq)
    }
    const rate = this.n > 0 ? moved / this.n / dt : 0
    this.activity += (rate - this.activity) * Math.min(1, dt / 0.3)
    this.drainV += dt * 0.0003
  }

  telemetry(tel: TelMsg): void {
    const ang = new Array<number>(this.n)
    for (let j = 0; j < this.n; j++) ang[j] = r2(this.q[j] + this.rng.gauss(ANG_NOISE_DEG))
    tel.ang = ang
    const st = this.statics
    if (st) {
      st.update(this.q)
      tel.imu = [
        r2(st.roll * DEG + this.rng.gauss(IMU_NOISE_DEG)),
        r2(st.pitch * DEG + this.rng.gauss(IMU_NOISE_DEG)),
        r2(st.yaw * DEG + this.rng.gauss(0.1)),
      ]
      tel.load = Array.from(st.load, (f) => r3(clamp(f, 0, 1)))
    } else {
      tel.imu = [r2(this.rng.gauss(IMU_NOISE_DEG)), r2(this.rng.gauss(IMU_NOISE_DEG)), r2(this.rng.gauss(0.1))]
    }
    const sag = Math.min(this.activity / 300, 1) * 0.7
    tel.vbat = r2(Math.max(PACK_EMPTY_V, PACK_FULL_V - sag - this.drainV + this.rng.gauss(0.01)))
  }

  /** Test hook: current true joint angles. */
  angles(): Float64Array {
    return this.q
  }
}
