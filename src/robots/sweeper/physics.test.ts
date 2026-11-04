import { describe, expect, it } from 'vitest'
import {
  FOOT_HX,
  FOOT_HY,
  HALF_LENGTH,
  HALF_WIDTH,
  LIDAR_RATE_HZ,
  MAX_WHEEL_ACCEL,
  MAX_WHEEL_SPEED,
  SUBSTEP,
  WHEEL_RADIUS,
} from './constants'
import { footprintCollides } from './geom2d'
import { mecanumInverse } from './mecanum'
import { SLOW_DIST, STOP_DIST } from './safety'
import { SweeperSim } from './sim'

/*
 * The full sim loop checked against numbers derived by hand from the robot's specs:
 *   body acceleration  a = 40 rad/s^2 x 0.04 m        = 1.6 m/s^2 straight ahead
 *   top speed          v = 15 rad/s x 0.04 m          = 0.6 m/s, reached in v / a = 0.375 s
 *   braking distance   v^2 / (2a)                     = 0.1125 m
 *   spin rate          r w / (lx + ly) = 0.6 / 0.2    = 3 rad/s
 * The 120 Hz substeps use the post-update wheel speed for each step, so distances carry a
 * known +-(v h / 2) term, which the expectations include exactly.
 */

const A = MAX_WHEEL_ACCEL * WHEEL_RADIUS
const VMAX = MAX_WHEEL_SPEED * WHEEL_RADIUS

function substeps(sim: SweeperSim, n: number): void {
  for (let i = 0; i < n; i++) sim.step(SUBSTEP)
}

function penetrates(sim: SweeperSim): boolean {
  return footprintCollides(sim.pose.x, sim.pose.y, sim.pose.th, FOOT_HX, FOOT_HY, sim.obstacles, sim.half)
}

describe('wheel dynamics against hand-derived values', () => {
  it('accelerates at exactly the wheel acceleration limit: v = a t, x = a t^2 / 2', () => {
    // Arrange
    const sim = new SweeperSim(10, [])
    sim.drive = 'wheels'
    sim.extWheels.fill(MAX_WHEEL_SPEED)
    const x0 = sim.pose.x, y0 = sim.pose.y
    // Act: 0.25 s, inside the 0.375 s ramp
    substeps(sim, 30)
    // Assert
    const t = sim.t
    expect(t).toBeCloseTo(0.25, 12)
    expect(sim.wheel[0]).toBeCloseTo(MAX_WHEEL_ACCEL * t, 9)
    expect(sim.speed).toBeCloseTo(A * t, 9)
    expect(sim.pose.x - x0).toBeCloseTo(0.5 * A * t * t + 0.5 * A * t * SUBSTEP, 9)
    expect(sim.pose.y).toBeCloseTo(y0, 12)
  })

  it('brakes from top speed in v^2 / 2a = 0.1125 m and v / a = 0.375 s', () => {
    // Arrange: cruise at top speed
    const sim = new SweeperSim(10, [])
    sim.drive = 'wheels'
    sim.extWheels.fill(MAX_WHEEL_SPEED)
    substeps(sim, 120)
    expect(sim.speed).toBeCloseTo(VMAX, 9)
    const x0 = sim.pose.x
    // Act
    sim.extWheels.fill(0)
    let n = 0
    while (sim.speed > 0 && n < 200) {
      sim.step(SUBSTEP)
      n++
    }
    // Assert
    expect(sim.pose.x - x0).toBeCloseTo(VMAX ** 2 / (2 * A) - 0.5 * VMAX * SUBSTEP, 6)
    expect(Math.abs(n * SUBSTEP - VMAX / A)).toBeLessThanOrEqual(SUBSTEP + 1e-9)
  })

  it('spins in place at r w / (lx + ly) = 3 rad/s with all wheels at the limit', () => {
    // Arrange
    const sim = new SweeperSim(6, [])
    sim.drive = 'wheels'
    sim.extWheels.set([-MAX_WHEEL_SPEED, MAX_WHEEL_SPEED, -MAX_WHEEL_SPEED, MAX_WHEEL_SPEED])
    const x0 = sim.pose.x, y0 = sim.pose.y
    // Act
    substeps(sim, 60)
    // Assert
    const wz = (WHEEL_RADIUS * MAX_WHEEL_SPEED) / (HALF_LENGTH + HALF_WIDTH)
    expect(wz).toBeCloseTo(3, 12)
    expect(sim.twist.wz).toBeCloseTo(wz, 9)
    expect(sim.speed).toBeCloseTo(0, 12)
    expect(sim.pose.x).toBeCloseTo(x0, 12)
    expect(sim.pose.y).toBeCloseTo(y0, 12)
  })

  it('strafes left at the same 0.6 m/s as it drives forward, holding its heading', () => {
    // Arrange: the X-roller strafe pattern FL-, FR+, RL+, RR-
    const sim = new SweeperSim(6, [])
    sim.drive = 'wheels'
    sim.extWheels.set([-MAX_WHEEL_SPEED, MAX_WHEEL_SPEED, MAX_WHEEL_SPEED, -MAX_WHEEL_SPEED])
    const x0 = sim.pose.x
    // Act
    substeps(sim, 60)
    // Assert
    expect(sim.twist.vy).toBeCloseTo(VMAX, 9)
    expect(sim.twist.vx).toBeCloseTo(0, 12)
    expect(sim.pose.th).toBeCloseTo(0, 12)
    expect(sim.pose.x).toBeCloseTo(x0, 12)
  })
})

