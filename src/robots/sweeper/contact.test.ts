import { describe, expect, it } from 'vitest'
import { FOOT_HX, FOOT_HY } from './constants'
import { footprintCollides, type Obstacle } from './geom2d'
import { OccupancyGrid, makeGridGeom } from './occupancy'
import { PlanningMap } from './planningMap'
import { SweeperSim } from './sim'

/*
 * The bumper layer: obstacles under the LiDAR plane are invisible to the scan, so the
 * robot can only find them by touching them. Contacts are written into the map and
 * the planner routes around them from then on.
 */

const FRAME = 1 / 60

describe('bumper contact layer', () => {
  it('marks a contact cell and its 4-neighbours, survives LiDAR carving, clears with the map', () => {
    // Arrange
    const grid = new OccupancyGrid(makeGridGeom(4))
    // Act
    grid.markContact(0.5, 0.5)
    for (let k = 0; k < 50; k++) grid.integrateRay(-1, 0.5, 1.5, 0.5, true)
    const i = grid.cellY(0.5) * grid.geom.w + grid.cellX(0.5)
    // Assert
    expect(grid.contactCount).toBe(5)
    expect(grid.isOccupied(i)).toBe(true)
    expect(grid.isFree(i)).toBe(false)
    grid.clear()
    expect(grid.isOccupied(i)).toBe(false)
    expect(grid.contactCount).toBe(0)
  })

  it('makes the planner inflate around contact cells', () => {
    const grid = new OccupancyGrid(makeGridGeom(4))
    const map = new PlanningMap(grid)
    map.radius = 0.2
    grid.markContact(0, 0)
    map.refresh()
    expect(map.isBlockedAt(0.15, 0)).toBe(true)
    expect(map.isBlockedAt(0.6, 0)).toBe(false)
  })

  it('bumps into a low obstacle the LiDAR cannot see, maps it and never penetrates it', () => {
    // Arrange: a 6 cm high threshold strip across the robot's path
    const low: Obstacle = { kind: 'box', id: 1, x: -0.6, y: -1.45, w: 0.2, h: 0.9, a: 0, hgt: 0.06 }
    const sim = new SweeperSim(4, [low])
    sim.drive = 'twist'
    sim.extTwist.vx = 0.3
    // Act
    for (let t = 0; t < 4; t += FRAME) {
      sim.step(FRAME)
      expect(footprintCollides(sim.pose.x, sim.pose.y, sim.pose.th, FOOT_HX, FOOT_HY, sim.obstacles, sim.half)).toBe(false)
    }
    // Assert: the scan never saw it, the bumper did
    expect(sim.scene.hidden).toBe(1)
    expect(sim.bumps).toBeGreaterThanOrEqual(1)
    expect(sim.grid.contactCount).toBeGreaterThan(0)
    const cx = sim.grid.cellX(-0.6 - 0.1), cy = sim.grid.cellY(sim.pose.y)
    let near = false
    for (let dx = -2; dx <= 2; dx++) near ||= sim.grid.contact[cy * sim.grid.geom.w + cx + dx] === 1
    expect(near).toBe(true)
  })
})
