import { describe, expect, it } from 'vitest'
import { FOOT_HX, FOOT_HY, MAX_WHEEL_SPEED } from './constants'
import { footprintCollides, type Obstacle } from './geom2d'
import { SweeperSim } from './sim'

const FRAME = 1 / 60

function run(sim: SweeperSim, seconds: number, each?: () => void): void {
  for (let t = 0; t < seconds; t += FRAME) {
    sim.step(FRAME)
    each?.()
  }
}

function penetrates(sim: SweeperSim): boolean {
  return footprintCollides(sim.pose.x, sim.pose.y, sim.pose.th, FOOT_HX, FOOT_HY, sim.obstacles, sim.half)
}

describe('collision', () => {
  it('stops at a wall without penetrating and raises the bump flag', () => {
    // Arrange
    const sim = new SweeperSim(4, [])
    sim.drive = 'twist'
    sim.extTwist.vx = 0.5
    let hit = false
    // Act
    run(sim, 8, () => {
      expect(penetrates(sim)).toBe(false)
      hit ||= sim.bump
    })
    // Assert
    expect(hit).toBe(true)
    expect(sim.bumps).toBeGreaterThanOrEqual(1)
    expect(2 - (sim.pose.x + FOOT_HX)).toBeLessThan(0.02)
  })

  it('stops at an obstacle and drives away from it afterwards', () => {
    // Arrange
    const box: Obstacle = { kind: 'box', id: 1, x: 0, y: -1.45, w: 0.6, h: 0.6, a: 0.4, hgt: 0.4 }
    const sim = new SweeperSim(4, [box])
    sim.drive = 'twist'
    sim.extTwist.vx = 0.4
    // Act
    run(sim, 6, () => expect(penetrates(sim)).toBe(false))
    const stopX = sim.pose.x
    sim.extTwist.vx = -0.3
    run(sim, 1)
    // Assert
    expect(sim.bumps).toBeGreaterThanOrEqual(1)
    expect(stopX).toBeLessThan(0)
    expect(sim.pose.x).toBeLessThan(stopX - 0.1)
  })
})

describe('motion', () => {
  it('integrates the pose from rate-limited wheel speeds', () => {
    const sim = new SweeperSim(6, [])
    sim.drive = 'wheels'
    sim.extWheels.fill(MAX_WHEEL_SPEED)
    sim.step(0.1)
    expect(sim.wheel[0]).toBeLessThan(MAX_WHEEL_SPEED)
    run(sim, 1)
    expect(sim.wheel[0]).toBeCloseTo(MAX_WHEEL_SPEED, 6)
    expect(sim.speed).toBeCloseTo(MAX_WHEEL_SPEED * 0.04, 6)
  })

  it('saturates an impossible twist without changing its direction', () => {
    const sim = new SweeperSim(6, [])
    sim.drive = 'twist'
    sim.extTwist.vx = 2
    sim.extTwist.vy = 1
    sim.step(FRAME)
    expect(sim.cmdTwist.vy / sim.cmdTwist.vx).toBeCloseTo(0.5, 9)
    expect(Math.max(...[...sim.wheelTarget].map(Math.abs))).toBeCloseTo(MAX_WHEEL_SPEED, 9)
  })

  it('drifts from the commanded path with wheel slip enabled', () => {
    const a = new SweeperSim(6, [], 3)
    const b = new SweeperSim(6, [], 3)
    b.params = { ...b.params, slip: true }
    for (const s of [a, b]) {
      s.drive = 'twist'
      s.extTwist.vx = 0.3
      run(s, 3)
    }
    expect(Math.abs(a.pose.y - (-2.45))).toBeLessThan(1e-9)
    expect(Math.hypot(a.pose.x - b.pose.x, a.pose.y - b.pose.y)).toBeGreaterThan(1e-4)
  })
})

describe('mapping from simulated scans', () => {
  it('marks the walls occupied and the floor free within a second', () => {
    // Arrange
    const sim = new SweeperSim(4, [])
    sim.nav.setMode('teleop')
    // Act
    run(sim, 1)
    // Assert
    const g = sim.grid
    const wall = g.cellY(0) * g.geom.w + g.cellX(2.01)
    const floor = g.cellY(0) * g.geom.w + g.cellX(0)
    expect(g.isOccupied(wall)).toBe(true)
    expect(g.isFree(floor)).toBe(true)
    expect(g.knownFraction(sim.half)).toBeGreaterThan(0.6)
  })
})

