import { describe, expect, it } from 'vitest'
import {
  BELLY_HEIGHT,
  DEFAULT_DIMS,
  DIM_RANGES,
  LEG_COUNTS,
  buildLayout,
  clampDims,
  heightRange,
  isLegCount,
  jointName,
  maxFootRadius,
  standHeightFor,
  type WalkerDims,
} from './geometry'
import { IK_OUT_OF_REACH, bodyToLeg, legIK } from './kinematics'

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

describe('buildLayout', () => {
  it('mirrors the left side onto the right (y → −y) for 4, 6 and 8 legs', () => {
    for (const n of LEG_COUNTS) {
      const L = buildLayout(n, DEFAULT_DIMS)
      const half = n / 2
      for (let i = 0; i < half; i++) {
        expect(L.side[i]).toBe(-1)
        expect(L.side[i + half]).toBe(1)
        expect(L.mountX[i + half]).toBeCloseTo(L.mountX[i], 12)
        expect(L.mountY[i + half]).toBeCloseTo(-L.mountY[i], 12)
        expect(L.mountYaw[i + half]).toBeCloseTo(-L.mountYaw[i], 12)
      }
    }
  })

  it('mounts radially on the body circle with the foot further out along the mount yaw', () => {
    const L = buildLayout(6, DEFAULT_DIMS)
    for (let i = 0; i < 6; i++) {
      expect(Math.hypot(L.mountX[i], L.mountY[i])).toBeCloseTo(DEFAULT_DIMS.bodyRadius, 12)
      expect(Math.atan2(L.mountY[i], L.mountX[i])).toBeCloseTo(L.mountYaw[i], 12)
      expect(Math.hypot(L.neutralX[i] - L.mountX[i], L.neutralY[i] - L.mountY[i])).toBeCloseTo(L.footReach, 12)
    }
    expect(maxFootRadius(L)).toBeCloseTo(DEFAULT_DIMS.bodyRadius + L.footReach, 12)
  })

  it('puts four legs on the corners of a rectangle and eight on a regular octagon', () => {
    const q = buildLayout(4, DEFAULT_DIMS)
    expect(Math.abs(q.mountX[0])).toBeCloseTo(Math.abs(q.mountX[1]), 12)
    const o = buildLayout(8, DEFAULT_DIMS)
    const yaws = Array.from(o.mountYaw).map((a) => (a * 180) / Math.PI).sort((a, b) => a - b)
    for (let k = 1; k < 8; k++) expect(yaws[k] - yaws[k - 1]).toBeCloseTo(45, 9)
  })
})

describe('heightRange', () => {
  it('keeps the neutral foot reachable at both ends for random dimensions', () => {
    const rand = rng(11)
    const q = new Float64Array(3)
    const leg = new Float64Array(3)
    for (let k = 0; k < 300; k++) {
      const pick = (key: keyof WalkerDims): number => DIM_RANGES[key][0] + rand() * (DIM_RANGES[key][1] - DIM_RANGES[key][0])
      const d: WalkerDims = { coxa: pick('coxa'), femur: pick('femur'), tibia: pick('tibia'), bodyRadius: pick('bodyRadius') }
      const L = buildLayout(6, d)
      const [lo, hi] = heightRange(d)
      expect(lo).toBeGreaterThan(BELLY_HEIGHT)
      expect(hi).toBeGreaterThan(lo)
      for (const h of [lo, hi]) {
        bodyToLeg(L.mountX[0], L.mountY[0], L.mountYaw[0], L.neutralX[0], L.neutralY[0], -h, leg, 0)
        // a joint limit may still bind for extreme links, but the foot itself is in reach
        expect(legIK(d, leg[0], leg[1], leg[2], q, 0) & IK_OUT_OF_REACH).toBe(0)
      }
    }
  })

  it('stands the default robot at the reference height of 85 mm', () => {
    expect(standHeightFor(DEFAULT_DIMS)).toBe(0.085)
    const [lo, hi] = heightRange(DEFAULT_DIMS)
    expect(lo).toBeLessThan(0.085)
    expect(hi).toBeGreaterThan(0.15)
  })
})

describe('helpers', () => {
  it('clamps dimensions into their slider ranges', () => {
    expect(clampDims({ coxa: 1, femur: 0, tibia: 0.1, bodyRadius: -1 })).toEqual({ coxa: 0.08, femur: 0.04, tibia: 0.1, bodyRadius: 0.07 })
  })

  it('names joints leg-major and recognises leg counts', () => {
    expect(jointName(0)).toBe('L1 coxa')
    expect(jointName(5)).toBe('L2 tibia')
    expect(jointName(23)).toBe('L8 tibia')
    expect(isLegCount(6)).toBe(true)
    expect(isLegCount(5)).toBe(false)
  })
})
