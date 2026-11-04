/* Seeded PRNG (mulberry32) and Gaussian noise, so the virtual device is reproducible in tests. */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Uniform in [a, b). */
  range(a: number, b: number): number
  /** Normal(0, sigma). */
  gauss(sigma: number): number
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0
  let spare: number | null = null
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    range: (a, b) => a + (b - a) * next(),
    gauss: (sigma) => {
      if (spare !== null) {
        const v = spare
        spare = null
        return v * sigma
      }
      // Box-Muller; 1 - u keeps log() away from 0
      const u = 1 - next()
      const v = next()
      const r = Math.sqrt(-2 * Math.log(u))
      spare = r * Math.sin(2 * Math.PI * v)
      return r * Math.cos(2 * Math.PI * v) * sigma
    },
  }
}
