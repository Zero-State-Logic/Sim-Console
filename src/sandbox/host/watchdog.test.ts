import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STALL_GRACE_MS, Watchdog, realTimers } from './watchdog'

describe('Watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function make() {
    const bites: string[] = []
    const dog = new Watchdog<'tick' | 'load'>(realTimers, () => Date.now(), (r) => bites.push(r))
    return { dog, bites }
  }

  /** Advance time while the page keeps rendering frames (heartbeat every 16 ms). */
  function runFrames(dog: Watchdog<'tick' | 'load'>, ms: number): void {
    for (let t = 0; t < ms; t += 16) {
      vi.advanceTimersByTime(16)
      dog.heartbeat()
    }
  }

  it('bites once the limit passes without a disarm', () => {
    // Arrange
    const { dog, bites } = make()
    // Act
    dog.arm(1000, 'tick')
    runFrames(dog, 990)
    const early = [...bites]
    runFrames(dog, 40)
    // Assert
    expect(early).toEqual([])
    expect(bites).toEqual(['tick'])
    expect(dog.armed).toBe(false)
  })

  it('never bites after a disarm', () => {
    const { dog, bites } = make()
    dog.arm(1000, 'tick')
    runFrames(dog, 500)
    dog.disarm()
    runFrames(dog, 2000)
    expect(bites).toEqual([])
  })

  it('restarts the countdown when re-armed', () => {
    const { dog, bites } = make()
    dog.arm(1000, 'tick')
    runFrames(dog, 800)
    dog.arm(1000, 'tick')
    runFrames(dog, 800)
    expect(bites).toEqual([])
    runFrames(dog, 300)
    expect(bites).toEqual(['tick'])
  })

  it('bites on time in strict mode even with no frames at all', () => {
    // Arrange
    const { dog, bites } = make()
    // Act: no heartbeats (the drive source left CODE)
    dog.arm(1000, 'tick', true)
    vi.advanceTimersByTime(999)
    const early = [...bites]
    vi.advanceTimersByTime(2)
    // Assert
    expect(early).toEqual([])
    expect(bites).toEqual(['tick'])
  })

  it('reports why it is armed', () => {
    const { dog } = make()
    expect(dog.pending).toBeNull()
    dog.arm(1000, 'load')
    expect(dog.pending).toBe('load')
    dog.disarm()
    expect(dog.pending).toBeNull()
  })

  it('waits another period when the main thread stopped rendering', () => {
    const { dog, bites } = make()
    dog.arm(1000, 'load')
    // no heartbeats: the tab was hidden or the page stalled
    vi.advanceTimersByTime(1000 + STALL_GRACE_MS)
    expect(bites).toEqual([])
    // frames resume; the worker still has not answered
    runFrames(dog, 1020)
    expect(bites).toEqual(['load'])
  })
})
