/*
 * Frame pacer — turns jittery rAF deltas into even sim steps.
 *
 * Browser frame callbacks arrive with ±1–2 ms of timing noise, which is ±10 % of a
 * 60 Hz frame. Feeding that straight into the sim makes motion advance unevenly frame
 * to frame (micro-judder) even when the physics is perfect. The pacer tracks the
 * display refresh period and hands out whole multiples of it, so every frame advances
 * the robot by the same amount.
 *
 * Period estimate: consecutive deltas telescope (d_i = P + e_i - e_(i-1)), so their mean
 * converges on the true period with error <= 2·noise/N. A median of the first few
 * samples rejects start-up hitches, then a growing-window mean of in-band samples
 * refines it. The remainder between wall time and paced time is carried as `debt` and
 * bled back in a few percent per frame, so sim time never drifts and never jumps.
 * Frames far from a whole multiple of the period (a real hitch) pass through as-is.
 */

const WARMUP = 12
/** Deltas outside this band are hitches or duplicate callbacks, not refresh periods. */
const MIN_PERIOD_S = 1 / 400
const MAX_PERIOD_S = 1 / 20
/** A sample within this fraction of the period counts as one clean refresh. */
const IN_BAND = 0.25
/** The running mean stops growing here and becomes a slow moving average. */
const MEAN_WINDOW = 240
/** Out-of-band samples in a row that mean the refresh rate changed: re-lock. */
const RELOCK_AFTER = 24
/** Fraction of the carried remainder returned to the sim each frame. */
const DEBT_GAIN = 0.03
/** Snap only when the frame is within this fraction of a period from a whole multiple. */
const SNAP_TOLERANCE = 0.4
export const MAX_FRAME_DT = 0.1

export class FramePacer {
  private readonly warm = new Float64Array(WARMUP)
  private warmCount = 0
  private locked = false
  private n = 0
  private outOfBand = 0
  private debt = 0
  period = 1 / 60

  /** Feed a raw frame delta (seconds) and get the paced sim step back. */
  next(rawDt: number): number {
    if (!Number.isFinite(rawDt) || rawDt <= 0) return 0
    const raw = Math.min(rawDt, MAX_FRAME_DT)
    this.observe(raw)
    if (!this.locked) return raw
    const p = this.period
    const total = raw + this.debt
    const frames = Math.max(1, Math.round(total / p))
    const residual = total - frames * p
    if (Math.abs(residual) > SNAP_TOLERANCE * p) {
      this.debt = 0
      return raw
    }
    const out = Math.min(frames * p + DEBT_GAIN * residual, MAX_FRAME_DT)
    this.debt = total - out
    return out
  }

  /** Track the refresh period without producing a step (used while paused). */
  observe(rawDt: number): void {
    if (!Number.isFinite(rawDt) || rawDt < MIN_PERIOD_S || rawDt > MAX_PERIOD_S) return
    if (!this.locked) {
      this.warm[this.warmCount++] = rawDt
      if (this.warmCount === WARMUP) this.lock()
      return
    }
    if (Math.abs(rawDt - this.period) <= IN_BAND * this.period) {
      this.n = Math.min(this.n + 1, MEAN_WINDOW)
      this.period += (rawDt - this.period) / this.n
      this.outOfBand = 0
    } else if (++this.outOfBand >= RELOCK_AFTER) {
      this.locked = false
      this.warmCount = 0
      this.debt = 0
    }
  }

  /** Forget carried timing debt (after a pause, a robot switch or a reset). */
  resetDebt(): void {
    this.debt = 0
  }

  private lock(): void {
    const med = medianOf(this.warm)
    let sum = 0
    let k = 0
    for (const v of this.warm) {
      if (Math.abs(v - med) <= IN_BAND * med) {
        sum += v
        k++
      }
    }
    this.period = k ? sum / k : med
    this.n = k
    this.locked = true
    this.outOfBand = 0
    this.debt = 0
  }
}

function medianOf(a: Float64Array): number {
  const s = Float64Array.from(a).sort()
  const n = s.length
  return n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2])
}
