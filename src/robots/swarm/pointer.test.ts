import { describe, expect, it } from 'vitest'
import { CLICK_TURN, WaypointTool, rayPlaneHit, rayTurn } from './pointer'
import { SwarmSim, VOLUME_HALF, defaultSettings } from './sim/swarmSim'

/** Ray from a camera at (cx, cy, cz) through the three.js ground point (X, 0, Z). */
function rayAt(X: number, Z: number, cx = 0, cy = 20, cz = 0, h = 0): Float64Array {
  const dx = X - cx, dy = h - cy, dz = Z - cz
  const n = Math.hypot(dx, dy, dz)
  return new Float64Array([cx, cy, cz, dx / n, dy / n, dz / n])
}

function freshSim(): SwarmSim {
  const s = new SwarmSim(3, defaultSettings())
  s.clearWaypoints()
  return s
}

describe('pointer ray geometry', () => {
  it('intersects a horizontal plane and returns the hit in the sim ground frame', () => {
    const out = new Float64Array(2)
    expect(rayPlaneHit(out, rayAt(3, -4), 0)).toBe(true)
    // three (X, Z) = (3, -4) -> sim (x, y) = (3, 4)
    expect(out[0]).toBeCloseTo(3, 12)
    expect(out[1]).toBeCloseTo(4, 12)
  })

  it('misses planes the ray runs parallel to or away from', () => {
    const out = new Float64Array(2)
    expect(rayPlaneHit(out, new Float64Array([0, 5, 0, 1, 0, 0]), 0)).toBe(false)
    expect(rayPlaneHit(out, new Float64Array([0, 5, 0, 0, 1, 0]), 0)).toBe(false)
  })

  it('measures the turn between two view rays', () => {
    expect(rayTurn(rayAt(1, 1), rayAt(1, 1))).toBeCloseTo(0, 6)
    expect(rayTurn(new Float64Array([0, 0, 0, 1, 0, 0]), new Float64Array([0, 0, 0, 0, 1, 0]))).toBeCloseTo(Math.PI / 2, 12)
  })
})

describe('waypoint tool', () => {
  it('drops a waypoint on a click (down then up) without locking the camera on down', () => {
    // Arrange
    const s = freshSim()
    const tool = new WaypointTool()
    const ray = rayAt(2, -5)
    // Act
    const down = tool.down(s, 0, false, ray)
    const up = tool.up(s, ray)
    // Assert
    expect(down).toBe(false)
    expect(up).toBe(true)
    expect(s.wpCount).toBe(1)
    expect(s.waypoints[0]).toBeCloseTo(2, 9)
    expect(s.waypoints[1]).toBeCloseTo(5, 9)
  })

  it('treats a left-drag that turned the view as an orbit, not a click', () => {
    const s = freshSim()
    const tool = new WaypointTool()
    tool.down(s, 0, false, rayAt(2, -5))
    const turned = rayAt(6, -5)
    expect(rayTurn(rayAt(2, -5), turned)).toBeGreaterThan(CLICK_TURN)
    expect(tool.up(s, turned)).toBe(false)
    expect(s.wpCount).toBe(0)
  })

  it('ignores other buttons and clicks outside the flight volume', () => {
    const s = freshSim()
    const tool = new WaypointTool()
    expect(tool.down(s, 2, false, rayAt(1, 1))).toBe(false)
    expect(tool.up(s, rayAt(1, 1))).toBe(false)
    const far = rayAt(VOLUME_HALF + 5, 0)
    tool.down(s, 0, false, far)
    expect(tool.up(s, far)).toBe(false)
    expect(s.wpCount).toBe(0)
  })

  it('grabs a marker (consuming the event), drags it and releases it', () => {
    // Arrange: waypoint at sim (4, 4) = three (4, 0, -4)
    const s = freshSim()
    s.addWaypoint(4, 4)
    const tool = new WaypointTool()
    // Act
    const grabbed = tool.down(s, 0, false, rayAt(4, -4, 4, 20, -4))
    const moved = tool.move(s, rayAt(-1, 2))
    const released = tool.up(s, rayAt(-1, 2))
    // Assert
    expect([grabbed, moved, released]).toEqual([true, true, true])
    expect(s.wpCount).toBe(1)
    expect(Math.hypot(s.waypoints[0] - -1, s.waypoints[1] - -2)).toBeLessThan(1e-6)
    expect(tool.dragging).toBe(-1)
  })

  it('picks the ring at cruise altitude from an oblique view', () => {
    // Arrange: a camera low and to the side, aimed at the ring 3 m above sim (0, 0)
    const s = freshSim()
    s.addWaypoint(0, 0)
    const tool = new WaypointTool()
    const ray = rayAt(0, 0, 12, 4, 0, s.settings.cruiseAlt)
    // Act + Assert
    expect(tool.down(s, 0, false, ray)).toBe(true)
    expect(tool.dragging).toBe(0)
  })

  it('removes a marker on shift-click and highlights the marker under the pointer', () => {
    const s = freshSim()
    s.addWaypoint(-3, 2)
    s.addWaypoint(5, 5)
    const tool = new WaypointTool()
    tool.move(s, rayAt(5, -5, 5, 20, -5))
    expect(tool.hover).toBe(1)
    expect(tool.down(s, 0, true, rayAt(-3, -2, -3, 20, -2))).toBe(true)
    expect(s.wpCount).toBe(1)
    expect([s.waypoints[0], s.waypoints[1]]).toEqual([5, 5])
    // shift on empty ground does nothing and leaves the camera alone
    expect(tool.down(s, 0, true, rayAt(0, 0))).toBe(false)
    expect(tool.up(s, rayAt(0, 0))).toBe(false)
    tool.cancel()
    expect([tool.hover, tool.dragging]).toEqual([-1, -1])
  })
})
