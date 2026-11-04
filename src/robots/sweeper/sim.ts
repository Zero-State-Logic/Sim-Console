import type { LidarScan } from '../../core/protocol'
import { defaultLayout, startPose } from './arena'
import {
  ARENA_DEFAULT,
  BRUSH_DEPTH,
  CELL_SIZE,
  FOOT_HX,
  FOOT_HY,
  LIDAR_HEIGHT,
  MAX_WHEEL_ACCEL,
  MAX_WHEEL_SPEED,
  ROBOT_RADIUS,
  SUBSTEP,
} from './constants'
import { CoverageMap } from './coverage'
import { footprintCollides, footprintPush, type Obstacle, type Vec2 } from './geom2d'
import { Ld06, type ScanSink } from './lidar'
import { exitDistance } from './safety'
import {
  integratePose,
  mecanumForward,
  mecanumInverse,
  rateLimitWheels,
  saturateWheels,
  wrapAngle,
  type Pose2,
  type Twist,
} from './mecanum'
import { Navigator, type NavInput, type NavParams } from './navigator'
import { makeGridGeom, OccupancyGrid } from './occupancy'
import { PlanningMap } from './planningMap'
import { RayScene } from './raycast'
import { Rng } from './rng'

/*
 * SWEEPER simulation core (no three.js): a fixed 120 Hz substep loop of
 *   controller -> IK -> saturation -> acceleration limit -> (slip) -> FK -> pose
 *   -> collision (stop + bump) -> LD06 samples -> occupancy map -> brush coverage.
 * The pose integrates from the actual wheel speeds. In `external` mode (HARDWARE) the
 * pose and wheel speeds come from telemetry and physics is skipped, but the controller
 * still runs so its wheel targets can be streamed to the board.
 */

export type DriveMode = 'nav' | 'twist' | 'wheels'

export interface SimParams extends NavParams {
  /** LiDAR noise multiplier. */
  noise: number
  /** Wheel-slip noise on/off. */
  slip: boolean
  /** Inflation margin beyond the robot radius, meters. */
  inflation: number
}

export const DEFAULT_PARAMS: SimParams = {
  maxSpeed: 0.35,
  lookahead: 0.35,
  brushWidth: 0.3,
  teleopSpeed: 0.3,
  safety: true,
  noise: 1,
  slip: false,
  inflation: 0.04,
}

/** Brush strip center: under the nose, where the roller and side brushes sit. */
export const BRUSH_OFFSET_X = 0.11
const BUMP_HOLD = 0.35
const MAX_SUBSTEPS = 24
/** A pose change bigger than this between substeps is a teleport, not motion: snap. */
const TELEPORT_M = 0.25
const TELEPORT_RAD = 0.6

function copyPose(dst: Pose2, src: Pose2): void {
  dst.x = src.x
  dst.y = src.y
  dst.th = src.th
}
const SLIP_SIGMA = 0.04
const SLIP_TAU = 0.4
/** Depenetration: passes (a wall and an obstacle can push back in turn) and the gap left. */
const PUSH_ITERS = 8
const PUSH_SLOP = 1e-5

