import { describe, expect, it } from 'vitest'
import { buildLayout, DEFAULT_DIMS, LEG_COUNTS, type LegCount } from './geometry'
import { gaitsFor, type GaitDef } from './gaits'
import { GaitEngine, type GaitParams, type TwistCmd } from './gaitEngine'

const DT = 1 / 60

function params(over: Partial<GaitParams> = {}): GaitParams {
  return { freq: 1.2, stride: 0.06, stepHeight: 0.035, duty: 0.5, treadmill: false, ...over }
}

function engine(n: LegCount, gaitIndex = 0): { e: GaitEngine; g: GaitDef } {
  const L = buildLayout(n, DEFAULT_DIMS)
  const g = gaitsFor(L)[gaitIndex]
  return { e: new GaitEngine(L, g), g }
}

function walk(e: GaitEngine, cmd: TwistCmd, p: GaitParams, seconds: number, each?: () => void): void {
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    e.step(DT, cmd, p)
    each?.()
  }
}

describe('GaitEngine', () => {
  it('keeps stance feet fixed in the world while the body walks and turns (no skate)', () => {
    for (const n of LEG_COUNTS) {
      const { e, g } = engine(n)
      const p = params({ duty: g.duty })
      const prev = new Float64Array(n * 3)
      const was = new Uint8Array(n)
      let checked = 0
      walk(e, { vx: 0.08, vy: 0.02, wz: 0.3 }, p, 3, () => {
        for (let i = 0; i < n; i++) {
          if (was[i] && e.contact[i]) {
            for (let k = 0; k < 3; k++) expect(e.feet[i * 3 + k]).toBe(prev[i * 3 + k])
            checked++
          }
          was[i] = e.contact[i]
          for (let k = 0; k < 3; k++) prev[i * 3 + k] = e.feet[i * 3 + k]
        }
      })
      expect(checked).toBeGreaterThan(100)
    }
  })

  it('translates the body in the world from the commanded twist', () => {
    const { e, g } = engine(6)
    walk(e, { vx: 0.1, vy: 0, wz: 0 }, params({ duty: g.duty }), 4)
    // first-order ramp (τ = 0.18 s) costs about τ·v of distance
    expect(e.frame[0]).toBeGreaterThan(0.1 * 4 - 0.1 * 0.3)
    expect(e.frame[0]).toBeLessThan(0.1 * 4)
    expect(Math.abs(e.frame[1])).toBeLessThan(1e-9)
    expect(e.odometer).toBeCloseTo(e.frame[0], 9)
  })

  it('turns the heading CCW for a positive yaw rate', () => {
    const { e, g } = engine(6)
    walk(e, { vx: 0, vy: 0, wz: 0.4 }, params({ duty: g.duty }), 2)
    expect(e.frame[2]).toBeGreaterThan(0.6)
  })

  it('keeps at least three feet down for every statically stable gait while walking', () => {
    for (const n of LEG_COUNTS) {
      const L = buildLayout(n, DEFAULT_DIMS)
      for (const g of gaitsFor(L).filter((x) => x.staticallyStable)) {
        const e = new GaitEngine(L, g)
        let min: number = n
        walk(e, { vx: 0.06, vy: 0, wz: 0.1 }, params({ duty: g.duty }), 4, () => { min = Math.min(min, e.stanceCount()) })
        expect(min, `${n} legs ${g.id}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('lifts swing feet smoothly up to the step height and back to the ground', () => {
    const { e, g } = engine(6)
    const p = params({ duty: g.duty })
    let maxZ = 0
    let minZ = Infinity
    walk(e, { vx: 0.08, vy: 0, wz: 0 }, p, 3, () => {
      for (let i = 0; i < 6; i++) {
        maxZ = Math.max(maxZ, e.feet[i * 3 + 2])
        minZ = Math.min(minZ, e.feet[i * 3 + 2])
      }
    })
    expect(maxZ).toBeGreaterThan(0.95 * p.stepHeight)
    expect(maxZ).toBeLessThanOrEqual(p.stepHeight + 1e-12)
    expect(minZ).toBe(0)
  })

  it('limits the twist so no foot travels more than the stride per stance', () => {
    const { e, g } = engine(6)
    const p = params({ duty: g.duty })
    walk(e, { vx: 5, vy: 0, wz: 3 }, p, 2)
    expect(e.driveUtil).toBeLessThanOrEqual(1 + 1e-9)
    expect(e.driveUtil).toBeGreaterThan(0.9)
  })

  it('reports the top speed from stride, frequency and duty', () => {
    const { e, g } = engine(6)
    const p = params({ duty: g.duty })
    expect(e.maxSpeed(p)).toBeCloseTo((0.06 * 1.2) / 0.5, 12)
    expect(e.maxYawRate(p)).toBeGreaterThan(0)
  })

  it('settles: once stopped, feet come back to neutral and stepping stops', () => {
    const { e, g } = engine(6)
    const p = params({ duty: g.duty })
    walk(e, { vx: 0.1, vy: 0, wz: 0.2 }, p, 2)
    walk(e, { vx: 0, vy: 0, wz: 0 }, p, 3)
    const before = e.feet.slice()
    walk(e, { vx: 0, vy: 0, wz: 0 }, p, 1)
    expect(e.stanceCount()).toBe(6)
    for (let k = 0; k < 18; k++) expect(e.feet[k]).toBeCloseTo(before[k], 9)
  })

  it('keeps the body centred on the treadmill while the feet keep stepping', () => {
    const { e, g } = engine(6)
    const p = params({ duty: g.duty, treadmill: true })
    let swings = 0
    walk(e, { vx: 0.1, vy: 0, wz: 0 }, p, 3, () => { swings += e.swinging.reduce((a, b) => a + b, 0) })
    expect(e.frame[0]).toBe(0)
    expect(e.frame[1]).toBe(0)
    expect(swings).toBeGreaterThan(0)
    expect(e.odometer).toBeGreaterThan(0.2)
    // planted feet drift backwards relative to the centred body
    expect(e.twist[0]).toBeGreaterThan(0.09)
  })

  it('moves the treadmill belt exactly with the planted feet (feet ride the belt)', () => {
    const { e, g } = engine(6)
    const p = params({ duty: g.duty, treadmill: true })
    const onBelt = new Float64Array(12)
    const was = new Uint8Array(6)
    let checked = 0
    walk(e, { vx: 0.08, vy: 0.02, wz: 0.25 }, p, 3, () => {
      const c = Math.cos(e.ground[2])
      const s = Math.sin(e.ground[2])
      for (let i = 0; i < 6; i++) {
        const fx = e.feet[i * 3] - e.ground[0]
        const fy = e.feet[i * 3 + 1] - e.ground[1]
        // belt coordinates of the foot: R(−angle)·(foot − offset)
        const bx = c * fx + s * fy
        const by = -s * fx + c * fy
        if (was[i] && e.contact[i]) {
          expect(bx).toBeCloseTo(onBelt[i * 2], 9)
          expect(by).toBeCloseTo(onBelt[i * 2 + 1], 9)
          checked++
        }
        onBelt[i * 2] = bx
        onBelt[i * 2 + 1] = by
        was[i] = e.contact[i]
      }
    })
    expect(checked).toBeGreaterThan(100)
    expect(Math.hypot(e.ground[0], e.ground[1])).toBeGreaterThan(0.05)
  })

  it('sways the quadruped body toward the support triangle during the crawl', () => {
    const { e, g } = engine(4)
    expect(g.id).toBe('crawl')
    let maxSway = 0
    walk(e, { vx: 0.05, vy: 0, wz: 0 }, params({ duty: g.duty }), 4, () => { maxSway = Math.max(maxSway, Math.hypot(e.sway[0], e.sway[1])) })
    expect(maxSway).toBeGreaterThan(0.02)
    expect(maxSway).toBeLessThan(0.1)
  })

  it('replants every foot at neutral on reset and layout change', () => {
    const { e, g } = engine(6)
    walk(e, { vx: 0.1, vy: 0, wz: 0 }, params({ duty: g.duty }), 1)
    e.reset(1, 2, 0)
    expect(e.frame[0]).toBe(1)
    expect(e.stanceCount()).toBe(6)
    expect(e.feet[0]).toBeCloseTo(1 + e.layout.neutralX[0], 12)
    const L8 = buildLayout(8, DEFAULT_DIMS)
    e.setLayout(L8, gaitsFor(L8)[0])
    expect(e.stanceCount()).toBe(8)
  })

  it('lets a swing in flight finish when the gait changes', () => {
    const L = buildLayout(6, DEFAULT_DIMS)
    const gaits = gaitsFor(L)
    const e = new GaitEngine(L, gaits[0])
    const p = params({ duty: 0.5 })
    walk(e, { vx: 0.1, vy: 0, wz: 0 }, p, 0.6)
    const z = Array.from({ length: 6 }, (_, i) => e.feet[i * 3 + 2])
    e.setGait(gaits[2])
    e.step(DT, { vx: 0.1, vy: 0, wz: 0 }, { ...p, duty: gaits[2].duty })
    for (let i = 0; i < 6; i++) expect(Math.abs(e.feet[i * 3 + 2] - z[i])).toBeLessThan(0.01)
  })
})
