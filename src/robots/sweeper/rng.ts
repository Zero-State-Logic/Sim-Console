/*
 * Seeded PRNG (mulberry32) with a Box-Muller Gaussian. Deterministic, so a seed
 * reproduces LiDAR noise, slip and RANDOMIZE layouts exactly (tests rely on this).
 */
export class Rng {
  private s: number
  private spare = 0
  private hasSpare = false

  constructor(seed = 0x5eed) {
    this.s = seed >>> 0
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next()
  }

  /** Standard normal sample. */
  gauss(): number {
    if (this.hasSpare) {
      this.hasSpare = false
      return this.spare
    }
    let u = 0
    while (u <= 1e-12) u = this.next()
    const v = this.next()
    const mag = Math.sqrt(-2 * Math.log(u))
    this.spare = mag * Math.sin(2 * Math.PI * v)
    this.hasSpare = true
    return mag * Math.cos(2 * Math.PI * v)
  }
}
