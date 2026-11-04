import { describe, expect, it } from 'vitest'
import { buildLayout, DEFAULT_DIMS, LEG_COUNTS } from './geometry'
import { MAX_DUTY, defaultGaitId, effectiveDuty, gaitsFor, localPhase, stanceCountAt } from './gaits'

const SAMPLES = 2000

describe('gaitsFor', () => {
  it('offers only the valid gaits for each leg count', () => {
    expect(gaitsFor(buildLayout(4, DEFAULT_DIMS)).map((g) => g.id)).toEqual(['crawl', 'trot', 'pace'])
    expect(gaitsFor(buildLayout(6, DEFAULT_DIMS)).map((g) => g.id)).toEqual(['tripod', 'ripple', 'wave'])
    expect(gaitsFor(buildLayout(8, DEFAULT_DIMS)).map((g) => g.id)).toEqual(['tetrapod', 'ripple', 'wave'])
  })

  it('puts the default gait first', () => {
    for (const n of LEG_COUNTS) expect(gaitsFor(buildLayout(n, DEFAULT_DIMS))[0].id).toBe(defaultGaitId(n))
  })

  it('has one offset per leg in [0, 1) and duty factors within (0, 1)', () => {
    for (const n of LEG_COUNTS) {
      for (const g of gaitsFor(buildLayout(n, DEFAULT_DIMS))) {
        expect(g.offsets).toHaveLength(n)
        for (const o of g.offsets) {
          expect(o).toBeGreaterThanOrEqual(0)
          expect(o).toBeLessThan(1)
        }
        expect(g.duty).toBeGreaterThanOrEqual(g.minDuty)
        expect(g.duty).toBeLessThanOrEqual(MAX_DUTY)
        expect(g.minDuty).toBeGreaterThan(0)
      }
    }
  })

  it('keeps at least three feet down for every statically stable gait at its minimum duty', () => {
    for (const n of LEG_COUNTS) {
      for (const g of gaitsFor(buildLayout(n, DEFAULT_DIMS)).filter((x) => x.staticallyStable)) {
        let min: number = n
        for (let k = 0; k < SAMPLES; k++) min = Math.min(min, stanceCountAt(g, g.minDuty, k / SAMPLES))
        expect(min, `${n} legs ${g.id}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('marks trot and pace as dynamically stable only (two feet down)', () => {
    const quad = gaitsFor(buildLayout(4, DEFAULT_DIMS))
    for (const id of ['trot', 'pace']) {
      const g = quad.find((x) => x.id === id)
      expect(g?.staticallyStable).toBe(false)
      if (g) expect(stanceCountAt(g, g.duty, 0.25)).toBe(2)
    }
  })

  it('swings one leg at a time in the wave gait, back to front, right side first', () => {
    const L = buildLayout(6, DEFAULT_DIMS)
    const wave = gaitsFor(L).find((g) => g.id === 'wave')
    expect(wave).toBeDefined()
    if (!wave) return
    const order: number[] = []
    for (let k = 0; k < SAMPLES; k++) {
      const phi = k / SAMPLES
      for (let i = 0; i < 6; i++) {
        if (localPhase(wave, i, phi) >= wave.duty && order[order.length - 1] !== i && !order.includes(i)) order.push(i)
      }
      expect(stanceCountAt(wave, wave.duty, phi)).toBeGreaterThanOrEqual(5)
    }
    // legs 0..2 = right front→rear, 3..5 = left front→rear; rotate so the first swing leads
    const start = order.indexOf(2)
    const seq = [...order.slice(start), ...order.slice(0, start)]
    expect(seq).toEqual([2, 1, 0, 5, 4, 3])
  })

  it('uses alternating tripods for 6 legs (front-right, rear-right, middle-left together)', () => {
    const tripod = gaitsFor(buildLayout(6, DEFAULT_DIMS))[0]
    expect(tripod.offsets[0]).toBe(tripod.offsets[2])
    expect(tripod.offsets[0]).toBe(tripod.offsets[4])
    expect(tripod.offsets[1]).toBe(tripod.offsets[3])
    expect(tripod.offsets[1]).toBe(tripod.offsets[5])
    expect(Math.abs(tripod.offsets[0] - tripod.offsets[1])).toBe(0.5)
  })

  it('creeps in the LH → LF → RH → RF sequence for the quadruped crawl', () => {
    const crawl = gaitsFor(buildLayout(4, DEFAULT_DIMS))[0]
    // swing starts at φ = offset + duty; order legs by swing start
    const starts = crawl.offsets.map((o, i) => ({ i, s: (o + crawl.duty) % 1 }))
    starts.sort((a, b) => a.s - b.s)
    const seq = starts.map((x) => x.i)
    const lh = seq.indexOf(3)
    const rotated = [...seq.slice(lh), ...seq.slice(0, lh)]
    expect(rotated).toEqual([3, 2, 1, 0])
  })
})

describe('crawl timing', () => {
  it('gives the crawl a four-feet window at every allowed duty and a slower default cycle', () => {
    const quad = gaitsFor(buildLayout(4, DEFAULT_DIMS))
    const crawl = quad[0]
    // four-feet windows are (4β − 3)/4 of the cycle each: they vanish at β = 0.75
    expect(crawl.minDuty).toBeGreaterThan(0.75)
    let four = 0
    for (let k = 0; k < SAMPLES; k++) if (stanceCountAt(crawl, crawl.duty, k / SAMPLES) === 4) four++
    expect(four / SAMPLES).toBeCloseTo(4 * crawl.duty - 3, 2)
    // 200 ms four-feet windows at the default timing
    expect((4 * crawl.duty - 3) / 4 / crawl.freq).toBeGreaterThan(0.19)
    for (const g of [...quad.slice(1), ...gaitsFor(buildLayout(6, DEFAULT_DIMS))]) expect(g.freq).toBeGreaterThan(crawl.freq)
  })
})

describe('effectiveDuty', () => {
  it('clamps a requested duty into the gait range', () => {
    const tripod = gaitsFor(buildLayout(6, DEFAULT_DIMS))[0]
    expect(effectiveDuty(tripod, 0.2)).toBe(0.5)
    expect(effectiveDuty(tripod, 0.7)).toBe(0.7)
    expect(effectiveDuty(tripod, 1.5)).toBe(MAX_DUTY)
  })
})
