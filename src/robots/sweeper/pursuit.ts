import { DEG, GOAL_TOLERANCE } from './constants'
import { wrapAngle, type Pose2, type Twist } from './mecanum'
import { MAX_PATH_POINTS } from './planningMap'

/*
 * Holonomic pure pursuit. The robot translates straight at a lookahead point on the
 * path (no curvature constraint for a mecanum base) while a P controller turns the body
 * to face the direction of travel, so the brush and the front LiDAR lead. Translation
 * slows with heading error and with a deceleration profile toward the path end.
 */

export interface PursuitTarget {
  /** Lookahead point, world. */
  x: number
  y: number
  /** Path length left from the robot's projection to the end. */
  remaining: number
  /** Distance from the robot to its projection on the path. */
  cross: number
  done: boolean
}

/** Segments ahead of the current one searched for the closest projection. */
const WINDOW = 6

export class PurePursuit {
  readonly pts = new Float64Array(MAX_PATH_POINTS * 2)
  n = 0
  /** Index of the segment the robot is on (monotonic). */
  seg = 0
  /** Bumped by setPath/clear, so views redraw only when the path changes. */
  version = 0

  setPath(src: Float64Array, n: number): void {
    const m = Math.min(n, MAX_PATH_POINTS)
    for (let i = 0; i < 2 * m; i++) this.pts[i] = src[i]
    this.n = m
    this.seg = 0
    this.version++
  }

  clear(): void {
    this.n = 0
    this.seg = 0
    this.version++
  }

  get endX(): number {
    return this.n ? this.pts[2 * this.n - 2] : 0
  }

  get endY(): number {
    return this.n ? this.pts[2 * this.n - 1] : 0
  }

  /** Lookahead target for a robot at (x, y). */
  track(x: number, y: number, lookahead: number, out: PursuitTarget): PursuitTarget {
    const p = this.pts
    if (this.n === 0) return done(out, x, y)
    if (this.n === 1) return finish(out, x, y, p[0], p[1])
    let best = this.seg
    let bestT = 0
    let bestD = Infinity
    const last = Math.min(this.n - 2, this.seg + WINDOW)
    for (let s = this.seg; s <= last; s++) {
      const ax = p[2 * s], ay = p[2 * s + 1]
      const bx = p[2 * s + 2] - ax, by = p[2 * s + 3] - ay
      const len2 = bx * bx + by * by
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * bx + (y - ay) * by) / len2)) : 1
      const d = Math.hypot(ax + bx * t - x, ay + by * t - y)
      if (d < bestD - 1e-9) { bestD = d; best = s; bestT = t }
    }
    this.seg = best
    const px = p[2 * best] + (p[2 * best + 2] - p[2 * best]) * bestT
    const py = p[2 * best + 1] + (p[2 * best + 3] - p[2 * best + 1]) * bestT
    out.cross = bestD
    walk(p, this.n, best, px, py, lookahead, out)
    out.done = out.remaining < GOAL_TOLERANCE && Math.hypot(this.endX - x, this.endY - y) < GOAL_TOLERANCE
    return out
  }
}

function done(out: PursuitTarget, x: number, y: number): PursuitTarget {
  out.x = x
  out.y = y
  out.remaining = 0
  out.cross = 0
  out.done = true
  return out
}

function finish(out: PursuitTarget, x: number, y: number, gx: number, gy: number): PursuitTarget {
  const d = Math.hypot(gx - x, gy - y)
  out.x = gx
  out.y = gy
  out.remaining = d
  out.cross = 0
  out.done = d < GOAL_TOLERANCE
  return out
}

/** From the projection (px, py) on segment `seg`, walk `look` meters along the path. */
function walk(p: Float64Array, n: number, seg: number, px: number, py: number, look: number, out: PursuitTarget): void {
  let ax = px, ay = py
  let left = look
  let remaining = 0
  let placed = false
  for (let s = seg; s < n - 1; s++) {
    const bx = p[2 * s + 2], by = p[2 * s + 3]
    const len = Math.hypot(bx - ax, by - ay)
    remaining += len
    if (!placed && len >= left) {
      const k = len > 0 ? left / len : 0
      out.x = ax + (bx - ax) * k
      out.y = ay + (by - ay) * k
      placed = true
    } else if (!placed) {
      left -= len
    }
    ax = bx
    ay = by
  }
  if (!placed) {
    out.x = p[2 * n - 2]
    out.y = p[2 * n - 1]
  }
  out.remaining = remaining
}

export interface FollowParams {
  maxSpeed: number
  /** Deceleration used for the stopping profile, m/s^2. */
  decel: number
  /** Face the direction of travel (true) or hold the current heading. */
  faceMotion: boolean
}

const K_POS = 2.5
const K_HEADING = 3.2
const MAX_TURN = 2.6

/** Body twist that drives a holonomic base toward a pursuit target. */
export function followTarget(pose: Pose2, tgt: PursuitTarget, prm: FollowParams, out: Twist): Twist {
  const dx = tgt.x - pose.x, dy = tgt.y - pose.y
  const d = Math.hypot(dx, dy)
  if (tgt.done || d < 1e-6) {
    out.vx = 0
    out.vy = 0
    out.wz = 0
    return out
  }
  let v = Math.min(prm.maxSpeed, Math.sqrt(2 * prm.decel * Math.max(tgt.remaining, d)), K_POS * d + 0.03)
  let wz = 0
  if (prm.faceMotion && d > 0.03) {
    const err = wrapAngle(Math.atan2(dy, dx) - pose.th)
    wz = Math.max(-MAX_TURN, Math.min(MAX_TURN, K_HEADING * err))
    // keep translating while turning (holonomic), but slow down when far off heading
    v *= Math.abs(err) < 90 * DEG ? Math.max(0.25, Math.cos(err)) : 0.25
  }
  const ux = (dx / d) * v, uy = (dy / d) * v
  const c = Math.cos(pose.th), s = Math.sin(pose.th)
  out.vx = c * ux + s * uy
  out.vy = -s * ux + c * uy
  out.wz = wz
  return out
}
