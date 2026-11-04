import { describe, expect, it } from 'vitest'
import type { Vec3Tuple, WorldConfig } from '../core/types'
import {
  FOLLOW_ID,
  clampDistance,
  easeInOutCubic,
  findPreset,
  presetIds,
  safePresetPosition,
  smoothingAlpha,
  tweenInto,
} from './cameraMath'
import { detectQuality, parseStoredQuality, qualityProfile } from './quality'

const WORLD: WorldConfig = {
  gridCellSize: 0.1,
  gridSectionSize: 0.5,
  gridFadeDistance: 12,
  shadowScale: 3,
  minDistance: 0.4,
  maxDistance: 8,
  cameraPresets: [
    { id: 'iso', label: 'ISO', position: [1, 1, 1], target: [0, 0, 0] },
    { id: 'top', label: 'TOP', position: [0, 3, 0], target: [0, 0, 0] },
  ],
}

describe('easing and smoothing', () => {
  it('eases from 0 to 1 symmetrically and clamps outside', () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(0.5)).toBe(0.5)
    expect(easeInOutCubic(1)).toBe(1)
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1)
    expect(easeInOutCubic(2)).toBe(1)
  })

  it('gives a frame-rate independent smoothing factor', () => {
    const one = smoothingAlpha(6, 1 / 30)
    const twoHalves = 1 - (1 - smoothingAlpha(6, 1 / 60)) ** 2
    expect(one).toBeCloseTo(twoHalves, 10)
    expect(smoothingAlpha(6, 0)).toBe(0)
    expect(smoothingAlpha(0, 1)).toBe(0)
  })
})

describe('presets', () => {
  it('lists module presets then follow, without duplicating follow', () => {
    expect(presetIds(WORLD)).toEqual(['iso', 'top', FOLLOW_ID])
    const withFollow = { ...WORLD, cameraPresets: [...WORLD.cameraPresets, { id: 'follow', label: 'F', position: [0, 1, 1] as Vec3Tuple, target: [0, 0, 0] as Vec3Tuple }] }
    expect(presetIds(withFollow)).toEqual(['iso', 'top', FOLLOW_ID])
  })

  it('finds presets by id', () => {
    expect(findPreset(WORLD, 'top')?.label).toBe('TOP')
    expect(findPreset(WORLD, 'nope')).toBeNull()
  })

  it('nudges a straight-down view off the vertical and leaves others alone', () => {
    const top = safePresetPosition([0, 3, 0], [0, 0, 0])
    expect(top[0]).toBe(0)
    expect(top[1]).toBe(3)
    expect(top[2]).toBeGreaterThan(0)
    const iso: Vec3Tuple = [1, 1, 1]
    expect(safePresetPosition(iso, [0, 0, 0])).toBe(iso)
  })

  it('tweens along the eased path into a reused tuple', () => {
    const out: Vec3Tuple = [0, 0, 0]
    const res = tweenInto(out, [0, 0, 0], [2, 4, -2], 0.5)
    expect(res).toBe(out)
    expect(out).toEqual([1, 2, -1])
    tweenInto(out, [0, 0, 0], [2, 4, -2], 1)
    expect(out).toEqual([2, 4, -2])
  })

  it('clamps distance to the zoom limits', () => {
    expect(clampDistance(0.1, WORLD)).toBe(0.4)
    expect(clampDistance(20, WORLD)).toBe(8)
    expect(clampDistance(2, WORLD)).toBe(2)
  })
})

describe('quality detection', () => {
  const desktop = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130', cores: 12, webgl2: true }

  it('picks high on a capable desktop', () => {
    expect(detectQuality(desktop)).toBe('high')
  })

  it('picks low for phones, few cores or no WebGL2', () => {
    expect(detectQuality({ ...desktop, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' })).toBe('low')
    expect(detectQuality({ ...desktop, userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' })).toBe('low')
    expect(detectQuality({ ...desktop, cores: 4 })).toBe('low')
    expect(detectQuality({ ...desktop, webgl2: false })).toBe('low')
  })

  it('treats unknown core counts as capable', () => {
    expect(detectQuality({ ...desktop, cores: 0 })).toBe('high')
  })

  it('parses only valid stored choices', () => {
    expect(parseStoredQuality('low')).toBe('low')
    expect(parseStoredQuality('ultra')).toBeNull()
    expect(parseStoredQuality(null)).toBeNull()
  })

  it('enables postprocessing and larger shadow maps only on high', () => {
    expect(qualityProfile('high').postprocessing).toBe(true)
    expect(qualityProfile('low').postprocessing).toBe(false)
    expect(qualityProfile('high').shadowMapSize).toBeGreaterThan(qualityProfile('low').shadowMapSize)
  })
})
