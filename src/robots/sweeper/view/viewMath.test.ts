import { describe, expect, it } from 'vitest'
import { HALF_LENGTH, HALF_WIDTH, WHEEL_RADIUS } from '../constants'
import { mecanumInverse } from '../mecanum'
import { COVER_ALPHA, FREE_ALPHA, OCC_ALPHA, paintCoverage, paintOccupancy } from './mapColors'
import { ROLLER_SIGN, rollerLayout } from './rollerLayout'

const WHEEL_XY: [number, number][] = [[HALF_LENGTH, HALF_WIDTH], [HALF_LENGTH, -HALF_WIDTH], [-HALF_LENGTH, HALF_WIDTH], [-HALF_LENGTH, -HALF_WIDTH]]

describe('mecanum roller layout', () => {
  it('puts roller 0 at the floor contact with a 45 degree axis in the ground plane', () => {
    const r = rollerLayout(9, 0.03, -1)[0]
    expect(r.pz).toBeCloseTo(-0.03)
    expect(Math.hypot(r.ax, r.ay, r.az)).toBeCloseTo(1)
    expect(r.az).toBeCloseTo(0)
    expect(Math.abs(r.ax)).toBeCloseTo(Math.SQRT1_2)
  })

  it('keeps every roller on its circle with a unit axis', () => {
    for (const r of rollerLayout(9, 0.03, 1)) {
      expect(Math.hypot(r.px, r.pz)).toBeCloseTo(0.03)
      expect(Math.hypot(r.ax, r.ay, r.az)).toBeCloseTo(1)
    }
  })

  it('has contact rollers that reproduce the inverse kinematics of mecanum.ts', () => {
    // a wheel only drives the floor along its contact-roller axis a:
    //   r w (x . a) = v_contact . a   with v_contact = (vx - wz y, vy + wz x)
    const out = [0, 0, 0, 0]
    for (const [vx, vy, wz] of [[0.3, 0, 0], [0, 0.2, 0], [0, 0, 1.1], [0.15, -0.25, -0.7]]) {
      mecanumInverse(vx, vy, wz, out)
      WHEEL_XY.forEach(([x, y], i) => {
        const a = rollerLayout(9, 0.03, ROLLER_SIGN[i])[0]
        const along = (vx - wz * y) * a.ax + (vy + wz * x) * a.ay
        expect((along / a.ax) / WHEEL_RADIUS).toBeCloseTo(out[i], 9)
      })
    }
  })
})

describe('map colors', () => {
  it('draws unknown transparent, free faint, occupied dark and contacts strongest', () => {
    const lo = new Float32Array([0, -4, 4, 0])
    const contact = new Uint8Array([0, 0, 0, 1])
    const out = new Uint8Array(16)
    paintOccupancy(lo, contact, out)
    expect(out[3]).toBe(0)
    expect(out[7]).toBe(FREE_ALPHA)
    expect(out[11]).toBe(OCC_ALPHA)
    expect(out[15]).toBeGreaterThan(OCC_ALPHA)
    expect([out[4], out[5], out[6]]).toEqual([12, 143, 155])
  })

  it('grows the alpha with the evidence', () => {
    const out = new Uint8Array(8)
    paintOccupancy(new Float32Array([0.8, 1.6]), new Uint8Array(2), out)
    expect(out[3]).toBeGreaterThan(0)
    expect(out[7]).toBeGreaterThan(out[3])
  })

  it('paints covered cells orange', () => {
    const out = new Uint8Array(8)
    paintCoverage(new Uint8Array([1, 0]), out)
    expect(Array.from(out)).toEqual([255, 90, 31, COVER_ALPHA, 255, 90, 31, 0])
  })
})
