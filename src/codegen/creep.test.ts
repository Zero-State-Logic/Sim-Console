import { describe, expect, it } from 'vitest'
import { creepPoint as simCreepPoint, triangleMargin } from '../robots/walker/creep'
import { CREEP, creepPoint, supportTri, triMargin } from './creep'
import type { Tri } from './creep'
import { gaitsFor, legPhase } from './gaits'
import { GaitRef } from './gaitRef'
import { generateFirmware } from './index'
import { hwFor, request, walkerGeom, walkerSpec } from './testing/fixtures'
import { gaitFoot, gaitTuning, neutralFeet } from './walkerGeom'

/* The on-board crawl must keep the body over the three planted feet whenever one swings. */

/** MG996R no-load speed at 4.8 V (0.17 s / 60°), the slowest servo the presets assume. */
const SERVO_DEG_S = 350

const DT = 0.01
const TWISTS: [string, number, number, number][] = [
  ['forward', 0.05, 0, 0],
  ['backward', -0.05, 0, 0],
  ['left', 0, 0.05, 0],
  ['right', 0, -0.05, 0],
  ['diagonal back-right', -0.03, -0.03, 0],
  ['turning CCW', 0, 0, 0.3],
  ['turning CW', 0, 0, -0.3],
  ['arc', 0.04, 0, -0.25],
  ['fast forward (stride-limited)', 0.3, 0, 0],
]

function ref(legs: 4 | 6 | 8): GaitRef {
  const g = walkerGeom(legs)
  const feet = neutralFeet(g)
  return new GaitRef(g, gaitsFor(g), gaitTuning(g), feet.x, feet.y)
}

/** Worst body margin inside the support triangle while a foot is off the ground, plus lift-offs and IK misses. */
function runCrawl(vx: number, vy: number, wz: number, seconds: number): { worst: number; lifts: number; misses: number } {
  const r = ref(4)
  r.v[0] = vx
  r.v[1] = vy
  r.v[2] = wz
  const up = [false, false, false, false]
  let worst = Infinity
  let lifts = 0
  let misses = 0
  r.step(0)
  for (let s = 0; s < seconds / DT; s++) {
    misses += r.step(DT).length
    for (let i = 0; i < 4; i++) {
      const air = r.footZ[i] > 0.0005
      if (air && !up[i]) lifts++
      up[i] = air
      if (air) worst = Math.min(worst, triMargin(supportTri(r.footX, r.footY, i), r.swayX, r.swayY))
    }
  }
  return { worst, lifts, misses }
}

describe('creep geometry (same math as the sim)', () => {
  const tris: Tri[] = [
    [0.18, -0.15, -0.18, -0.15, 0.18, 0.15],
    [0.2, -0.1, -0.15, -0.16, -0.17, 0.14],
    [-0.05, 0.02, 0.21, 0.13, 0.03, -0.19],
    [0.01, 0.01, 0.02, 0.012, 0.015, 0.03],
  ]

  it('measures the signed edge distance exactly like the sim', () => {
    for (const t of tris) {
      for (const [px, py] of [[0, 0], [0.05, -0.02], [0.3, 0.3], [-0.1, 0.04]]) {
        expect(triMargin(t, px, py)).toBeCloseTo(triangleMargin(t[0], t[1], t[2], t[3], t[4], t[5], px, py), 12)
      }
    }
  })

  it('picks the same creep point as the sim', () => {
    const out = new Float64Array(2)
    for (const t of tris) {
      const ours = creepPoint(t)
      expect(simCreepPoint(t[0], t[1], t[2], t[3], t[4], t[5], CREEP.margin, out, 0)).toBe(true)
      expect(ours?.[0]).toBeCloseTo(out[0], 12)
      expect(ours?.[1]).toBeCloseTo(out[1], 12)
    }
  })

  it('reports a collinear triangle as degenerate', () => {
    expect(creepPoint([0, 0, 0.1, 0, 0.2, 0])).toBeNull()
  })
})

