import { gaitKeys, gaitsFor, type GaitDef } from '../../codegen/gaits'
import { gaitTuning, neutralFeet, readWalkerGeometry, type GaitTuning, type WalkerGeom } from '../../codegen/walkerGeom'
import type { HardwareSpec } from '../../core/types'
import { clamp } from './common'

/* ============================================================
   VIRTUAL ON-BOARD GAIT — the HIGH-level firmware loop (gaitStep
   and legIk in src/codegen/cpp/walker.ts) transliterated, so the
   virtual board walks from cmd v / mode / h exactly like a flashed
   one. Gait tables and tuning come from the same codegen functions
   the firmware is generated from. step() never allocates.

   Stance (phase < duty): the foot slides from +stride/2 to
   −stride/2, i.e. at exactly −(v + ω × r) relative to the body, so
   a planted foot does not skate. Swing: cosine return, sine lift.
   ============================================================ */

const DEG = 180 / Math.PI
const RAD = Math.PI / 180
const HALF_PI = Math.PI / 2
/** Same reach margin as the firmware (1 mm). */
const REACH_EPS = 0.001
/** |v| + |ω|·reach below this = standing still: the step height fades out. */
const MOVING_EPS = 0.002

function frac(v: number): number {
  return v - Math.floor(v)
}

export class OnboardGait {
  readonly legs: number
  readonly geom: WalkerGeom
  private readonly gaits: GaitDef[]
  private readonly keys: { key: string; index: number }[]
  private readonly tune: GaitTuning
  private readonly footX: Float64Array
  private readonly footY: Float64Array
  private readonly cosM: Float64Array
  private readonly sinM: Float64Array
  /** Commanded and smoothed twist (m/s, m/s, rad/s) and body height (m). */
  vx = 0
  vy = 0
  wz = 0
  sx = 0
  sy = 0
  sw = 0
  h: number
  hs: number
  /** 0..1, fades the step height in and out. */
  lift = 0
  /** 0..1 position in the gait cycle. */
  phase = 0
  gait = 0
  active = false
  /** Bit per leg whose foot target was out of reach since the last takeIkMisses(). */
  private ikMiss = 0

  /** The board's gait for this spec, or null when it carries no usable walker geometry. */
  static fromSpec(spec: HardwareSpec): OnboardGait | null {
    if (spec.robot !== 'walker') return null
    const r = readWalkerGeometry(spec)
    if (!r.geom || r.geom.legs * 3 !== spec.joints) return null
    return new OnboardGait(r.geom)
  }

  constructor(geom: WalkerGeom) {
    this.geom = geom
    this.legs = geom.legs
    this.gaits = gaitsFor(geom)
    this.keys = gaitKeys(this.gaits)
    this.tune = gaitTuning(geom)
    const nf = neutralFeet(geom)
    this.footX = Float64Array.from(nf.x)
    this.footY = Float64Array.from(nf.y)
    this.cosM = Float64Array.from(geom.mountYawDeg, (d) => Math.cos(d * RAD))
    this.sinM = Float64Array.from(geom.mountYawDeg, (d) => Math.sin(d * RAD))
    this.h = geom.standHeight
    this.hs = geom.standHeight
  }

  get gaitName(): string {
    return this.gaits[this.gait]?.name ?? '?'
  }

  get tuning(): GaitTuning {
    return this.tune
  }

  /** Neutral foot point of a leg, body frame (m). */
  neutral(leg: number): [number, number] {
    return [this.footX[leg], this.footY[leg]]
  }

  /** Pick a gait by name or alias (firmware gaitSelect). */
  select(name: string): boolean {
    for (const k of this.keys) {
      if (k.key === name) {
        this.gait = k.index
        return true
      }
    }
    return false
  }

  /** cmd v / mode / h (firmware applyTwist). Returns a note for the board log, or null. */
  command(v: readonly [number, number, number], mode: string | undefined, h: number | undefined): string | null {
    this.vx = v[0]
    this.vy = v[1]
    this.wz = v[2]
    let note: string | null = null
    if (mode !== undefined && !this.select(mode)) note = `unknown gait '${mode.slice(0, 24)}', keeping ${this.gaitName}`
    if (h !== undefined && Number.isFinite(h)) this.h = clamp(h, this.tune.heightMin, this.tune.heightMax)
    return note
  }

  /** First twist after joint control: reset the smoothing and write the stance targets. */
  activate(out: Float64Array): void {
    this.active = true
    this.sx = 0
    this.sy = 0
    this.sw = 0
    this.hs = this.h
    this.lift = 0
    this.step(0, out)
  }

