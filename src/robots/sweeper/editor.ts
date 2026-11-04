import { addRandomObstacle, randomLayout } from './arena'
import { FOOT_HX, FOOT_HY } from './constants'
import { clampObstacleToRoom, obstacleInsideRoom, obstacleOverlapsObb, obstaclesOverlap, type Obstacle } from './geom2d'
import { wrapAngle, type Pose2 } from './mecanum'
import type { Rng } from './rng'

/*
 * Arena editing: selection, drag to move, Alt+drag to rotate a box, and the ADD / REMOVE /
 * RANDOMIZE / CLEAR actions. The obstacle list is replaced, never mutated, on every edit,
 * so the sim and the view can keep the array they were given. A dragged obstacle only
 * lands where it fits (inside the room, clear of the other obstacles and of the robot);
 * when the pointer goes somewhere it does not fit, it slides along the drag up to the
 * last spot that does.
 */

/** Space kept between a dragged obstacle and the robot footprint, meters. */
const ROBOT_GAP = 0.03
const SLIDE_STEPS = 10

interface Drag {
  id: number
  rotate: boolean
  offX: number
  offY: number
  planeY: number
  grabAngle: number
  startA: number
}

export class ArenaEditor {
  obstacles: readonly Obstacle[] = []
  selected: number | null = null
  private drag: Drag | null = null
  private nextId = 1

  /** Replace the whole layout (arena resize, config load). Selection survives if the id does. */
  setAll(obstacles: readonly Obstacle[]): void {
    this.obstacles = obstacles
    this.nextId = obstacles.reduce((m, o) => Math.max(m, o.id), 0) + 1
    if (this.selected !== null && !this.find(this.selected)) this.selected = null
    this.drag = null
  }

  find(id: number): Obstacle | undefined {
    return this.obstacles.find((o) => o.id === id)
  }

  get dragging(): boolean {
    return this.drag !== null
  }

  /** Height of the horizontal plane the current drag follows (where the obstacle was grabbed). */
  get dragPlaneY(): number {
    return this.drag?.planeY ?? 0
  }

  /** Returns true when the selection changed. */
  select(id: number | null): boolean {
    const next = id !== null && this.find(id) ? id : null
    if (next === this.selected) return false
    this.selected = next
    return true
  }

  /** Grab obstacle `id` at plan point (hitX, hitY) on a plane `planeY` meters up. */
  beginDrag(id: number, hitX: number, hitY: number, planeY: number, rotate: boolean): boolean {
    const o = this.find(id)
    if (!o) return false
    this.select(id)
    this.drag = {
      id,
      rotate: rotate && o.kind === 'box',
      offX: o.x - hitX,
      offY: o.y - hitY,
      planeY,
      grabAngle: Math.atan2(hitY - o.y, hitX - o.x),
      startA: o.kind === 'box' ? o.a : 0,
    }
    return true
  }

  /** Pointer at (px, py) on the drag plane. Returns the moved obstacle, or null when nothing changed. */
  dragTo(px: number, py: number, half: number, robot: Pose2): Obstacle | null {
    const d = this.drag
    const o = d ? this.find(d.id) : undefined
    if (!d || !o) return null
    let next: Obstacle
    if (d.rotate && o.kind === 'box') {
      next = { ...o, a: wrapAngle(d.startA + Math.atan2(py - o.y, px - o.x) - d.grabAngle) }
      if (!this.fits(next, half, robot)) return null
    } else {
      next = this.slide(o, clampObstacleToRoom({ ...o, x: px + d.offX, y: py + d.offY }, half), half, robot)
      if (next === o) return null
    }
    this.replace(next)
    return next
  }

  /** Returns true when a drag was in progress. */
  endDrag(): boolean {
    const was = this.drag !== null
    this.drag = null
    return was
  }

  /** Add a random obstacle of `kind` somewhere it fits; it becomes the selection. */
  add(kind: 'box' | 'cyl', rng: Rng, size: number, robot: Pose2): Obstacle | null {
    const o = addRandomObstacle(rng, this.obstacles, size, robot, kind, this.nextId)
    if (!o) return null
    this.nextId++
    this.obstacles = [...this.obstacles, o]
    this.selected = o.id
    return o
  }

  removeSelected(): boolean {
    if (this.selected === null) return false
    const id = this.selected
    this.obstacles = this.obstacles.filter((o) => o.id !== id)
    this.selected = null
    this.drag = null
    return true
  }

  randomize(rng: Rng, size: number, robot: Pose2): void {
    this.setAll(randomLayout(rng, size, robot, 1))
    this.selected = null
  }

  clear(): void {
    this.setAll([])
  }

  /** Inside the room, clear of every other obstacle and of the robot footprint. */
  fits(o: Obstacle, half: number, robot: Pose2): boolean {
    if (!obstacleInsideRoom(o, half)) return false
    if (obstacleOverlapsObb(o, robot.x, robot.y, FOOT_HX, FOOT_HY, robot.th, ROBOT_GAP)) return false
    return !this.obstacles.some((p) => p.id !== o.id && obstaclesOverlap(p, o))
  }

  /** The target if it fits, else the furthest fitting point on the way there (bisection). */
  private slide(from: Obstacle, to: Obstacle, half: number, robot: Pose2): Obstacle {
    if (this.fits(to, half, robot)) return to
    if (!this.fits(from, half, robot)) return from
    let lo = 0
    let hi = 1
    for (let k = 0; k < SLIDE_STEPS; k++) {
      const mid = (lo + hi) / 2
      if (this.fits(lerpTo(from, to, mid), half, robot)) lo = mid
      else hi = mid
    }
    return lo > 0 ? lerpTo(from, to, lo) : from
  }

  private replace(next: Obstacle): void {
    this.obstacles = this.obstacles.map((o) => (o.id === next.id ? next : o))
  }
}

function lerpTo(a: Obstacle, b: Obstacle, k: number): Obstacle {
  return { ...a, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
}
