import type { SwarmSim } from './sim/swarmSim'
import { VOLUME_HALF } from './sim/swarmSim'

/*
 * Waypoint editing from pointer rays (pure: rays are plain numbers, three.js-free).
 *
 *   click on the ground  -> drop a waypoint there (flown at the cruise altitude)
 *   drag a marker        -> move it (ring at altitude or its ground dot)
 *   shift-click a marker -> remove it
 *
 * A plain click is not consumed on 'down', so a left-drag still orbits the camera; the
 * waypoint is dropped on 'up' only if the view ray barely turned in between (the
 * camera did not orbit). Grabbing a marker is consumed, which locks the orbit.
 *
 * Ray layout: [ox, oy, oz, dx, dy, dz] in the three.js Y-up world, direction unit.
 * Hits are returned in the sim ground frame: sim (x, y) = three (X, -Z).
 */

/** Grab radius around a marker, m. */
export const PICK_RADIUS = 0.8
/** Clicks further than this outside the volume edge are left to the camera, m. */
const EDGE_MARGIN = 0.5
/** Largest view-ray turn between down and up that still counts as a click, rad (~15 px). */
export const CLICK_TURN = 0.02

/** Intersect the ray with the horizontal plane at height h. Writes sim xy into out. */
export function rayPlaneHit(out: Float64Array, ray: ArrayLike<number>, h: number): boolean {
  const dy = ray[4]
  if (Math.abs(dy) < 1e-9) return false
  const t = (h - ray[1]) / dy
  if (!(t > 0) || !Number.isFinite(t)) return false
  out[0] = ray[0] + t * ray[3]
  out[1] = -(ray[2] + t * ray[5])
  return true
}

function inVolume(xy: Float64Array): boolean {
  const lim = VOLUME_HALF + EDGE_MARGIN
  return Math.abs(xy[0]) <= lim && Math.abs(xy[1]) <= lim
}

/** Angle between the directions of two rays, rad. */
export function rayTurn(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const dot = a[3] * b[3] + a[4] * b[4] + a[5] * b[5]
  return Math.acos(Math.min(1, Math.max(-1, dot)))
}

export class WaypointTool {
  /** Waypoint under the pointer (-1 = none), for the hover highlight. */
  hover = -1
  /** Waypoint being dragged (-1 = none). */
  dragging = -1
  private dragAlt = 0
  private pending = false
  private readonly downRay = new Float64Array(6)
  private readonly downHit = new Float64Array(2)
  private readonly hit = new Float64Array(2)

  /** Returns true when the event is consumed (marker grabbed or removed). */
  down(sim: SwarmSim, button: number, shift: boolean, ray: ArrayLike<number>): boolean {
    this.pending = false
    this.dragging = -1
    if (button !== 0) return false
    const picked = this.pick(sim, ray)
    if (picked >= 0) {
      if (shift) {
        sim.removeWaypoint(picked)
        this.hover = -1
        return true
      }
      this.dragging = picked
      return true
    }
    if (shift || !rayPlaneHit(this.downHit, ray, 0) || !inVolume(this.downHit)) return false
    for (let i = 0; i < 6; i++) this.downRay[i] = ray[i]
    this.pending = true
    return false
  }

  move(sim: SwarmSim, ray: ArrayLike<number>): boolean {
    if (this.dragging >= 0) {
      if (rayPlaneHit(this.hit, ray, this.dragAlt)) sim.moveWaypoint(this.dragging, this.hit[0], this.hit[1])
      return true
    }
    this.hover = this.pick(sim, ray)
    return false
  }

  up(sim: SwarmSim, ray: ArrayLike<number>): boolean {
    if (this.dragging >= 0) {
      this.dragging = -1
      return true
    }
    if (!this.pending) return false
    this.pending = false
    if (rayTurn(this.downRay, ray) > CLICK_TURN) return false
    return sim.addWaypoint(this.downHit[0], this.downHit[1])
  }

  cancel(): void {
    this.pending = false
    this.dragging = -1
    this.hover = -1
  }

  /**
   * Marker under the ray: tested against the rings at the cruise altitude and the dots
   * on the ground, nearest wins. Remembers which plane it was grabbed on.
   */
  private pick(sim: SwarmSim, ray: ArrayLike<number>): number {
    let best = -1
    let bestD = PICK_RADIUS
    for (let k = 0; k < 2; k++) {
      const h = k === 0 ? sim.settings.cruiseAlt : 0
      if (!rayPlaneHit(this.hit, ray, h)) continue
      const i = sim.nearestWaypoint(this.hit[0], this.hit[1], bestD)
      if (i < 0) continue
      bestD = Math.hypot(sim.waypoints[2 * i] - this.hit[0], sim.waypoints[2 * i + 1] - this.hit[1])
      best = i
      this.dragAlt = h
    }
    return best
  }
}