describe('fixed-timestep integration', () => {
  it('follows the same trajectory whatever the frame rate', () => {
    // Arrange: an autonomous coverage run, which exercises every controller timer
    const run = (frame: number): SweeperSim => {
      const sim = new SweeperSim(6, undefined, 7)
      const n = Math.round(12 / frame)
      for (let i = 0; i < n; i++) sim.step(frame)
      return sim
    }
    // Act
    const ref = run(1 / 30)
    const others = [run(1 / 60), run(1 / 144), run(1 / 50)]
    // Assert: float accumulation may leave one substep pending; run it, then compare exactly
    for (const s of others) {
      for (let k = 0; s.t < ref.t - 1e-9 && k < 1e5; k++) s.step(1e-6)
      expect(s.t).toBeCloseTo(ref.t, 9)
      expect(s.pose.x).toBeCloseTo(ref.pose.x, 9)
      expect(s.pose.y).toBeCloseTo(ref.pose.y, 9)
      expect(s.pose.th).toBeCloseTo(ref.pose.th, 9)
      expect(s.coverage.coveredCount).toBe(ref.coverage.coveredCount)
    }
    expect(Math.hypot(ref.pose.x + 2.45, ref.pose.y + 2.45)).toBeGreaterThan(1)
  })
})

describe('reactive safety layer against braking at the acceleration limit', () => {
  it('never asks the motors to brake harder than they can, in any direction of travel', () => {
    for (const deg of [0, 30, 45, 90, 135]) {
      // Arrange: wheel speed per 1 m/s of travel in this direction
      const w = new Float64Array(4)
      mecanumInverse(Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0, w)
      const perMs = Math.max(...Array.from(w, Math.abs))
      const vmax = Math.min(0.6, MAX_WHEEL_SPEED / perMs)
      const aMax = MAX_WHEEL_ACCEL / perMs
      // Act: the linear ramp v = vmax (c - STOP) / (SLOW - STOP) decelerates at v * vmax / (SLOW - STOP)
      const demanded = (vmax * vmax) / (SLOW_DIST - STOP_DIST)
      const stopping = vmax ** 2 / (2 * aMax) + vmax / LIDAR_RATE_HZ
      // Assert: within the motors, and the slow band holds a full stop plus one stale turn
      expect(demanded).toBeLessThan(aMax)
      expect(SLOW_DIST - STOP_DIST).toBeGreaterThan(stopping)
    }
  })

  it('stops short of a wall from top speed without bumping, straight and diagonally', () => {
    for (const dir of ['f', 'fl']) {
      // Arrange: TELEOP at 0.6 m/s, LD06 noise at spec
      const sim = new SweeperSim(4, [], 3)
      sim.params = { ...sim.params, teleopSpeed: 0.6 }
      sim.pose.x = -1
      sim.pose.y = 0
      sim.nav.setMode('teleop')
      sim.nav.teleopDir = dir
      let peak = 0
      // Act
      for (let i = 0; i < 480; i++) {
        sim.step(1 / 60)
        expect(penetrates(sim)).toBe(false)
        peak = Math.max(peak, sim.speed)
      }
      // Assert: full speed reached, never touched, parked a few cm off the wall
      const gap = dir === 'f' ? 2 - (sim.pose.x + FOOT_HX) : 2 - (sim.pose.y + FOOT_HY)
      expect(sim.bumps).toBe(0)
      expect(peak).toBeGreaterThan(dir === 'f' ? 0.59 : 0.41)
      expect(gap).toBeGreaterThan(0.02)
      expect(gap).toBeLessThan(0.12)
      // parked: LD06 noise jitters the ramp near STOP_DIST, so it creeps at most a cm/s or two
      expect(sim.speed).toBeLessThan(0.03)
    }
  })
})

