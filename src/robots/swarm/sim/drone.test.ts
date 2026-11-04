import { describe, expect, it } from 'vitest'
import { Drone, CRASH_SPEED } from './drone'
import { DEFAULT_GAINS, DEFAULT_LIMITS, RATE_INT_MAX, positionLoop } from './controller'
import type { Gains } from './controller'
import { mixerGeom } from './mixer'
import { QUAD_250 } from './params'
import { quatCosTilt, quatToEuler, quatYaw } from './quat'
import type { Integrator } from './dynamics'

const p = QUAD_250
const geom = mixerGeom(p)

interface FlyOpts {
  gains?: Gains
  hz?: number
  integrator?: Integrator
  onStep?: (d: Drone, t: number) => void
}

/** Closed loop: position loop at 100 Hz, inner loops + physics at `hz`. */
function fly(d: Drone, x: number, y: number, z: number, seconds: number, o: FlyOpts = {}): void {
  const hz = o.hz ?? 1000
  const h = 1 / hz
  const g = o.gains ?? DEFAULT_GAINS
  const every = Math.round(hz / 100)
  d.target.set([x, y, z])
  d.targetVel.fill(0)
  const n = Math.round(seconds * hz)
  for (let k = 0; k < n; k++) {
    if (k % every === 0) positionLoop(d.vSp, d.s, d.target, d.targetVel, g, DEFAULT_LIMITS)
    d.controlStep(h, p, g, DEFAULT_LIMITS, geom)
    d.physicsStep(h, p, o.integrator ?? 'rk4', geom)
    o.onStep?.(d, k * h)
  }
}

function hovering(z = 2): Drone {
  const d = new Drone(0)
  d.placeOnGround(0, 0, 0, p)
  d.arm()
  fly(d, 0, 0, z, 6)
  return d
}

