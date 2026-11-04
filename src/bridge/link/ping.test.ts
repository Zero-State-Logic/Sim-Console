import { describe, expect, it } from 'vitest'
import { PING_INTERVAL_MS, PingTracker, RateMeter, STALE_MS, isStale } from './ping'

describe('PingTracker', () => {
  it('is due immediately, then once per interval', () => {
    const p = new PingTracker()
    expect(p.due(0)).toBe(true)
    p.issue(0)
    expect(p.due(PING_INTERVAL_MS - 1)).toBe(false)
    expect(p.due(PING_INTERVAL_MS)).toBe(true)
  })

  it('measures RTT from the matching pong and smooths it', () => {
    const p = new PingTracker()
    const a = p.issue(0)
    expect(p.resolve(a, 10)).toBe(10)
    expect(p.rtt).toBe(10)
    const b = p.issue(1000)
    expect(p.resolve(b, 1030)).toBe(30)
    expect(p.lastRtt).toBe(30)
    expect(p.rtt).toBeCloseTo(15, 6)
  })

  it('ignores unknown and duplicate pong ids', () => {
    const p = new PingTracker()
    const id = p.issue(0)
    expect(p.resolve(999, 5)).toBeNull()
    expect(p.resolve(id, 5)).toBe(5)
    expect(p.resolve(id, 6)).toBeNull()
  })

  it('bounds the pending map when the board never answers', () => {
    const p = new PingTracker()
    for (let i = 0; i < 50; i++) p.issue(i * 1000)
    expect(p.pendingCount).toBeLessThanOrEqual(8)
  })

  it('reset() clears RTT and pending pings', () => {
    const p = new PingTracker()
    p.resolve(p.issue(0), 4)
    p.reset()
    expect(p.rtt).toBeNull()
    expect(p.pendingCount).toBe(0)
    expect(p.due(0)).toBe(true)
  })
})

describe('RateMeter', () => {
  it('reports lines and bytes per second once the window closes', () => {
    const m = new RateMeter(1000)
    m.update(0)
    for (let i = 0; i < 25; i++) m.add(40, i * 40)
    expect(m.update(999)).toBe(false)
    expect(m.update(1000)).toBe(true)
    expect(m.perSec).toBe(25)
    expect(m.bytesPerSec).toBe(1000)
  })

  it('drops to zero after a silent window', () => {
    const m = new RateMeter(1000)
    m.update(0)
    m.add(10, 1)
    m.update(1000)
    m.update(2000)
    expect(m.perSec).toBe(0)
  })
})

describe('isStale', () => {
  it('is fresh within STALE_MS of the last tel and stale after', () => {
    expect(isStale(1000 + STALE_MS, 1000, 0)).toBe(false)
    expect(isStale(1001 + STALE_MS, 1000, 0)).toBe(true)
  })

  it('counts from the verify time when no tel arrived yet', () => {
    expect(isStale(400, null, 0)).toBe(false)
    expect(isStale(600, null, 0)).toBe(true)
    expect(isStale(600, 10, 300)).toBe(false)
  })
})
