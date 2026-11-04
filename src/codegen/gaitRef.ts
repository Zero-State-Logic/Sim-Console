import { CREEP, creepPoint, smoothstep, supportTri, triMargin } from './creep'
import { legPhase } from './gaits'
import type { GaitDef } from './gaits'
import { legIk } from './walkerGeom'
import type { GaitTuning, WalkerGeom } from './walkerGeom'

/* ============================================================
   ON-BOARD GAIT, REFERENCE MODEL — the exact loop the generated
   firmware runs (gaitStep in kiyobridge.h, Gait.step in the Pi
   daemon), in TypeScript so its physics can be tested in Node:
   command smoothing, cycle and stride limits, phase-locked feet,
   and for the 4-leg crawl the creep sway + lift-off gate.
   Not used at runtime by the app.
   ============================================================ */

const frac = (v: number): number => v - Math.floor(v)
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

export class GaitRef {
  readonly v: [number, number, number] = [0, 0, 0]
  readonly s: [number, number, number] = [0, 0, 0]
  h: number
  hs: number
  lift = 0
  phase = 0
  index = 0
  swayX = 0
  swayY = 0
  /** Foot targets in the gait frame (before the sway), m. */
  readonly footX: number[]
  readonly footY: number[]
  readonly footZ: number[]
  /** Last IK joint targets, degrees, leg-major. */
  readonly q: number[]

  constructor(
    readonly g: WalkerGeom,
    readonly gaits: GaitDef[],
    readonly t: GaitTuning,
    readonly nx: number[],
    readonly ny: number[],
  ) {
    this.h = g.standHeight
    this.hs = g.standHeight
    this.footX = nx.slice()
    this.footY = ny.slice()
    this.footZ = nx.map(() => 0)
    this.q = new Array<number>(g.legs * 3).fill(0)
  }

  /** True when this build runs the creep (only 4-leg firmware has it). */
  creeping(): boolean {
    return this.g.legs === 4 && this.gaits[this.index].creep
  }

  private footSpeedMax(): number {
    let vmax = 0
    for (let i = 0; i < this.g.legs; i++) vmax = Math.max(vmax, Math.hypot(this.s[0] - this.s[2] * this.ny[i], this.s[1] + this.s[2] * this.nx[i]))
    return vmax
  }

  /** Phase step the lift-off gate allows: wait while the body is not yet over the next support triangle. */
  creepAdvance(duty: number, dph: number): number {
    if (!this.creeping() || this.lift < CREEP.minLift) return dph
    const gd = this.gaits[this.index]
    let next = -1
    let wait = Infinity
    for (let k = 0; k < 4; k++) {
      const psi = legPhase(gd, k, this.phase)
      if (psi >= duty) return dph
      if (duty - psi < wait) {
        wait = duty - psi
        next = k
      }
    }
    if (wait > dph) return dph
    if (triMargin(supportTri(this.footX, this.footY, next), this.swayX, this.swayY) >= CREEP.gate) return dph
    return Math.max(0, wait - 1e-4)
  }

  /** Sway target: the swinging leg's creep point, or last → next blended across the four-feet phase. */
  creepTarget(duty: number): [number, number] | null {
    const gd = this.gaits[this.index]
    let next = -1
    let prev = -1
    let wait = Infinity
    let ago = Infinity
    for (let k = 0; k < 4; k++) {
      const psi = legPhase(gd, k, this.phase)
      if (psi >= duty) return creepPoint(supportTri(this.footX, this.footY, k))
      if (duty - psi < wait) {
        wait = duty - psi
        next = k
      }
      if (psi < ago) {
        ago = psi
        prev = k
      }
    }
    const a = creepPoint(supportTri(this.footX, this.footY, prev))
    const b = creepPoint(supportTri(this.footX, this.footY, next))
    if (!a || !b) return null
    const u = smoothstep(ago / Math.max((ago + wait) * CREEP.arrive, 1e-6))
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]
  }

  private sway(dt: number, duty: number): void {
    let tx = 0
    let ty = 0
    const target = this.creeping() && this.lift > 1e-4 ? this.creepTarget(duty) : null
    if (target) {
      tx = target[0] * this.lift
      ty = target[1] * this.lift
    }
    const g = dt > 0 ? dt / (CREEP.tauS + dt) : 0
    let dx = (tx - this.swayX) * g
    let dy = (ty - this.swayY) * g
    const step = Math.hypot(dx, dy)
    const cap = CREEP.maxSpeed * dt
    if (step > cap) {
      dx *= cap / step
      dy *= cap / step
    }
    this.swayX += dx
    this.swayY += dy
  }

  /** Advance by dt (s); returns the legs whose IK target was out of reach. */
  step(dt: number): number[] {
    const t = this.t
    const a = dt > 0 ? dt / (t.cmdTauS + dt) : 0
    for (let k = 0; k < 3; k++) this.s[k] += a * (this.v[k] - this.s[k])
    this.hs += a * (this.h - this.hs)
    const moving = Math.abs(this.v[0]) + Math.abs(this.v[1]) + Math.abs(this.v[2]) * this.g.footReach > 0.002
    this.lift += a * ((moving ? 1 : 0) - this.lift)
    const gd = this.gaits[this.index]
    const duty = gd.duty
    const vmax = this.footSpeedMax()
    const cycleMin = Math.max(t.cycleMinS, t.swingMinS / (1 - duty))
    const cycleMax = Math.max(t.cycleMaxS, cycleMin)
    let cycle = cycleMax
    if (vmax * cycle * duty > t.maxStride) cycle = clamp(t.maxStride / (vmax * duty), cycleMin, cycleMax)
    let scale = 1
    if (vmax * cycle * duty > t.maxStride) scale = t.maxStride / (vmax * cycle * duty)
    this.phase = frac(this.phase + this.creepAdvance(duty, dt / cycle))
    const liftM = this.lift * t.stepHeight
    const span = cycle * duty * scale
    for (let i = 0; i < this.g.legs; i++) {
      const ph = legPhase(gd, i, this.phase)
      let k: number
      let z = 0
      if (ph < duty) {
        k = 0.5 - ph / duty
      } else {
        const u = (ph - duty) / (1 - duty)
        k = -0.5 + 0.5 * (1 - Math.cos(Math.PI * u))
        z = liftM * Math.sin(Math.PI * u)
      }
      this.footX[i] = this.nx[i] + k * (this.s[0] - this.s[2] * this.ny[i]) * span
      this.footY[i] = this.ny[i] + k * (this.s[1] + this.s[2] * this.nx[i]) * span
      this.footZ[i] = z
    }
    this.sway(dt, duty)
    const misses: number[] = []
    for (let i = 0; i < this.g.legs; i++) {
      const r = legIk(this.g, i, this.footX[i] - this.swayX, this.footY[i] - this.swayY, -this.hs + this.footZ[i])
      if (!r.reachable) misses.push(i)
      for (let m = 0; m < 3; m++) this.q[i * 3 + m] = r.q[m]
    }
    return misses
  }
}