describe('drone closed loop', () => {
  it('takes off from the ground and holds hover with total thrust = m·g', () => {
    // Arrange + Act
    const d = hovering(2)
    fly(d, 0, 0, 2, 4)
    // Assert
    expect(Math.abs(d.s[2] - 2)).toBeLessThan(0.005)
    expect(Math.hypot(d.s[3], d.s[4], d.s[5])).toBeLessThan(1e-3)
    expect(d.totalThrust).toBeCloseTo(p.mass * p.g, 2)
    expect(d.mode).toBe('flying')
  })

  it('settles a 2 m position step within a few seconds with bounded overshoot (default gains)', () => {
    const d = hovering(2)
    let maxX = 0
    let settleT = 0
    fly(d, 2, 0, 2, 8, {
      onStep: (dd, t) => {
        maxX = Math.max(maxX, dd.s[0])
        if (Math.abs(dd.s[0] - 2) > 0.05) settleT = t
      },
    })
    expect(settleT).toBeLessThan(4.5)
    expect(maxX - 2).toBeLessThan(0.3)
    expect(Math.abs(d.s[0] - 2)).toBeLessThan(0.02)
    expect(Math.abs(d.s[2] - 2)).toBeLessThan(0.02)
  })

  it('also settles at 500 Hz and 2 kHz physics, and with semi-implicit Euler', () => {
    for (const hz of [500, 2000]) {
      const d = hovering(2)
      fly(d, 1.5, -1, 2.5, 6, { hz })
      expect(Math.hypot(d.s[0] - 1.5, d.s[1] + 1, d.s[2] - 2.5)).toBeLessThan(0.03)
    }
    const e = hovering(2)
    fly(e, 1, 1, 2, 6, { integrator: 'euler' })
    expect(Math.hypot(e.s[0] - 1, e.s[1] - 1, e.s[2] - 2)).toBeLessThan(0.03)
  })

  it('respects the tilt limit on a large horizontal step', () => {
    const d = hovering(3)
    let minCos = 1
    fly(d, 15, 0, 3, 5, { onStep: (dd) => { minCos = Math.min(minCos, quatCosTilt(dd.s, 6)) } })
    const maxTiltDeg = (Math.acos(minCos) * 180) / Math.PI
    expect(maxTiltDeg).toBeLessThan(35 + 4)
    expect(maxTiltDeg).toBeGreaterThan(15)
  })

  it('keeps the velocity integrator bounded while saturated (anti-windup)', () => {
    const d = hovering(3)
    fly(d, 60, 0, 3, 6)
    const iMax = DEFAULT_LIMITS.maxIntAcc / DEFAULT_GAINS.velI
    for (const v of d.ctrl.velInt) expect(Math.abs(v)).toBeLessThanOrEqual(iMax + 1e-9)
  })

  it('oscillates violently when the rate loop is too slow for the attitude loop', () => {
    const d = hovering(3)
    const bad: Gains = { ...DEFAULT_GAINS, attP: 20, rateP: 3, rateD: 0 }
    let maxTilt = 0
    let minZ = 3
    fly(d, 2, 0, 3, 10, {
      gains: bad,
      onStep: (dd) => {
        maxTilt = Math.max(maxTilt, Math.acos(Math.min(1, quatCosTilt(dd.s, 6))))
        minZ = Math.min(minZ, dd.s[2])
      },
    })
    expect((maxTilt * 180) / Math.PI).toBeGreaterThan(50)
    expect(minZ).toBeLessThan(2.5)
  })

  it('tips over and crashes in wind with no rate control', () => {
    const d = hovering(3)
    d.wind[0] = 3
    fly(d, 2, 0, 3, 10, { gains: { ...DEFAULT_GAINS, rateP: 0 } })
    expect(d.mode).toBe('crashed')
  })

  it('rejects a steady 3 m/s wind with zero steady-state error (velocity integrator)', () => {
    const d = hovering(3)
    d.wind[0] = 3
    fly(d, 0, 0, 3, 20)
    expect(Math.hypot(d.s[0], d.s[1], d.s[2] - 3)).toBeLessThan(0.01)
  })

  it('leans upwind by exactly atan(drag / weight) while holding station in a steady wind', () => {
    // Arrange: wind blowing toward +x at 4 m/s, gusts off
    const d = hovering(3)
    const w = 4
    d.wind[0] = w
    // Act
    fly(d, 0, 0, 3, 25)
    // Assert: thrust along body z balances drag and weight, so tan(tilt) = D / (m·g)
    const drag = (p.dragLin + p.dragQuad * w) * w
    const expected = Math.atan(drag / (p.mass * p.g))
    const eul = quatToEuler(new Float64Array(3), d.s, 6)
    expect(Math.acos(quatCosTilt(d.s, 6))).toBeCloseTo(expected, 3)
    // nose up (REP-103 pitch < 0) leans the thrust into a wind blowing toward +x
    expect(eul[1]).toBeCloseTo(-expected, 3)
    expect(Math.abs(eul[0])).toBeLessThan(1e-3)
    expect(d.totalThrust).toBeCloseTo(Math.hypot(drag, p.mass * p.g), 2)
  })

  it('holds station with zero steady error in an 8 m/s wind, leaning atan(2.88 N / m·g) ≈ 26°', () => {
    // Arrange
    const d = hovering(3)
    const w = 8
    d.wind[0] = w
    // Act
    fly(d, 0, 0, 3, 40)
    // Assert: drag 2.88 N needs 4.8 m/s², inside the integrator's tilt-limited bound
    const drag = (p.dragLin + p.dragQuad * w) * w
    expect(drag).toBeCloseTo(2.88, 6)
    expect(Math.hypot(d.s[0], d.s[1], d.s[2] - 3)).toBeLessThan(0.01)
    expect(Math.acos(quatCosTilt(d.s, 6))).toBeCloseTo(Math.atan(drag / (p.mass * p.g)), 3)
  })

  it('reaches the drag-limited top speed at the tilt limit: the rate I term cancels the flapping moment', () => {
    // Arrange: the speed limit is lifted so only the 35° tilt limit binds
    const lim = { ...DEFAULT_LIMITS, maxVelXY: 30 }
    const dash = (gains: Gains): { v: number; tilt: number } => {
      const d = hovering(3)
      d.target.set([500, 0, 3])
      for (let k = 0; k < 20000; k++) {
        if (k % 10 === 0) positionLoop(d.vSp, d.s, d.target, d.targetVel, gains, lim)
        d.controlStep(1e-3, p, gains, lim, geom)
        d.physicsStep(1e-3, p, 'rk4', geom)
      }
      return { v: d.s[3], tilt: Math.acos(quatCosTilt(d.s, 6)) }
    }
    // level flight at the limit: horizontal force m·g·tan 35° = 0.12·v + 0.03·v²
    const F = p.mass * p.g * Math.tan(DEFAULT_LIMITS.maxTilt)
    const vT = (-p.dragLin + Math.sqrt(p.dragLin ** 2 + 4 * p.dragQuad * F)) / (2 * p.dragQuad)
    // Act
    const withI = dash(DEFAULT_GAINS)
    const withoutI = dash({ ...DEFAULT_GAINS, rateI: 0 })
    // Assert
    expect(vT).toBeCloseTo(9.89, 2)
    expect(withI.v).toBeCloseTo(vT, 1)
    expect(withI.tilt).toBeCloseTo(DEFAULT_LIMITS.maxTilt, 2)
    // P/D only: steady attitude error kFlap·v / (Ixx·rateP·attP) ≈ 6°, so it flies slower
    expect(withoutI.v).toBeLessThan(vT - 0.6)
  })

  it('holds the rate integrator at zero on the ground and within its bound in the air', () => {
    // Arrange: armed on the gear with a setpoint it cannot reach (below the gear, 3 m away)
    const d = new Drone(0)
    d.placeOnGround(0, 0, 0, p)
    d.arm()
    fly(d, 3, 0, 0, 2)
    // Assert: still pinned, nothing integrated against the ground
    expect(d.contact).toBe(true)
    expect(Array.from(d.ctrl.rateInt)).toEqual([0, 0, 0])
    // Act: climb out, then fly in a strong wind
    fly(d, 0, 0, 3, 4)
    d.wind[0] = 6
    let maxI = 0
    fly(d, 0, 0, 3, 6, { onStep: (dd) => { for (const v of dd.ctrl.rateInt) maxI = Math.max(maxI, Math.abs(v)) } })
    // Assert
    expect(maxI).toBeGreaterThan(0)
    expect(maxI).toBeLessThanOrEqual(RATE_INT_MAX / DEFAULT_GAINS.rateI + 1e-12)
    expect(d.mode).toBe('flying')
  })

  it('turns to a commanded heading the shortest way, CCW for a positive yaw step', () => {
    // Arrange
    const d = hovering(2)
    let minYaw = 0
    // Act
    d.yawSp = Math.PI / 2
    const geomYaw = mixerGeom(p)
    for (let k = 0; k < 4000; k++) {
      if (k % 10 === 0) positionLoop(d.vSp, d.s, d.target, d.targetVel, DEFAULT_GAINS, DEFAULT_LIMITS)
      d.controlStep(1e-3, p, DEFAULT_GAINS, DEFAULT_LIMITS, geomYaw)
      d.physicsStep(1e-3, p, 'rk4', geomYaw)
      minYaw = Math.min(minYaw, quatYaw(d.s, 6))
    }
    // Assert: settles on +90° without ever swinging the wrong way, still level and in place
    expect(quatYaw(d.s, 6)).toBeCloseTo(Math.PI / 2, 2)
    expect(minYaw).toBeGreaterThan(-0.01)
    expect(quatCosTilt(d.s, 6)).toBeGreaterThan(Math.cos(0.01))
    expect(Math.hypot(d.s[0], d.s[1], d.s[2] - 2)).toBeLessThan(0.02)
  })

  it('does not sink into the ground when the motors are off', () => {
    const d = new Drone(0)
    d.placeOnGround(1, 2, 0.5, p)
    fly(d, 1, 2, 0, 3)
    expect(d.s[2]).toBeCloseTo(p.gearHeight, 12)
    expect(d.s[5]).toBe(0)
    expect(d.contact).toBe(true)
  })

  it('records a crash when it hits the ground faster than the crash speed', () => {
    const d = hovering(6)
    d.disarm()
    fly(d, 0, 0, 0, 3)
    expect(CRASH_SPEED).toBeLessThan(Math.sqrt(2 * p.g * 6))
    expect(d.mode).toBe('crashed')
    expect(d.crashCause).toMatch(/impact/)
  })

  it('touches down gently under a slow descent', () => {
    const d = hovering(1)
    d.beginLanding()
    const h = 1e-3
    for (let k = 0; k < 6000; k++) {
      if (k % 10 === 0) { d.vSp[0] = 0; d.vSp[1] = 0; d.vSp[2] = -0.5 }
      d.controlStep(h, p, DEFAULT_GAINS, DEFAULT_LIMITS, geom)
      d.physicsStep(h, p, 'rk4', geom)
    }
    expect(d.mode).toBe('landing')
    expect(d.contact).toBe(true)
    expect(d.contactTime).toBeGreaterThan(0.4)
  })
})