  /** Watchdog hold: stop walking, the feet settle into the stance. */
  halt(): void {
    this.vx = 0
    this.vy = 0
    this.wz = 0
  }

  /** HOME, E-STOP, relax: hand the joints back to the joint layer. */
  stop(): void {
    this.halt()
    this.active = false
  }

  takeIkMisses(): number {
    const m = this.ikMiss
    this.ikMiss = 0
    return m
  }

  /** Fastest foot speed relative to the body, m/s. */
  private footSpeedMax(): number {
    let vmax = 0
    for (let i = 0; i < this.legs; i++) {
      const fx = this.sx - this.sw * this.footY[i]
      const fy = this.sy + this.sw * this.footX[i]
      const s = Math.hypot(fx, fy)
      if (s > vmax) vmax = s
    }
    return vmax
  }

  /** Advance by dt (s) and write every joint target, degrees joint space, into out. */
  step(dt: number, out: Float64Array): void {
    const t = this.tune
    const a = dt / (t.cmdTauS + dt)
    this.sx += a * (this.vx - this.sx)
    this.sy += a * (this.vy - this.sy)
    this.sw += a * (this.wz - this.sw)
    this.hs += a * (this.h - this.hs)
    const moving = Math.abs(this.vx) + Math.abs(this.vy) + Math.abs(this.wz) * this.geom.footReach > MOVING_EPS
    this.lift += a * ((moving ? 1 : 0) - this.lift)
    const gd = this.gaits[this.gait]
    const duty = gd.duty
    const vmax = this.footSpeedMax()
    // the cycle shortens with speed so the stride stays under maxStride
    let cycle = t.cycleMaxS
    if (vmax * cycle * duty > t.maxStride) cycle = clamp(t.maxStride / (vmax * duty), t.cycleMinS, t.cycleMaxS)
    let scale = 1
    if (vmax * cycle * duty > t.maxStride) scale = t.maxStride / (vmax * cycle * duty)
    this.phase = frac(this.phase + dt / cycle)
    const liftM = this.lift * t.stepHeight
    const span = cycle * duty * scale
    for (let i = 0; i < this.legs; i++) {
      const strideX = (this.sx - this.sw * this.footY[i]) * span
      const strideY = (this.sy + this.sw * this.footX[i]) * span
      const ph = frac(this.phase - gd.offsets[i])
      let k: number
      let z = 0
      if (ph < duty) {
        k = 0.5 - ph / duty
      } else {
        const u = (ph - duty) / (1 - duty)
        k = -0.5 + 0.5 * (1 - Math.cos(Math.PI * u))
        z = liftM * Math.sin(Math.PI * u)
      }
      if (!this.ik(i, this.footX[i] + k * strideX, this.footY[i] + k * strideY, -this.hs + z, out, i * 3)) this.ikMiss |= 1 << i
    }
  }

  /** Closed-form 3-DOF leg IK, knee up; body-frame foot target → out[o..o+2] in degrees. False when clamped onto the reach shell. */
  ik(leg: number, px: number, py: number, pz: number, out: Float64Array, o: number): boolean {
    const g = this.geom
    const dx = px - g.mountX[leg]
    const dy = py - g.mountY[leg]
    const lx = this.cosM[leg] * dx + this.sinM[leg] * dy
    const ly = -this.sinM[leg] * dx + this.cosM[leg] * dy
    let r = Math.hypot(lx, ly) - g.coxa
    let z = pz
    let d = Math.hypot(r, z)
    const dMax = g.femur + g.tibia - REACH_EPS
    const dMin = Math.abs(g.femur - g.tibia) + REACH_EPS
    let reachable = true
    if (d > dMax || d < dMin) {
      const target = d > dMax ? dMax : dMin
      if (d < 1e-6) {
        r = target
        z = 0
      } else {
        r *= target / d
        z *= target / d
      }
      d = target
      reachable = false
    }
    const F = g.femur
    const T = g.tibia
    const a1 = Math.acos(clamp((F * F + d * d - T * T) / (2 * F * d), -1, 1))
    const a2 = Math.acos(clamp((F * F + T * T - d * d) / (2 * F * T), -1, 1))
    out[o] = Math.atan2(ly, lx) * DEG
    out[o + 1] = (Math.atan2(z, r) + a1) * DEG
    out[o + 2] = (a2 - HALF_PI) * DEG
    return reachable
  }
}
