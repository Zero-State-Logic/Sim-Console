import type { Rng } from './rng'

/*
 * Wind = mean + a shared gust + small per-drone turbulence. Gusts are
 * Ornstein-Uhlenbeck processes (exactly discretized), so they are smooth,
 * mean-reverting and have a known stationary standard deviation. The air
 * velocity feeds the drag and blade-flapping terms of the dynamics.
 */

export interface WindSettings {
  enabled: boolean
  /** Mean speed, m/s. */
  speed: number
  /** Direction the wind blows toward, degrees CCW from +x seen from above. */
  dirDeg: number
  /** Gust standard deviation, m/s. */
  gust: number
}

/** Gust correlation time, s. */
const GUST_TAU = 2.5
/** Turbulence correlation time, s, and its share of the gust intensity. */
const TURB_TAU = 0.6
const TURB_SHARE = 0.3
/** Vertical gusts are weaker near the ground. */
const VERTICAL_SHARE = 0.4

export class WindField {
  readonly mean = new Float64Array(3)
  readonly gust = new Float64Array(3)
  private readonly turb: Float64Array

  constructor(private readonly rng: Rng, maxAgents: number) {
    this.turb = new Float64Array(3 * maxAgents)
  }

  reset(): void {
    this.mean.fill(0)
    this.gust.fill(0)
    this.turb.fill(0)
  }

  /** Advance the gust processes by dt for n agents. */
  step(dt: number, w: WindSettings, n: number): void {
    if (!w.enabled) {
      this.reset()
      return
    }
    const a = (w.dirDeg * Math.PI) / 180
    this.mean[0] = w.speed * Math.cos(a)
    this.mean[1] = w.speed * Math.sin(a)
    this.mean[2] = 0
    const eg = Math.exp(-dt / GUST_TAU)
    const sg = w.gust * Math.sqrt(1 - eg * eg)
    for (let i = 0; i < 3; i++) {
      const share = i === 2 ? VERTICAL_SHARE : 1
      this.gust[i] = this.gust[i] * eg + share * sg * this.rng.gauss()
    }
    const et = Math.exp(-dt / TURB_TAU)
    const st = TURB_SHARE * w.gust * Math.sqrt(1 - et * et)
    const m = Math.min(n * 3, this.turb.length)
    for (let i = 0; i < m; i++) {
      const share = i % 3 === 2 ? VERTICAL_SHARE : 1
      this.turb[i] = this.turb[i] * et + share * st * this.rng.gauss()
    }
  }

  /** Air velocity at agent i, world frame. */
  sample(out: Float64Array, i: number): void {
    const o = 3 * i
    out[0] = this.mean[0] + this.gust[0] + this.turb[o]
    out[1] = this.mean[1] + this.gust[1] + this.turb[o + 1]
    out[2] = this.mean[2] + this.gust[2] + this.turb[o + 2]
  }
}