describe('wheel odometry', () => {
  it('keeps the belief equal to the truth when the wheels do not slip', () => {
    const sim = new SweeperSim(6, undefined, 2)
    for (let i = 0; i < 300; i++) {
      sim.step(1 / 60)
      expect(sim.odom).toEqual(sim.pose)
    }
    expect(sim.odomError).toBe(0)
  })

  it('drifts the odometry away from the truth when the wheels slip', () => {
    // Arrange: a straight forward command; the encoders only ever count a straight line
    const sim = new SweeperSim(6, [], 5)
    sim.params = { ...sim.params, slip: true }
    sim.drive = 'twist'
    sim.extTwist.vx = 0.3
    const y0 = sim.pose.y
    // Act
    for (let i = 0; i < 240; i++) sim.step(1 / 60)
    // Assert: the belief stays on the commanded line, the chassis wandered off it
    expect(sim.odom.y).toBeCloseTo(y0, 9)
    expect(sim.odom.th).toBeCloseTo(0, 9)
    expect(sim.odomError).toBeGreaterThan(1e-3)
    expect(Math.abs(sim.pose.y - y0) + Math.abs(sim.pose.th)).toBeGreaterThan(1e-3)
  })

  it('files LiDAR returns at the believed pose, so a drifted robot maps walls where it thinks they are', () => {
    // Arrange: the robot believes it is 0.5 m east of where it stands
    const sim = new SweeperSim(6, [], 4)
    sim.params = { ...sim.params, slip: true }
    sim.lidar.noise = 0
    sim.drive = 'twist'
    sim.odom.x = sim.pose.x + 0.5
    // Act: one revolution standing still
    sim.step(0.11)
    // Assert: the west wall (x = -3) lands in the belief frame at x = -2.5
    const g = sim.grid
    const column = (x: number): number => {
      let n = 0
      for (let iy = 0; iy < g.geom.h; iy++) {
        for (const ix of [g.cellX(x) - 1, g.cellX(x)]) if (g.isOccupied(iy * g.geom.w + ix)) n++
      }
      return n
    }
    expect(column(-2.5)).toBeGreaterThan(20)
    expect(column(-3)).toBe(0)
  })
})

describe('depenetration', () => {
  it('pushes a twin that starts inside furniture out by the minimum translation, then holds it out', () => {
    // Arrange: a 1 m box at the origin and the robot 5 cm inside its west face (as a
    // HARDWARE odometry pose can leave it), still driving toward the box
    const box = { kind: 'box' as const, id: 1, x: 0, y: 0, w: 1, h: 1, a: 0, hgt: 0.5 }
    const sim = new SweeperSim(4, [box])
    sim.pose.x = -0.6
    sim.pose.y = 0
    sim.pose.th = 0
    sim.drive = 'twist'
    sim.extTwist.vx = 0.3
    expect(penetrates(sim)).toBe(true)
    // Act
    sim.step(SUBSTEP)
    // Assert: out along -x by the 5 cm overlap, and never back in
    expect(penetrates(sim)).toBe(false)
    expect(sim.pose.x).toBeCloseTo(-0.65, 3)
    expect(sim.pose.y).toBeCloseTo(0, 9)
    for (let i = 0; i < 120; i++) {
      sim.step(1 / 60)
      expect(penetrates(sim)).toBe(false)
    }
    expect(sim.pose.x).toBeLessThan(-0.649)
    expect(sim.bumps).toBeGreaterThanOrEqual(1)
  })
})