export class SweeperSim {
  size: number
  half: number
  obstacles: readonly Obstacle[]
  /** Ground truth: where the chassis really is (collision, LiDAR rays, brush). */
  readonly pose: Pose2
  /** What is drawn: `pose` interpolated between the last two substeps (see step()). */
  readonly renderPose: Pose2 = { x: 0, y: 0, th: 0 }
  private readonly prevPose: Pose2 = { x: 0, y: 0, th: 0 }
  /**
   * Where the robot believes it is: dead reckoning from the encoder speeds, which the
   * navigator, the map and the CODE sandbox use, as on the real robot. It equals `pose`
   * exactly unless WHEEL SLIP is on; then the ground moves differently from what the
   * encoders count, the belief drifts and the map smears like an odometry-only robot's.
   */
  readonly odom: Pose2
  /** Actual wheel speeds, rad/s (what the encoders read). */
  readonly wheel = new Float64Array(4)
  /** Commanded wheel speeds after saturation, rad/s. */
  readonly wheelTarget = new Float64Array(4)
  /** Commanded body twist after safety and saturation. */
  readonly cmdTwist: Twist = { vx: 0, vy: 0, wz: 0 }
  /** Actual body twist over the ground. */
  readonly twist: Twist = { vx: 0, vy: 0, wz: 0 }
  readonly scene = new RayScene()
  readonly lidar = new Ld06()
  readonly rng: Rng
  grid: OccupancyGrid
  planMap: PlanningMap
  coverage: CoverageMap
  nav: Navigator
  params: SimParams = { ...DEFAULT_PARAMS }
  drive: DriveMode = 'nav'
  readonly extTwist: Twist = { vx: 0, vy: 0, wz: 0 }
  readonly extWheels = new Float64Array(4)
  /** HARDWARE: pose/wheels are set from telemetry, physics is skipped. */
  external = false
  /** HARDWARE without a pose stream: integrate odometry from the measured wheels. */
  odomFromWheels = true
  /** False while real LiDAR scans arrive (HARDWARE), so the simulated one pauses. */
  simLidar = true
  bump = false
  bumps = 0
  t = 0
  odometer = 0
  private bumpHold = 0
  private acc = 0
  private readonly slipDev = new Float64Array(4)
  private readonly ground = new Float64Array(4)
  private readonly next: Pose2 = { x: 0, y: 0, th: 0 }
  private readonly pushDir: Vec2 = { x: 0, y: 0 }
  private readonly encTwist: Twist = { vx: 0, vy: 0, wz: 0 }
  /** True while `odom` may differ from `pose` (slip on, not HARDWARE). */
  private drift = false
  /** cos / sin of the belief-minus-truth heading, for filing scans in the belief frame. */
  private dc = 1
  private ds = 0
  private readonly navIn: NavInput
  private readonly sink: ScanSink = (ox, oy, ex, ey, hit) => {
    if (!this.drift) {
      this.grid.integrateRay(ox, oy, ex, ey, hit)
      return
    }
    // the sensor measured from the true pose; the robot files it where it believes it is
    const p = this.pose, q = this.odom, c = this.dc, s = this.ds
    const ax = ox - p.x, ay = oy - p.y, bx = ex - p.x, by = ey - p.y
    this.grid.integrateRay(q.x + c * ax - s * ay, q.y + s * ax + c * ay, q.x + c * bx - s * by, q.y + s * bx + c * by, hit)
  }

  constructor(size = ARENA_DEFAULT, obstacles: readonly Obstacle[] = defaultLayout(size), seed = 1) {
    this.rng = new Rng(seed)
    this.size = size
    this.half = size / 2
    this.obstacles = obstacles
    this.pose = startPose(size)
    this.odom = startPose(size)
    this.snapRender()
    this.grid = new OccupancyGrid(makeGridGeom(size))
    this.planMap = new PlanningMap(this.grid)
    this.coverage = new CoverageMap(this.grid.geom)
    this.nav = new Navigator(this.planMap, this.rng, this.half)
    this.navIn = { pose: this.odom, bins: this.lidar.bins, bump: false }
    this.applyInflation()
    this.scene.set(this.half, obstacles, LIDAR_HEIGHT)
    this.coverage.rebuildFree(this.half, obstacles)
  }

