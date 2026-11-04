/* ============================================================
   LOOP RATE METER — loop() completions per second of SIM time,
   over a sliding window. Fixed ring buffers: no per-tick garbage.
   ============================================================ */

const RING = 512

export class RateMeter {
  private readonly t = new Float64Array(RING)
  private readonly n = new Float64Array(RING)
  private head = 0
  private size = 0

  constructor(private readonly windowSec = 1) {}

  add(tSec: number, count: number): void {
    this.t[this.head] = tSec
    this.n[this.head] = count
    this.head = (this.head + 1) % RING
    if (this.size < RING) this.size++
  }

  /** Events per second over the window ending at the newest sample. */
  rate(): number {
    if (this.size < 2) return 0
    const newest = this.t[(this.head - 1 + RING) % RING]
    let total = 0
    let oldest = -1
    for (let k = 1; k <= this.size; k++) {
      const i = (this.head - k + RING) % RING
      if (newest - this.t[i] > this.windowSec) break
      total += this.n[i]
      oldest = i
    }
    const span = oldest < 0 ? 0 : newest - this.t[oldest]
    // the oldest sample only marks where the span starts; its events happened before it
    return span > 0 ? (total - this.n[oldest]) / span : 0
  }

  reset(): void {
    this.head = 0
    this.size = 0
  }
}
