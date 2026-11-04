/*
 * Sliding-window time series for the streaming charts, keyed on sim time. The arrays
 * are mutated in place and exposed as one stable `data` tuple, so uPlot is fed the same
 * references every frame (no per-frame array allocation).
 */
export class SeriesBuffer {
  readonly xs: number[] = []
  readonly ys: number[][]
  /** [xs, ...ys] in uPlot's AlignedData layout. */
  readonly data: number[][]
  private lastT = Number.NEGATIVE_INFINITY

  constructor(
    readonly channels: number,
    public windowSec: number,
    /** Minimum sim-time spacing between samples (caps points per window). */
    readonly minDt = 1 / 60,
  ) {
    this.ys = Array.from({ length: channels }, () => [])
    this.data = [this.xs, ...this.ys]
  }

  get length(): number {
    return this.xs.length
  }

  get latestT(): number {
    return this.lastT
  }

  reset(): void {
    this.xs.length = 0
    for (const y of this.ys) y.length = 0
    this.lastT = Number.NEGATIVE_INFINITY
  }

  /**
   * Append a sample at sim time t; `value(i)` gives channel i. A clock that went backwards
   * (reset, robot switch) restarts the series. Returns true when a point was added.
   */
  push(t: number, value: (channel: number) => number): boolean {
    if (!Number.isFinite(t)) return false
    if (t < this.lastT) this.reset()
    if (this.xs.length > 0 && t - this.lastT < this.minDt - 1e-9) return false
    this.xs.push(t)
    for (let i = 0; i < this.channels; i++) {
      const v = value(i)
      this.ys[i].push(Number.isFinite(v) ? v : 0)
    }
    this.lastT = t
    this.trim(t)
    return true
  }

  /** Rebuild from recorded samples (oldest first) ending at `endT`, e.g. a replay cursor. */
  load(count: number, timeAt: (row: number) => number, value: (row: number, channel: number) => number, endT: number): void {
    this.reset()
    const from = endT - this.windowSec
    for (let row = 0; row < count; row++) {
      const t = timeAt(row)
      if (t > endT) break
      if (t < from) continue
      this.xs.push(t)
      for (let i = 0; i < this.channels; i++) {
        const v = value(row, i)
        this.ys[i].push(Number.isFinite(v) ? v : 0)
      }
      this.lastT = t
    }
  }

  /** Drop points older than the window, keeping one so the line meets the left edge. */
  private trim(t: number): void {
    const from = t - this.windowSec
    let drop = 0
    while (drop + 1 < this.xs.length && this.xs[drop + 1] <= from) drop++
    if (drop === 0) return
    dropFront(this.xs, drop)
    for (const y of this.ys) dropFront(y, drop)
  }
}

/** Remove the first k items in place (splice would allocate the removed slice). */
function dropFront(arr: number[], k: number): void {
  if (k === 1) {
    arr.shift()
    return
  }
  const n = arr.length
  for (let i = k; i < n; i++) arr[i - k] = arr[i]
  arr.length = Math.max(n - k, 0)
}

/** y-range with a little headroom when the chart has no fixed min/max. */
export function autoRange(ys: readonly number[][], fixedMin?: number, fixedMax?: number): [number, number] {
  if (fixedMin !== undefined && fixedMax !== undefined && fixedMax > fixedMin) return [fixedMin, fixedMax]
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const y of ys) {
    for (const v of y) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  if (fixedMin !== undefined) lo = fixedMin
  if (fixedMax !== undefined) hi = fixedMax
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [fixedMin ?? 0, fixedMax ?? 1]
  if (hi - lo < 1e-9) {
    const pad = Math.max(Math.abs(hi) * 0.1, 0.5)
    return [fixedMin ?? lo - pad, fixedMax ?? hi + pad]
  }
  const pad = (hi - lo) * 0.08
  return [fixedMin ?? lo - pad, fixedMax ?? hi + pad]
}
