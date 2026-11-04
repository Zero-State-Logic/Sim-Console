import { wrapAngle, type Pose2 } from './mecanum'

/*
 * map <- odom transform for HARDWARE odometry. A real board integrates its pose from its
 * own power-on origin, which has nothing to do with the virtual room. The twin anchors
 * that frame once, so the first pose it receives lands where the virtual robot stands,
 * and every later pose moves rigidly relative to it (a 2D rotation plus a translation).
 */
export class OdomAnchor {
  valid = false
  private ax = 0
  private ay = 0
  private ath = 0
  private c = 1
  private s = 0

  reset(): void {
    this.valid = false
  }

  /** Choose the transform that maps the odometry pose (ox, oy, oth) onto `world`. */
  set(world: Pose2, ox: number, oy: number, oth: number): void {
    this.ath = wrapAngle(world.th - oth)
    this.c = Math.cos(this.ath)
    this.s = Math.sin(this.ath)
    this.ax = world.x - (this.c * ox - this.s * oy)
    this.ay = world.y - (this.s * ox + this.c * oy)
    this.valid = true
  }

  /** Odometry pose -> world pose, written into `out`. */
  map(ox: number, oy: number, oth: number, out: Pose2): Pose2 {
    out.x = this.ax + this.c * ox - this.s * oy
    out.y = this.ay + this.s * ox + this.c * oy
    out.th = wrapAngle(oth + this.ath)
    return out
  }
}
