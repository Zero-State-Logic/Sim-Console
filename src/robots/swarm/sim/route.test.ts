import { describe, expect, it } from 'vitest'
import {
  CORNER_DV,
  ROUTE_ACCEL,
  cornerSpeed,
  createRoute,
  isRouteMode,
  lagFactor,
  nextTarget,
  peekNext,
  resetRoute,
  stepRoute,
} from './route'
import type { RouteMode } from './route'

const DT = 0.01

/** Time for a leg of length len entered and left at vc with cruise v and the route's accel limit. */
function trapezoidLegTime(len: number, vc: number, v: number): number {
  const ramp = (v - vc) / ROUTE_ACCEL
  const rampDist = (v * v - vc * vc) / (2 * ROUTE_ACCEL)
  return 2 * ramp + (len - 2 * rampDist) / v
}

function sequence(mode: RouteMode, n: number, steps: number): (number | 'done')[] {
  const st = createRoute()
  const seq: (number | 'done')[] = [st.target]
  for (let i = 0; i < steps; i++) {
    nextTarget(st, mode, n)
    seq.push(st.done ? 'done' : st.target)
    if (st.done) break
  }
  return seq
}

describe('route progression', () => {
  it('LOOP wraps from the last waypoint back to the first', () => {
    expect(sequence('loop', 4, 6)).toEqual([0, 1, 2, 3, 0, 1, 2])
  })

  it('PING-PONG reverses at both ends without repeating the end points', () => {
    expect(sequence('pingpong', 4, 8)).toEqual([0, 1, 2, 3, 2, 1, 0, 1, 2])
  })

  it('ONCE stops after the last waypoint', () => {
    expect(sequence('once', 3, 6)).toEqual([0, 1, 2, 'done'])
  })

  it('handles a single waypoint in every mode', () => {
    expect(sequence('loop', 1, 2)).toEqual([0, 0, 0])
    expect(sequence('pingpong', 1, 2)).toEqual([0, 0, 0])
    expect(sequence('once', 1, 2)).toEqual([0, 'done'])
  })

  it('visits the waypoints in order, never exceeding the cruise speed or the acceleration limit', () => {
    // Arrange: a 10 m square flown at 2 m/s
    const wps = new Float64Array([10, 0, 10, 10, 0, 10, 0, 0])
    const st = createRoute()
    resetRoute(st, 0, 0)
    const visited: number[] = []
    const arrivals: number[] = []
    let last = st.target
    let prevSpeed = 0
    let maxSpeedGain = 0
    // Act: 32 s, enough for a full lap with corner braking
    for (let i = 0; i < 3200; i++) {
      stepRoute(st, wps, 4, 'loop', 2, DT)
      const speed = Math.hypot(st.vx, st.vy)
      maxSpeedGain = Math.max(maxSpeedGain, speed - prevSpeed)
      prevSpeed = speed
      expect(speed).toBeLessThanOrEqual(2 + 1e-9)
      if (st.target !== last) {
        visited.push(last)
        arrivals.push((i + 1) * DT)
        last = st.target
      }
    }
    // Assert
    expect(visited.slice(0, 5)).toEqual([0, 1, 2, 3, 0])
    expect(maxSpeedGain).toBeLessThanOrEqual(ROUTE_ACCEL * DT + 1e-9)
    // a corner-to-corner leg matches the trapezoidal profile (accelerate, cruise, brake)
    const legTime = arrivals[2] - arrivals[1]
    expect(legTime).toBeGreaterThan(trapezoidLegTime(10, cornerSpeed(0, 1, -1, 0, 2), 2) * 0.97)
    expect(legTime).toBeLessThan(trapezoidLegTime(10, cornerSpeed(0, 1, -1, 0, 2), 2) * 1.03)
  })

  it('brakes into a corner so the velocity jump there stays within CORNER_DV', () => {
    // Arrange: a right-angle turn
    const wps = new Float64Array([8, 0, 8, 8])
    const st = createRoute()
    resetRoute(st, 0, 0)
    let maxJump = 0
    // Act
    for (let i = 0; i < 1500 && !st.done; i++) {
      const vx = st.vx, vy = st.vy
      stepRoute(st, wps, 2, 'once', 3, DT)
      maxJump = Math.max(maxJump, Math.hypot(st.vx - vx, st.vy - vy))
    }
    // Assert: the turn is smooth (the discrete step may overshoot the corner speed by
    // about a·dt on arrival and add a·dt on exit) and a ONCE route stops at its end
    expect(maxJump).toBeLessThanOrEqual(CORNER_DV + 3 * ROUTE_ACCEL * DT)
    expect(st.done).toBe(true)
    expect([st.x, st.y, st.vx, st.vy]).toEqual([8, 8, 0, 0])
  })

  it('allows full speed on a straight continuation and slows harder the sharper the turn', () => {
    expect(cornerSpeed(1, 0, 1, 0, 2)).toBe(2)
    expect(cornerSpeed(1, 0, 0, 1, 2)).toBeCloseTo(CORNER_DV / Math.SQRT2, 12)
    expect(cornerSpeed(1, 0, -1, 0, 2)).toBeCloseTo(CORNER_DV / 2, 12)
    expect(cornerSpeed(0, 0, 1, 0, 2)).toBe(2)
  })

  it('looks ahead to the waypoint after the target in every mode', () => {
    const st = createRoute()
    st.target = 3
    expect(peekNext(st, 'loop', 4)).toBe(0)
    expect(peekNext(st, 'once', 4)).toBe(-1)
    expect(peekNext(st, 'pingpong', 4)).toBe(2)
    st.target = 0
    st.dir = -1
    expect(peekNext(st, 'pingpong', 4)).toBe(1)
    expect(peekNext(st, 'loop', 1)).toBe(-1)
  })

  it('holds still with no waypoints, and stops for good once a ONCE route is finished', () => {
    // Arrange
    const st = createRoute()
    resetRoute(st, 3, 4)
    // Act + Assert: no route, no motion
    stepRoute(st, new Float64Array(0), 0, 'loop', 2, 0.1)
    expect([st.x, st.y, st.vx, st.vy]).toEqual([3, 4, 0, 0])
    // a single waypoint 0.1 m away: reached within a few steps, then done
    const wps = new Float64Array([3.1, 4])
    for (let i = 0; i < 20 && !st.done; i++) stepRoute(st, wps, 1, 'once', 2, 0.1)
    expect(st.done).toBe(true)
    expect([st.x, st.y]).toEqual([3.1, 4])
    stepRoute(st, wps, 1, 'once', 2, 0.1)
    expect([st.x, st.y, st.vx, st.vy]).toEqual([3.1, 4, 0, 0])
  })

  it('slows the reference when the leader lags behind', () => {
    expect(lagFactor(0)).toBe(1)
    expect(lagFactor(2)).toBeCloseTo(0.5, 12)
    expect(lagFactor(10)).toBe(0.1)
  })

  it('validates mode names', () => {
    expect(isRouteMode('pingpong')).toBe(true)
    expect(isRouteMode('zigzag')).toBe(false)
  })
})