  /** New room size and layout: maps are rebuilt, the robot goes back to the start. */
  setArena(size: number, obstacles: readonly Obstacle[]): void {
    const mode = this.nav.mode
    this.size = size
    this.half = size / 2
    this.obstacles = obstacles
    this.grid = new OccupancyGrid(makeGridGeom(size))
    this.planMap = new PlanningMap(this.grid)
    this.coverage = new CoverageMap(this.grid.geom)
    const prev = this.nav
    this.nav = new Navigator(this.planMap, this.rng, this.half)
    this.nav.teleopDir = prev.teleopDir
    this.nav.teleopTurn = prev.teleopTurn
    this.nav.mode = mode
    this.applyInflation()
    this.scene.set(this.half, obstacles, LIDAR_HEIGHT)
    this.coverage.rebuildFree(this.half, obstacles)
    this.resetRobot()
  }

  /** Obstacles moved/added/removed. `final` also rebuilds the ground-truth coverage mask. */
  setObstacles(obstacles: readonly Obstacle[], final = true): void {
    this.obstacles = obstacles
    this.scene.set(this.half, obstacles, LIDAR_HEIGHT)
    if (final) this.coverage.rebuildFree(this.half, obstacles)
  }

  setInflation(margin: number): void {
    this.params = { ...this.params, inflation: margin }
    this.applyInflation()
    this.nav.restart()
  }

  private applyInflation(): void {
    this.planMap.radius = ROBOT_RADIUS + this.params.inflation + CELL_SIZE / 2
  }

  resetRobot(): void {
    const s = startPose(this.size)
    this.pose.x = s.x
    this.pose.y = s.y
    this.pose.th = s.th
    this.resetOdom()
    this.wheel.fill(0)
    this.wheelTarget.fill(0)
    this.slipDev.fill(0)
    zero(this.twist)
    zero(this.cmdTwist)
    this.bump = false
    this.bumpHold = 0
    this.bumps = 0
    this.odometer = 0
    this.t = 0
    this.acc = 0
    this.snapRender()
    this.nav.replans = 0
    this.nav.restart()
  }

  /** Forget everything sensed: occupancy, coverage, the LiDAR buffer and the plan. */
  resetMap(): void {
    this.grid.clear()
    this.coverage.clear()
    this.lidar.reset()
    this.nav.restart()
  }

  step(dt: number): void {
    if (!(dt > 0)) return
    this.acc += dt
    let n = 0
    while (this.acc >= SUBSTEP && n < MAX_SUBSTEPS) {
      copyPose(this.prevPose, this.pose)
      this.substep(SUBSTEP)
      this.acc -= SUBSTEP
      n++
    }
    if (n === MAX_SUBSTEPS) this.acc = 0
    this.updateRenderPose()
  }

  /**
   * Render interpolation: physics runs in fixed 1/120 s steps, so the last completed
   * step lags the frame by 0..8.3 ms, a different amount every frame (visible judder).
   * The drawn pose blends the last two steps by the leftover fraction instead, which
   * trails real time by a constant one substep and moves perfectly evenly.
   */
  private updateRenderPose(): void {
    const a = this.prevPose, b = this.pose, r = this.renderPose
    if (Math.hypot(b.x - a.x, b.y - a.y) > TELEPORT_M || Math.abs(wrapAngle(b.th - a.th)) > TELEPORT_RAD) {
      this.snapRender()
      return
    }
    const f = Math.min(Math.max(this.acc / SUBSTEP, 0), 1)
    r.x = a.x + (b.x - a.x) * f
    r.y = a.y + (b.y - a.y) * f
    r.th = wrapAngle(a.th + wrapAngle(b.th - a.th) * f)
  }

  /** Draw exactly the physics pose (after a reset, a replay restore or a telemetry jump). */
  snapRender(): void {
    copyPose(this.prevPose, this.pose)
    copyPose(this.renderPose, this.pose)
  }

