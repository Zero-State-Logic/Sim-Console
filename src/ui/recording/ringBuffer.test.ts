import { describe, expect, it } from 'vitest'
import { RingBuffer, advanceSampleGrid, indexAtOrBefore, shouldSample } from './ringBuffer'

describe('RingBuffer', () => {
  it('rejects a non-positive or fractional capacity', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError)
    expect(() => new RingBuffer(2.5)).toThrow(RangeError)
  })

  it('keeps entries oldest-first while below capacity', () => {
    // Arrange
    const buf = new RingBuffer<number>(4)
    // Act
    buf.push(1)
    buf.push(2)
    buf.push(3)
    // Assert
    expect(buf.size).toBe(3)
    expect(buf.isFull).toBe(false)
    expect(buf.toArray()).toEqual([1, 2, 3])
    expect(buf.first()).toBe(1)
    expect(buf.last()).toBe(3)
  })

  it('overwrites the oldest entry once full', () => {
    const buf = new RingBuffer<number>(3)
    for (let i = 1; i <= 7; i++) buf.push(i)
    expect(buf.size).toBe(3)
    expect(buf.isFull).toBe(true)
    expect(buf.toArray()).toEqual([5, 6, 7])
    expect(buf.get(0)).toBe(5)
    expect(buf.get(2)).toBe(7)
  })

  it('returns undefined for out-of-range or fractional indices', () => {
    const buf = new RingBuffer<string>(2)
    buf.push('a')
    expect(buf.get(-1)).toBeUndefined()
    expect(buf.get(1)).toBeUndefined()
    expect(buf.get(0.5)).toBeUndefined()
  })

  it('clears to an empty buffer that accepts new pushes', () => {
    const buf = new RingBuffer<number>(2)
    buf.push(1)
    buf.push(2)
    buf.push(3)
    buf.clear()
    expect(buf.size).toBe(0)
    expect(buf.first()).toBeUndefined()
    buf.push(9)
    expect(buf.toArray()).toEqual([9])
  })

  it('loads a list keeping only the newest capacity entries', () => {
    const buf = new RingBuffer<number>(3)
    buf.load([1, 2, 3, 4, 5])
    expect(buf.toArray()).toEqual([3, 4, 5])
    buf.load([8])
    expect(buf.toArray()).toEqual([8])
  })
})

describe('indexAtOrBefore', () => {
  const key = (n: number): number => n

  it('returns -1 for an empty buffer', () => {
    expect(indexAtOrBefore(new RingBuffer<number>(4), 1, key)).toBe(-1)
  })

  it('finds the last entry at or before t, including after wrap-around', () => {
    // Arrange: capacity 4 after 6 pushes holds [0.3, 0.4, 0.5, 0.6]
    const buf = new RingBuffer<number>(4)
    for (const t of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) buf.push(t)
    // Act + Assert
    expect(indexAtOrBefore(buf, 0.45, key)).toBe(1)
    expect(indexAtOrBefore(buf, 0.5, key)).toBe(2)
    expect(indexAtOrBefore(buf, 0.6, key)).toBe(3)
  })

  it('clamps to the first and last entries outside the range', () => {
    const buf = new RingBuffer<number>(8)
    for (const t of [1, 2, 3]) buf.push(t)
    expect(indexAtOrBefore(buf, -5, key)).toBe(0)
    expect(indexAtOrBefore(buf, 99, key)).toBe(2)
  })
})

describe('shouldSample', () => {
  const period = 1 / 30

  it('samples the first frame and after a clock reset', () => {
    expect(shouldSample(0.5, Number.NEGATIVE_INFINITY, period)).toBe(true)
    expect(shouldSample(0.1, 4.0, period)).toBe(true)
  })

  it('skips frames closer than one period and takes the one at the boundary', () => {
    expect(shouldSample(1 + 1 / 60, 1, period)).toBe(false)
    expect(shouldSample(1 + 2 / 60, 1, period)).toBe(true)
  })

  it('never samples a non-finite time', () => {
    expect(shouldSample(Number.NaN, 0, period)).toBe(false)
  })

  it.each([50, 60, 75, 100, 144, 165])('keeps a 30 Hz average from a %i Hz loop when anchored to the grid', (hz) => {
    // Arrange
    let grid = Number.NEGATIVE_INFINITY
    let count = 0
    // Act: 10 s of sim
    for (let f = 1; f <= hz * 10; f++) {
      const t = f / hz
      if (shouldSample(t, grid, period)) {
        grid = advanceSampleGrid(t, grid, period)
        count++
      }
    }
    // Assert: 300 samples ± the first one
    expect(Math.abs(count - 300)).toBeLessThanOrEqual(1)
  })

  it('anchors the first sample and a clock reset at t, then steps along the grid', () => {
    expect(advanceSampleGrid(0.5, Number.NEGATIVE_INFINITY, period)).toBe(0.5)
    expect(advanceSampleGrid(0.1, 4, period)).toBe(0.1)
    // sampled 0.04 s after the grid point: the grid moves one period, not to t
    expect(advanceSampleGrid(1.04, 1, period)).toBeCloseTo(1 + 1 / 30, 12)
    // a long gap (frame drop) re-anchors on the last grid point before t, no catch-up burst
    expect(advanceSampleGrid(1.25, 1, period)).toBeCloseTo(1 + 7 / 30, 12)
  })

  it('yields 30 samples per second from a 60 Hz loop', () => {
    let last = Number.NEGATIVE_INFINITY
    let count = 0
    for (let f = 0; f < 60; f++) {
      const t = f / 60
      if (shouldSample(t, last, period)) {
        last = t
        count++
      }
    }
    expect(count).toBe(30)
  })
})