describe('autonomy', () => {
  it('reaches a GOTO goal across the furnished default room without bumping', () => {
    // Arrange
    const sim = new SweeperSim()
    sim.nav.setMode('goto')
    sim.nav.setGoal(2.2, 1.7)
    // Act
    run(sim, 60, () => expect(penetrates(sim)).toBe(false))
    // Assert
    expect(sim.nav.arrived).toBe(true)
    expect(Math.hypot(sim.pose.x - 2.2, sim.pose.y - 1.7)).toBeLessThan(0.08)
    expect(sim.bumps).toBe(0)
  })

  it('snaps an unreachable goal inside an obstacle to the nearest free cell', () => {
    const sim = new SweeperSim(4, [{ kind: 'cyl', id: 1, x: 1, y: 1, r: 0.3, hgt: 0.5 }])
    sim.nav.setMode('goto')
    run(sim, 0.3)
    sim.nav.setGoal(1, 1)
    run(sim, 30)
    expect(sim.nav.arrived).toBe(true)
    expect(Math.hypot(sim.pose.x - 1, sim.pose.y - 1)).toBeGreaterThan(0.3)
  })

  it('sweeps most of a small empty room in COVERAGE mode', () => {
    // Arrange
    const sim = new SweeperSim(3, [])
    sim.nav.setMode('coverage')
    // Act
    run(sim, 150, () => expect(penetrates(sim)).toBe(false))
    // Assert
    expect(sim.coverage.percent()).toBeGreaterThan(70)
    expect(sim.bumps).toBe(0)
    expect(sim.nav.phase).toBe('done')
  })

  it('makes coverage progress around furniture without collisions', () => {
    const sim = new SweeperSim()
    sim.nav.setMode('coverage')
    // measured: about 17 % after 90 s, and a full pass ends near 70 % after about 390 s
    run(sim, 90, () => expect(penetrates(sim)).toBe(false))
    expect(sim.coverage.percent()).toBeGreaterThan(12)
    expect(sim.bumps).toBe(0)
    expect(sim.nav.lanes.length).toBeGreaterThan(10)
  })

  it('wanders the room without penetrating anything', () => {
    const sim = new SweeperSim()
    sim.nav.setMode('wander')
    run(sim, 40, () => expect(penetrates(sim)).toBe(false))
    expect(sim.odometer).toBeGreaterThan(2)
  })

  it('drives with the direction pad in TELEOP', () => {
    const sim = new SweeperSim(6, [])
    sim.nav.setMode('teleop')
    sim.nav.teleopDir = 'l'
    run(sim, 1)
    expect(sim.pose.y).toBeGreaterThan(-2.45 + 0.15)
    expect(Math.abs(sim.pose.x - -2.45)).toBeLessThan(0.02)
  })
})

describe('external (HARDWARE) mode', () => {
  it('integrates odometry from measured wheels and skips collision physics', () => {
    const sim = new SweeperSim(4, [])
    sim.external = true
    sim.wheel.fill(10)
    run(sim, 1)
    expect(sim.pose.x).toBeCloseTo(-1.45 + 0.4, 2)
  })

  it('holds the pose when it comes from telemetry', () => {
    const sim = new SweeperSim(4, [])
    sim.external = true
    sim.odomFromWheels = false
    sim.wheel.fill(10)
    run(sim, 1)
    expect(sim.pose.x).toBeCloseTo(-1.45, 9)
  })
})

describe('arena edits', () => {
  it('rebuilds the maps and resets the robot when the room size changes', () => {
    const sim = new SweeperSim()
    run(sim, 0.5)
    sim.setArena(8, [])
    expect(sim.grid.geom.w).toBe(166)
    expect(sim.pose.x).toBeCloseTo(-3.45, 9)
    expect(sim.coverage.coveredCount).toBe(0)
  })

  it('clears what was sensed on RESET MAP', () => {
    const sim = new SweeperSim()
    run(sim, 1)
    sim.resetMap()
    expect(sim.grid.knownFraction(sim.half)).toBe(0)
    expect(sim.coverage.percent()).toBe(0)
  })
})
