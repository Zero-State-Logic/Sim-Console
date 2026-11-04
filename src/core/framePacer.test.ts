import { describe, expect, it } from 'vitest'
import { FramePacer } from './framePacer'

/*
 * Realistic rAF timing: callbacks land at i*period plus bounded noise, so each delta is
 * period + noise_i - noise_(i-1). Deterministic LCG so failures reproduce.
 */
function rafDeltas(period: number, n: number, noise: number, seed = 7): number[] {
  let s = seed
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return (s / 4294967296) * 2 - 1
  }
  let prev = 0
  const out: number[] = []
  for (let i = 1; i <= n; i++) {
    const t = i * period + noise * rnd()
    out.push(t - prev)
    prev = t
  }
  return out
}

function spread(xs: number[]): number {
  return Math.max(...xs) - Math.min(...xs)
}

describe('FramePacer', () => {
  it('turns ±1.5 ms rAF jitter at 60 Hz into steps that are even to within 1 %', () => {
    // Arrange
    const pacer = new FramePacer()
    const deltas = rafDeltas(1 / 60, 600, 0.0015)

    // Act
    const steps = deltas.map((d) => pacer.next(d)).slice(60)

    // Assert: raw deltas swing by ~30 % of a frame, paced steps by well under 1 %
    expect(spread(deltas.slice(60))).toBeGreaterThan((1 / 60) * 0.25)
    expect(spread(steps)).toBeLessThan((1 / 60) * 0.01)
    for (const s of steps) expect(Math.abs(s - 1 / 60)).toBeLessThan((1 / 60) * 0.01)
  })

  it('locks onto a 144 Hz display', () => {
    const pacer = new FramePacer()
    const steps = rafDeltas(1 / 144, 600, 0.0006).map((d) => pacer.next(d)).slice(60)
    expect(spread(steps)).toBeLessThan((1 / 144) * 0.01)
    expect(pacer.period).toBeCloseTo(1 / 144, 4)
  })

  it('never lets sim time drift from wall time by more than one period', () => {
    const pacer = new FramePacer()
    let wall = 0
    let sim = 0
    for (const d of rafDeltas(1 / 60, 1200, 0.0018)) {
      wall += d
      sim += pacer.next(d)
      expect(Math.abs(wall - sim)).toBeLessThanOrEqual(1 / 60 + 1e-6)
    }
  })

  it('turns a dropped frame into exactly two periods', () => {
    const pacer = new FramePacer()
    for (const d of rafDeltas(1 / 60, 120, 0.001)) pacer.next(d)
    pacer.resetDebt()

    const step = pacer.next(2 / 60 + 0.0012)

    // two whole periods plus a few percent of the remainder bled back in
    expect(Math.abs(step - 2 * pacer.period)).toBeLessThan(pacer.period * 0.01)
  })

  it('passes an irregular hitch through and clamps a long stall', () => {
    const pacer = new FramePacer()
    for (const d of rafDeltas(1 / 60, 120, 0.001)) pacer.next(d)
    pacer.resetDebt()

    expect(pacer.next(1.5 / 60)).toBeCloseTo(1.5 / 60, 9)
    expect(pacer.next(5)).toBeLessThanOrEqual(0.1)
  })

  it('re-locks when the window moves to a monitor with a different refresh rate', () => {
    const pacer = new FramePacer()
    for (const d of rafDeltas(1 / 60, 200, 0.001)) pacer.next(d)

    for (const d of rafDeltas(1 / 144, 200, 0.0005, 99)) pacer.next(d)

    expect(pacer.period).toBeCloseTo(1 / 144, 4)
  })

  it('returns 0 for invalid deltas', () => {
    const pacer = new FramePacer()
    expect(pacer.next(0)).toBe(0)
    expect(pacer.next(-1)).toBe(0)
    expect(pacer.next(Number.NaN)).toBe(0)
  })
})