  private substep(h: number): void {
    // without slip the encoders are exact, so belief = truth (also after edits, replay, HW poses)
    this.drift = this.params.slip && !this.external
    if (!this.drift) this.resetOdom()
    this.command(h)
    if (this.external) this.externalMotion(h)
    else this.physics(h)
    if (this.drift) {
      const d = this.odom.th - this.pose.th
      this.dc = Math.cos(d)
      this.ds = Math.sin(d)
    } else {
      this.resetOdom()
    }
    if (this.simLidar) this.lidar.step(h, this.pose.x, this.pose.y, this.pose.th, this.scene, this.rng, this.sink)
    const c = Math.cos(this.pose.th), s = Math.sin(this.pose.th)
    this.coverage.paint(this.pose.x + BRUSH_OFFSET_X * c, this.pose.y + BRUSH_OFFSET_X * s, this.pose.th, this.params.brushWidth, BRUSH_DEPTH)
    this.bumpHold = Math.max(0, this.bumpHold - h)
    this.bump = this.bumpHold > 0
    this.t += h
  }

  /** Controller -> wheel targets (saturated, direction preserved). */
  private command(h: number): void {
    if (this.drive === 'nav') {
      this.navIn.bump = this.bump
      this.navIn.bins = this.lidar.bins
      this.nav.tick(h, this.navIn, this.params, this.cmdTwist)
      mecanumInverse(this.cmdTwist.vx, this.cmdTwist.vy, this.cmdTwist.wz, this.wheelTarget)
    } else if (this.drive === 'twist') {
      mecanumInverse(this.extTwist.vx, this.extTwist.vy, this.extTwist.wz, this.wheelTarget)
    } else {
      for (let i = 0; i < 4; i++) this.wheelTarget[i] = this.extWheels[i]
    }
    saturateWheels(this.wheelTarget, MAX_WHEEL_SPEED)
    mecanumForward(this.wheelTarget, this.cmdTwist)
  }

  private physics(h: number): void {
    rateLimitWheels(this.wheel, this.wheelTarget, MAX_WHEEL_ACCEL * h)
    for (let i = 0; i < 4; i++) {
      if (this.params.slip) {
        const d = this.slipDev[i]
        this.slipDev[i] = d - (d / SLIP_TAU) * h + SLIP_SIGMA * Math.sqrt((2 * h) / SLIP_TAU) * this.rng.gauss()
      }
      this.ground[i] = this.wheel[i] * (this.params.slip ? 1 + this.slipDev[i] : 1)
    }
    mecanumForward(this.ground, this.twist)
    if (this.drift) mecanumForward(this.wheel, this.encTwist)
    const moved = this.move(h)
    // the encoders count the wheels for as long as the chassis actually moved
    const e = this.encTwist
    if (this.drift) integratePose(this.odom, e.vx, e.vy, e.wz, moved, this.odom)
  }

  /** Integrate the pose and enforce the no-penetration rule. Returns the time moved. */
  private move(h: number): number {
    const p = this.pose, tw = this.twist
    const obs = this.obstacles
    if (footprintCollides(p.x, p.y, p.th, FOOT_HX, FOOT_HY, obs, this.half) && !this.depenetrate()) {
      // wedged where no push frees it: let it drive (out) rather than freeze
      integratePose(p, tw.vx, tw.vy, tw.wz, h, this.next)
      this.accept(h)
      return h
    }
    integratePose(p, tw.vx, tw.vy, tw.wz, h, this.next)
    if (!footprintCollides(this.next.x, this.next.y, this.next.th, FOOT_HX, FOOT_HY, obs, this.half)) {
      this.accept(h)
      return h
    }
    let lo = 0, hi = 1
    for (let k = 0; k < 10; k++) {
      const mid = (lo + hi) / 2
      integratePose(p, tw.vx, tw.vy, tw.wz, h * mid, this.next)
      if (footprintCollides(this.next.x, this.next.y, this.next.th, FOOT_HX, FOOT_HY, obs, this.half)) hi = mid
      else lo = mid
    }
    integratePose(p, tw.vx, tw.vy, tw.wz, h * lo, this.next)
    this.accept(h * lo)
    this.markContact(tw)
    this.wheel.fill(0)
    zero(this.twist)
    if (!this.bump) this.bumps++
    this.bump = true
    this.bumpHold = BUMP_HOLD
    return h * lo
  }