describe('on-board quadruped crawl', () => {
  it('needs the sway: without it the body leaves the support triangle walking backward', () => {
    const g = walkerGeom(4)
    const crawl = gaitsFor(g)[0]
    const feet = neutralFeet(g)
    let worst = Infinity
    for (let k = 0; k < 1000; k++) {
      const p = k / 1000
      const f = [0, 1, 2, 3].map((i) => gaitFoot(feet.x[i], feet.y[i], -0.06, 0, legPhase(crawl, i, p), crawl.duty, 0.02, 0.08))
      const swing = [0, 1, 2, 3].find((i) => legPhase(crawl, i, p) >= crawl.duty)
      if (swing === undefined) continue
      worst = Math.min(worst, triMargin(supportTri(f.map((v) => v[0]), f.map((v) => v[1]), swing), 0, 0))
    }
    expect(worst).toBeLessThan(0)
  })

  it.each(TWISTS)('keeps the body at least the lift-off gate (8 mm) inside the planted feet walking %s', (_name, vx, vy, wz) => {
    const { worst, lifts, misses } = runCrawl(vx, vy, wz, 20)
    expect(worst).toBeGreaterThan(CREEP.gate)
    // the lift-off gate waits but never deadlocks: about one lift every half second
    expect(lifts).toBeGreaterThan(30)
    expect(misses).toBe(0)
  })

  it('re-centres the body once the command stops', () => {
    const r = ref(4)
    r.v[0] = -0.05
    for (let s = 0; s < 500; s++) r.step(DT)
    r.v[0] = 0
    for (let s = 0; s < 500; s++) r.step(DT)
    expect(Math.hypot(r.swayX, r.swayY)).toBeLessThan(0.001)
  })

  it('leaves the 6- and 8-leg gaits unswayed', () => {
    for (const legs of [6, 8] as const) {
      const r = ref(legs)
      r.v[0] = 0.05
      for (let s = 0; s < 300; s++) r.step(DT)
      expect([r.swayX, r.swayY]).toEqual([0, 0])
    }
  })
})

describe('swing-time floor', () => {
  it.each([4, 6, 8] as const)('keeps every %i-leg gait within MG996R speed at full command', (legs) => {
    const gaits = gaitsFor(walkerGeom(legs))
    for (let gi = 0; gi < gaits.length; gi++) {
      for (const [, vx, vy, wz] of TWISTS) {
        const r = ref(legs)
        r.index = gi
        r.v[0] = vx * 6
        r.v[1] = vy * 6
        r.v[2] = wz * 5
        const prev = r.q.slice()
        let peak = 0
        for (let s = 0; s < 800; s++) {
          r.step(DT)
          if (s > 50) for (let j = 0; j < prev.length; j++) peak = Math.max(peak, Math.abs(r.q[j] - prev[j]) / DT)
          for (let j = 0; j < prev.length; j++) prev[j] = r.q[j]
        }
        expect(peak, `${gaits[gi].name}`).toBeLessThan(SERVO_DEG_S)
      }
    }
  })
})

describe('generated creep code', () => {
  const quad = generateFirmware(request(walkerSpec(4), hwFor('esp32', 'ws', 'pca9685', 12), 'high'))
  const hexa = generateFirmware(request(walkerSpec(6), hwFor('esp32', 'ws', 'pca9685', 18), 'high'))
  const piQuad = generateFirmware(request(walkerSpec(4), hwFor('pizero2w', 'ws', 'pca9685', 12), 'high'))
  const file = (r: typeof quad, name: string) => r.files.find((f) => f.path.endsWith(name))?.content ?? ''

  it('adds the sway and the lift-off gate to the 4-leg C++ gait only', () => {
    const h = file(quad, 'kiyobridge.h')
    expect(quad.errors).toEqual([])
    expect(h).toContain('static const uint8_t KIYO_GAIT_CREEP[KIYO_GAITS] = { 1, 0, 0 };')
    expect(h).toContain(`#define KIYO_CREEP_GATE ${CREEP.gate}f`)
    expect(h).toContain('gait.phase += creepAdvance(duty, dt / cycle);')
    expect(h).toContain('legIk(i, gFootX[i] - swayX, gFootY[i] - swayY, -gait.hs + gFootZ[i], q)')
    const six = file(hexa, 'kiyobridge.h')
    expect(six).not.toContain('creepAdvance')
    expect(six).toContain('gait.phase += dt / cycle;')
    expect(six).toContain('#define KIYO_SWING_MIN_S 0.3f')
  })

  it('adds the same creep to the 4-leg Pi daemon', () => {
    const py = file(piQuad, 'kiyobridge.py')
    expect(piQuad.errors).toEqual([])
    expect(py).toContain('GAIT_CREEP = [True, False, False]')
    expect(py).toContain('self.phase = frac(self.phase + self.creep_advance(duty, dt / cycle))')
    expect(py).toContain('def creep_point(self, skip):')
    expect(py).toContain('SWING_MIN_S = 0.3')
  })
})
