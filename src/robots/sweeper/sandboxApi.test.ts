import { describe, expect, it } from 'vitest'
import { DEG, MAX_WHEEL_SPEED } from './constants'
import { SANDBOX_API, applySandbox, sandboxSensors } from './sandboxApi'
import { SweeperSim } from './sim'

describe('sandbox API definition', () => {
  it('exposes the documented commands and queries with their sensors', () => {
    const byName = new Map(SANDBOX_API.map((f) => [f.name, f]))
    for (const n of ['setWheels', 'drive', 'stop', 'setGoal', 'setMode']) expect(byName.get(n)?.kind).toBe('command')
    expect(byName.get('readLidar')?.sensor).toBe('lidar')
    expect(byName.get('readMinRange')?.sensor).toBe('minRange')
    expect(byName.get('readPose')?.sensor).toBe('pose')
    expect(byName.get('readWheel')?.sensor).toBe('wheel')
    expect(byName.get('readBump')?.sensor).toBe('bump')
    expect(byName.get('coverage')?.sensor).toBe('coverage')
  })
})

describe('applySandbox', () => {
  it('maps drive() to a twist with wz in deg/s and setWheels() to clamped wheel speeds', () => {
    const sim = new SweeperSim(6, [])
    applySandbox(sim, [{ fn: 'drive', args: [0.2, -0.1, 90] }])
    expect(sim.drive).toBe('twist')
    expect(sim.extTwist.wz).toBeCloseTo(90 * DEG)
    applySandbox(sim, [{ fn: 'setWheels', args: [100, -100, 1, 2] }])
    expect(sim.drive).toBe('wheels')
    expect(Array.from(sim.extWheels)).toEqual([MAX_WHEEL_SPEED, -MAX_WHEEL_SPEED, 1, 2])
  })

  it('ignores unknown names, missing or non-finite arguments and bad mode indices', () => {
    const sim = new SweeperSim(6, [])
    const n = applySandbox(sim, [
      { fn: 'explode', args: [] },
      { fn: 'drive', args: [1] },
      { fn: 'setWheels', args: [1, 2, Number.NaN, 4] },
      { fn: 'setMode', args: [7] },
    ])
    expect(n).toBe(0)
    expect(sim.drive).toBe('nav')
  })

  it('hands control to the planner with setGoal() and setMode()', () => {
    const sim = new SweeperSim(6, [])
    applySandbox(sim, [{ fn: 'setGoal', args: [10, 1] }])
    expect(sim.nav.mode).toBe('goto')
    expect(sim.nav.goalX).toBe(3)
    applySandbox(sim, [{ fn: 'setMode', args: [3] }])
    expect(sim.nav.mode).toBe('wander')
    applySandbox(sim, [{ fn: 'drive', args: [0.1, 0, 0] }, { fn: 'stop', args: [] }])
    expect(sim.extTwist.vx).toBe(0)
  })
})

describe('sensor snapshot', () => {
  it('reports 360 LiDAR bins, pose in degrees and the bump flag as a number', () => {
    const sim = new SweeperSim(6, [])
    sim.step(0.2)
    const s = sandboxSensors(sim)
    expect(s.lidar).toHaveLength(360)
    expect((s.lidar as number[]).filter((r) => r > 0).length).toBeGreaterThan(300)
    expect((s.pose as number[])[2]).toBeCloseTo(sim.pose.th / DEG)
    expect(s.bump).toBe(0)
    expect(s.minRange).toBeGreaterThan(0)
  })

  it('reports the wheel-odometry pose, which is what code on the real board can read', () => {
    // Arrange: a drifted belief
    const sim = new SweeperSim(6, [])
    sim.odom.x = sim.pose.x + 0.3
    sim.odom.th = 0.5
    // Act
    const pose = sandboxSensors(sim).pose as number[]
    // Assert
    expect(pose[0]).toBeCloseTo(sim.pose.x + 0.3, 12)
    expect(pose[2]).toBeCloseTo(0.5 / DEG, 9)
  })
})