  /**
   * Bumper hit: write the contact point (footprint edge in the direction of travel) into
   * the map's contact layer, so the planner avoids obstacles the LiDAR plane misses. It is
   * filed relative to the believed pose, like the scans. A pure spin is not marked.
   */
  private markContact(tw: Twist): void {
    if (Math.hypot(tw.vx, tw.vy) < 0.01) return
    const b = this.drift ? this.odom : this.pose
    const phi = Math.atan2(tw.vy, tw.vx)
    const reach = exitDistance(phi, -FOOT_HX, FOOT_HX, -FOOT_HY, FOOT_HY) + CELL_SIZE / 2
    const a = b.th + phi
    this.grid.markContact(b.x + reach * Math.cos(a), b.y + reach * Math.sin(a))
  }

  /** Make the belief the truth (reset, replay, slip off). */
  resetOdom(): void {
    this.odom.x = this.pose.x
    this.odom.y = this.pose.y
    this.odom.th = this.pose.th
  }

  /** Distance between the believed and the true position, meters. */
  get odomError(): number {
    return Math.hypot(this.odom.x - this.pose.x, this.odom.y - this.pose.y)
  }

  /**
   * The footprint starts a step inside something: an edit or a replay put it there, or the
   * HARDWARE odometry drove the twin into virtual furniture before the switch back to SIM.
   * A rigid robot cannot overlap, so it is pushed out along the minimum translation (a few
   * passes, for corners where a wall and an obstacle push back). False when it is wedged.
   */
  private depenetrate(): boolean {
    const p = this.pose, obs = this.obstacles, n = this.pushDir
    for (let it = 0; it < PUSH_ITERS; it++) {
      for (let i = 0; i < obs.length; i++) {
        const depth = footprintPush(p.x, p.y, p.th, FOOT_HX, FOOT_HY, obs[i], n)
        if (depth < 0) continue
        p.x += n.x * (depth + PUSH_SLOP)
        p.y += n.y * (depth + PUSH_SLOP)
      }
      const ex = FOOT_HX * Math.abs(Math.cos(p.th)) + FOOT_HY * Math.abs(Math.sin(p.th))
      const ey = FOOT_HX * Math.abs(Math.sin(p.th)) + FOOT_HY * Math.abs(Math.cos(p.th))
      p.x = Math.max(ex - this.half, Math.min(this.half - ex, p.x))
      p.y = Math.max(ey - this.half, Math.min(this.half - ey, p.y))
      if (!footprintCollides(p.x, p.y, p.th, FOOT_HX, FOOT_HY, obs, this.half)) return true
    }
    return false
  }

  /**
   * Feed a real LD06 scan (HARDWARE) at the current pose: drawn and mapped like a simulated
   * one. The first real scan also drops what the simulated LD06 saw of the virtual room, so
   * stale virtual ranges never mix with real ones (min range, safety layer, readLidar).
   */
  ingestScan(scan: LidarScan): number {
    if (this.simLidar) {
      this.lidar.reset()
      this.simLidar = false
    }
    return this.lidar.ingest(scan, this.pose.x, this.pose.y, this.pose.th, this.sink)
  }

  private accept(h: number): void {
    this.odometer += Math.hypot(this.twist.vx, this.twist.vy) * h
    this.pose.x = this.next.x
    this.pose.y = this.next.y
    this.pose.th = this.next.th
  }

  private externalMotion(h: number): void {
    mecanumForward(this.wheel, this.twist)
    if (!this.odomFromWheels) return
    integratePose(this.pose, this.twist.vx, this.twist.vy, this.twist.wz, h, this.next)
    this.accept(h)
  }

  get speed(): number {
    return Math.hypot(this.twist.vx, this.twist.vy)
  }
}

function zero(t: Twist): void {
  t.vx = 0
  t.vy = 0
  t.wz = 0
}
