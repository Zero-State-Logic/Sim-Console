import { describe, expect, it } from 'vitest'
import { WindField } from './wind'
import type { WindSettings } from './wind'
import { Rng } from './rng'
import { Battery, PACK_3S_850, rotorPower } from './battery'

describe('wind field', () => {
  it('equals the mean vector exactly when gusts are off', () => {
    // Arrange
    const w = new WindField(new Rng(1), 6)
    const set: WindSettings = { enabled: true, speed: 4, dirDeg: 90, gust: 0 }
    const out = new Float64Array(3)
    // Act
    for (let i = 0; i < 100; i++) w.step(0.01, set, 6)
    w.sample(out, 3)
    // Assert
    expect(out[0]).toBeCloseTo(0, 12)
    expect(out[1]).toBeCloseTo(4, 12)
    expect(out[2]).toBe(0)
  })

  it('produces Ornstein-Uhlenbeck gusts with the requested standard deviation', () => {
    const w = new WindField(new Rng(42), 1)
    const set: WindSettings = { enabled: true, speed: 0, dirDeg: 0, gust: 1.5 }
    let sum = 0, sumSq = 0, n = 0
    for (let i = 0; i < 200000; i++) {
      w.step(0.01, set, 1)
      if (i > 2000) {
        sum += w.gust[0]
        sumSq += w.gust[0] ** 2
        n++
      }
    }
    const mean = sum / n
    const std = Math.sqrt(sumSq / n - mean * mean)
    expect(Math.abs(mean)).toBeLessThan(0.3)
    expect(std).toBeGreaterThan(1.5 * 0.8)
    expect(std).toBeLessThan(1.5 * 1.2)
  })

  it('goes calm when disabled', () => {
    const w = new WindField(new Rng(1), 2)
    w.step(0.01, { enabled: true, speed: 5, dirDeg: 0, gust: 1 }, 2)
    w.step(0.01, { enabled: false, speed: 5, dirDeg: 0, gust: 1 }, 2)
    const out = new Float64Array(3)
    w.sample(out, 1)
    expect(Array.from(out)).toEqual([0, 0, 0])
  })

  it('is deterministic for a given seed', () => {
    const a = new WindField(new Rng(9), 1), b = new WindField(new Rng(9), 1)
    const set: WindSettings = { enabled: true, speed: 2, dirDeg: 30, gust: 1 }
    for (let i = 0; i < 50; i++) { a.step(0.01, set, 1); b.step(0.01, set, 1) }
    expect(Array.from(a.gust)).toEqual(Array.from(b.gust))
  })
})

describe('battery', () => {
  it('decreases monotonically under thrust', () => {
    // Arrange
    const b = new Battery()
    const hover = new Float64Array(4).fill((0.6 * 9.81) / 4)
    let prev = b.soc
    // Act + Assert
    for (let i = 0; i < 1000; i++) {
      b.drain(0.01, hover, true)
      expect(b.soc).toBeLessThan(prev)
      prev = b.soc
    }
  })

  it('draws about 95 W in hover, giving roughly six minutes of flight', () => {
    const hover = new Float64Array(4).fill((0.6 * 9.81) / 4)
    const p = rotorPower(hover, PACK_3S_850) + PACK_3S_850.avionicsW
    expect(p).toBeGreaterThan(80)
    expect(p).toBeLessThan(110)
    const minutes = PACK_3S_850.capacityJ / p / 60
    expect(minutes).toBeGreaterThan(5)
    expect(minutes).toBeLessThan(7)
  })

  it('scales with thrust^1.5 (momentum theory)', () => {
    const one = rotorPower([1], PACK_3S_850)
    const four = rotorPower([4], PACK_3S_850)
    expect(four / one).toBeCloseTo(8, 9)
  })

  it('does not drain while disarmed and never goes below zero', () => {
    const b = new Battery()
    b.drain(100, [3, 3, 3, 3], false)
    expect(b.soc).toBe(1)
    b.drain(1e6, [3, 3, 3, 3], true)
    expect(b.soc).toBe(0)
    expect(b.percent).toBe(0)
    b.reset(2)
    expect(b.soc).toBe(1)
    expect(b.voltage()).toBeGreaterThan(12)
  })
})
