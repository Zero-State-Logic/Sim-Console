import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReadoutDef } from '../core/types'
import { HUD_READOUT_SLOTS, pickHudReadouts } from './hudReadouts'
import { FrameStats } from './frameStats'
import { QUALITY_STORAGE_KEY } from './quality'

const ro = (key: string): ReadoutDef => ({ key, label: key.toUpperCase() })
const keys = (defs: ReadoutDef[]): string[] => defs.map((d) => d.key)

describe('pickHudReadouts', () => {
  it('prefers attitude readouts and keeps them in layout order', () => {
    // Arrange
    const defs = [ro('margin'), ro('pitch'), ro('speed'), ro('roll'), ro('current'), ro('power')]
    // Act
    const picked = pickHudReadouts(defs)
    // Assert
    expect(keys(picked)).toEqual(['margin', 'pitch', 'speed', 'roll'])
  })

  it('shows pose readouts of a mobile robot in layout order', () => {
    const defs = [ro('x'), ro('y'), ro('hdg'), ro('speed'), ro('path'), ro('status')]
    expect(keys(pickHudReadouts(defs))).toEqual(['x', 'y', 'hdg', 'speed'])
  })

  it('falls back to the first readouts when no priority key exists', () => {
    const defs = [ro('phase'), ro('status'), ro('shape'), ro('wp'), ro('minSep')]
    expect(keys(pickHudReadouts(defs))).toEqual(['phase', 'status', 'shape', 'wp'])
  })

  it('never returns more than the slot count or the available readouts', () => {
    const many = ['roll', 'pitch', 'yaw', 'hdg', 'x', 'y', 'z', 'alt'].map(ro)
    expect(pickHudReadouts(many)).toHaveLength(HUD_READOUT_SLOTS)
    expect(keys(pickHudReadouts(many))).toEqual(['roll', 'pitch', 'yaw', 'hdg'])
    expect(pickHudReadouts([ro('a')])).toHaveLength(1)
    expect(pickHudReadouts([])).toEqual([])
    expect(pickHudReadouts([ro('a')], 0)).toEqual([])
  })
})

describe('FrameStats', () => {
  // binary fractions (1/64, 1/16) sum exactly, so the window boundary is deterministic
  it('reports frames per second averaged over the half-second window', () => {
    // Arrange
    const s = new FrameStats()
    // Act: 32 frames of 1/64 s = exactly 0.5 s
    for (let i = 0; i < 32; i++) s.tick(1 / 64)
    // Assert
    expect(s.fps).toBe(64)
  })

  it('keeps the last value until a full window has elapsed', () => {
    const s = new FrameStats()
    for (let i = 0; i < 32; i++) s.tick(1 / 64)
    for (let i = 0; i < 4; i++) s.tick(1 / 16)
    expect(s.fps).toBe(64)
    for (let i = 0; i < 4; i++) s.tick(1 / 16)
    expect(s.fps).toBe(16)
  })

  it('ignores zero, negative and NaN steps', () => {
    const s = new FrameStats()
    s.tick(0)
    s.tick(-1)
    s.tick(Number.NaN)
    expect(s.fps).toBe(0)
  })
})

describe('initialQuality', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('uses the remembered choice over device detection', async () => {
    // Arrange
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === QUALITY_STORAGE_KEY ? 'high' : null), setItem: () => undefined })
    const { initialQuality } = await import('./device')
    // Act + Assert: no WebGL in Node would otherwise detect LOW
    expect(initialQuality()).toBe('high')
  })

  it('detects LOW when storage is blocked and WebGL2 is missing', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => undefined,
    })
    const { initialQuality, probeWebGL } = await import('./device')
    expect(probeWebGL()).toEqual({ webgl: false, webgl2: false })
    expect(initialQuality()).toBe('low')
  })

  it('remembers a manual choice and survives a storage that refuses writes', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) })
    const { rememberQuality, initialQuality } = await import('./device')
    rememberQuality('high')
    expect(store.get(QUALITY_STORAGE_KEY)).toBe('high')
    expect(initialQuality()).toBe('high')
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    })
    expect(() => rememberQuality('low')).not.toThrow()
  })
})
