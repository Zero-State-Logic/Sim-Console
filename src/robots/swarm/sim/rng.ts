/*
 * Seeded PRNG (mulberry32) plus a Box-Muller Gaussian. Deterministic so a reset, a
 * test or a replay sees exactly the same gusts.
 */
export class Rng {
  private state: number
  private spare = 0
  private hasSpare = false

  constructor(seed = 1) {
    this.state = seed >>> 0
  }

  reseed(seed: number): void {
    this.state = seed >>> 0
    this.hasSpare = false
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Standard normal sample. */
  gauss(): number {
    if (this.hasSpare) {
      this.hasSpare = false
      return this.spare
    }
    let u = this.next()
    while (u <= 1e-12) u = this.next()
    const v = this.next()
    const r = Math.sqrt(-2 * Math.log(u))
    this.spare = r * Math.sin(2 * Math.PI * v)
    this.hasSpare = true
    return r * Math.cos(2 * Math.PI * v)
  }
}
