import { describe, expect, it } from 'vitest'
import { buildLayout, DEFAULT_DIMS } from '../robots/walker/geometry'
import { gaitsFor as simGaitsFor } from '../robots/walker/gaits'
import { classifyLegs, CRAWL_DUTY, gaitKeys, gaitsFor, legPhase, swingCount } from './gaits'
import { walkerGeom } from './testing/fixtures'

const PHASES = Array.from({ length: 400 }, (_, i) => i / 400)

describe('gait tables for the on-board gait', () => {
  it.each([4, 6, 8] as const)('matches the sim gait tables for %i legs (same offsets, same order)', (legs) => {
    const ours = gaitsFor(walkerGeom(legs))
    const sim = simGaitsFor(buildLayout(legs, DEFAULT_DIMS))
    expect(ours.map((g) => g.name)).toEqual(sim.map((g) => g.id))
    ours.forEach((g, i) => {
      g.offsets.forEach((o, leg) => expect(o).toBeCloseTo(sim[i].offsets[leg], 4))
      expect(g.duty).toBeCloseTo(sim[i].duty, 4)
      expect(g.creep).toBe(sim[i].sway)
    })
  })

  it('classifies legs by side and front-to-back rank', () => {
    const cls = classifyLegs(walkerGeom(6))
    expect(cls.map((c) => c.side)).toEqual([0, 0, 0, 1, 1, 1])
    expect(cls.map((c) => c.rank)).toEqual([0, 1, 2, 0, 1, 2])
  })

  it.each([6, 8] as const)('keeps at least half the legs down in the alternating gait for %i legs', (legs) => {
    const alt = gaitsFor(walkerGeom(legs))[0]
    for (const p of PHASES) expect(swingCount(alt, p)).toBeLessThanOrEqual(legs / 2)
  })

  it.each([6, 8] as const)('swings one leg at a time in the wave gait for %i legs', (legs) => {
    const wave = gaitsFor(walkerGeom(legs)).find((g) => g.name === 'wave')
    for (const p of PHASES) expect(swingCount(wave ?? gaitsFor(walkerGeom(legs))[2], p)).toBeLessThanOrEqual(1)
  })

  it('runs the quadruped crawl as a creep: one foot up at a time, with the body sway on', () => {
    const crawl = gaitsFor(walkerGeom(4))[0]
    expect(crawl.duty).toBe(CRAWL_DUTY)
    expect(crawl.creep).toBe(true)
    for (const p of PHASES) expect(swingCount(crawl, p)).toBeLessThanOrEqual(1)
    // lateral sequence: left hind, left front, right hind, right front (legs: RF 0, RH 1, LF 2, LH 3)
    const swingStart = crawl.offsets.map((o) => (o + crawl.duty) % 1)
    const order = [0, 1, 2, 3].sort((a, b) => swingStart[a] - swingStart[b])
    const fromLh = order.slice(order.indexOf(3)).concat(order.slice(0, order.indexOf(3)))
    expect(fromLh).toEqual([3, 2, 1, 0])
  })

  it('uses the sim convention for the leg phase (phase minus offset)', () => {
    const g = { name: 't', aliases: [], duty: 0.5, offsets: [0.25], creep: false }
    expect(legPhase(g, 0, 0.1)).toBeCloseTo(0.85, 9)
  })

  it('lists primary names first, then aliases without duplicates', () => {
    const keys = gaitKeys(gaitsFor(walkerGeom(6)))
    expect(keys.slice(0, 3).map((k) => k.key)).toEqual(['tripod', 'ripple', 'wave'])
    expect(new Set(keys.map((k) => k.key)).size).toBe(keys.length)
    expect(keys.find((k) => k.key === 'tetrapod')?.index).toBe(0)
  })
})
