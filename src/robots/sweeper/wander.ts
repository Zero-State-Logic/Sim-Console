import { DEG } from './constants'
import { wrapAngle, type Pose2, type Twist } from './mecanum'
import type { Rng } from './rng'
import { clearanceToward } from './safety'

/*
 * WANDER: reactive random walk. Cruise forward with a slowly drifting curvature
 * (Ornstein-Uhlenbeck), and when the front cone gets tight (or on a bump, or every
 * few seconds) rotate in place toward the most open direction, with some jitter.
 */

const TURN_TRIGGER = 0.28
const REORIENT_MIN = 6
const REORIENT_MAX = 13

export class Wander {
  state: 'cruise' | 'turn' = 'cruise'
  private heading = 0
  private curve = 0
  private timer = REORIENT_MIN

  reset(): void {
    this.state = 'cruise'
    this.curve = 0
    this.timer = REORIENT_MIN
  }

  tick(dt: number, pose: Pose2, bins: Float32Array, bump: boolean, rng: Rng, speed: number, out: Twist): Twist {
    this.timer -= dt
    if (this.state === 'cruise') {
      const front = clearanceToward(bins, 0, 40)
      if (front < TURN_TRIGGER || bump || this.timer <= 0) this.pickHeading(pose, bins, rng)
    }
    if (this.state === 'turn') {
      const err = wrapAngle(this.heading - pose.th)
      out.vx = 0
      out.vy = 0
      out.wz = Math.max(-1.8, Math.min(1.8, 2.6 * err))
      if (Math.abs(err) < 0.1) this.state = 'cruise'
      return out
    }
    this.curve += -0.6 * this.curve * dt + 0.7 * Math.sqrt(dt) * rng.gauss()
    this.curve = Math.max(-0.8, Math.min(0.8, this.curve))
    out.vx = speed
    out.vy = 0
    out.wz = this.curve
    return out
  }

  /** Turn toward the most open 10-degree sector, jittered so the walk stays random. */
  private pickHeading(pose: Pose2, bins: Float32Array, rng: Rng): void {
    let best = 180
    let bestScore = -Infinity
    for (let d = 0; d < 360; d += 10) {
      const c = clearanceToward(bins, d * DEG, 18)
      const open = Number.isFinite(c) ? Math.min(c, 3) : 3
      const score = open + rng.range(0, 0.6) - (d === 0 ? 0.5 : 0)
      if (score > bestScore) { bestScore = score; best = d }
    }
    this.heading = wrapAngle(pose.th + best * DEG + rng.range(-12, 12) * DEG)
    this.state = 'turn'
    this.timer = rng.range(REORIENT_MIN, REORIENT_MAX)
  }
}
