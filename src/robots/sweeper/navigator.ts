import { CELL_SIZE, REPLAN_PERIOD, type NavMode } from './constants'
import { laneRows, laneSpacing, nextLane, planLanes, type Lane } from './coverage'
import type { Pose2, Twist } from './mecanum'
import { pathLength, MAX_PATH_POINTS, type PlanningMap } from './planningMap'
import { followTarget, PurePursuit, type FollowParams, type PursuitTarget } from './pursuit'
import type { Rng } from './rng'
import { applySafety } from './safety'
import { Wander } from './wander'

/*
 * The SWEEPER brain. Every substep it turns the current mode into a body twist:
 *   COVERAGE  boustrophedon lanes over the inflated LiDAR map, joined by A* transits
 *   GOTO      A* to a clicked goal, holonomic pure pursuit
 *   TELEOP    direction pad + turn
 *   WANDER    reactive random walk
 * The blocked mask refreshes at 4 Hz (a path that became blocked replans at once) and
 * paths are re-planned at 2 Hz as the map fills. The safety layer runs last.
 */

export interface NavParams {
  maxSpeed: number
  lookahead: number
  brushWidth: number
  teleopSpeed: number
  safety: boolean
}

export interface NavInput {
  pose: Pose2
  bins: Float32Array
  bump: boolean
}

type Phase = 'transit' | 'sweep' | 'done'

const DIRS: Record<string, [number, number]> = {
  f: [1, 0], b: [-1, 0], l: [0, 1], r: [0, -1],
  fl: [Math.SQRT1_2, Math.SQRT1_2], fr: [Math.SQRT1_2, -Math.SQRT1_2],
  bl: [-Math.SQRT1_2, Math.SQRT1_2], br: [-Math.SQRT1_2, -Math.SQRT1_2],
}
const TURNS: Record<string, number> = { ccw: 1, cw: -1 }

const MASK_PERIOD = 0.25
const STUCK_TIME = 5

export class Navigator {
  mode: NavMode = 'coverage'
  replans = 0
  /** Last safety factor applied to translation (1 = unrestricted). */
  safety = 1
  teleopDir = 'stop'
  teleopTurn = 'none'
  hasGoal = false
  goalX = 0
  goalY = 0
  arrived = false
  readonly pursuit = new PurePursuit()
  lanes: Lane[] = []
  /** Bumped when the lane preview changes. */
  lanesVersion = 0
  phase: Phase = 'transit'
  lane: Lane | null = null
  readonly tgt: PursuitTarget = { x: 0, y: 0, remaining: 0, cross: 0, done: true }
  private cursorRow = -1
  private cursorX = -Infinity
  private maskTimer = 0
  private planTimer = 0
  private targetX = 0
  private targetY = 0
  private hasTarget = false
  private stuckTimer = 0
  private bestRemaining = Infinity
  private readonly wander = new Wander()
  private readonly buf = new Float64Array(MAX_PATH_POINTS * 2)
  private readonly follow: FollowParams = { maxSpeed: 0.3, decel: 0.6, faceMotion: true }

  constructor(private readonly map: PlanningMap, private readonly rng: Rng, private half: number) {}

  setHalf(half: number): void {
    this.half = half
  }

  setMode(m: NavMode): void {
    this.mode = m
    this.restart()
  }

  setGoal(x: number, y: number): void {
    this.hasGoal = true
    this.goalX = x
    this.goalY = y
    this.arrived = false
    this.setTarget(x, y)
  }

  /** Restart the current mode from scratch (new coverage pass, fresh plan). */
  restart(): void {
    this.cursorRow = -1
    this.cursorX = -Infinity
    this.lane = null
    this.phase = 'transit'
    this.arrived = false
    this.hasTarget = false
    this.pursuit.clear()
    this.wander.reset()
    this.maskTimer = 0
    this.planTimer = 0
    if (this.mode === 'goto' && this.hasGoal) this.setTarget(this.goalX, this.goalY)
  }

  /** Remaining length of the planned path from the robot's projection, meters. */
  get pathRemaining(): number {
    return this.pursuit.n ? this.tgt.remaining : 0
  }

  tick(dt: number, inp: NavInput, prm: NavParams, out: Twist): Twist {
    out.vx = 0
    out.vy = 0
    out.wz = 0
    if (this.mode === 'teleop') this.teleop(prm, out)
    else if (this.mode === 'wander') this.wander.tick(dt, inp.pose, inp.bins, inp.bump, this.rng, prm.maxSpeed * 0.8, out)
    else this.planning(dt, inp, prm, out)
    this.safety = prm.safety ? applySafety(inp.bins, out) : 1
    return out
  }

  private teleop(prm: NavParams, out: Twist): void {
    const d = DIRS[this.teleopDir]
    const turn = TURNS[this.teleopTurn] ?? 0
    out.vx = d ? d[0] * prm.teleopSpeed : 0
    out.vy = d ? d[1] * prm.teleopSpeed : 0
    out.wz = Math.max(-2.5, Math.min(2.5, (turn * Math.max(prm.teleopSpeed, 0.1)) / 0.22))
  }

  /** Human-readable state for the STATUS readout (called once per frame, not per substep). */
  statusText(): string {
    switch (this.mode) {
      case 'teleop':
        return this.teleopDir !== 'stop' || this.teleopTurn !== 'none' ? 'TELEOP · DRIVING' : 'TELEOP · READY'
      case 'wander':
        return this.wander.state === 'turn' ? 'WANDER · TURNING' : 'WANDER · CRUISE'
      case 'goto':
        if (!this.hasGoal) return 'GOTO · CLICK THE FLOOR'
        if (this.arrived) return 'GOTO · ARRIVED'
        return this.pursuit.n ? `GOTO · ${this.pathRemaining.toFixed(2)} M` : 'GOTO · NO PATH'
      default: {
        if (this.phase === 'done') return 'COVERAGE · COMPLETE'
        if (!this.lane) return 'COVERAGE · PLANNING'
        const tag = `${Math.max(1, this.currentLaneIndex() + 1)}/${this.lanes.length}`
        return this.phase === 'transit' ? `COVERAGE · TO LANE ${tag}` : `COVERAGE · LANE ${tag}`
      }
    }
  }

  /**
   * Index in `lanes` of the lane being swept or approached, -1 when none. The active lane
   * is a copy that may have been trimmed, so it is matched by row and end point.
   */
  currentLaneIndex(): number {
    const l = this.lane
    if (!l) return -1
    return this.lanes.findIndex((c) => c.row === l.row && Math.abs(c.xe - l.xe) < 0.3)
  }

  /** GOTO and COVERAGE: keep the map mask fresh, keep a valid path, follow it. */
  private planning(dt: number, inp: NavInput, prm: NavParams, out: Twist): void {
    this.maskTimer -= dt
    this.planTimer -= dt
    let refreshed = false
    if (this.maskTimer <= 0) {
      this.maskTimer = MASK_PERIOD
      this.map.refresh()
      refreshed = true
    }
    if (this.mode === 'coverage') this.coverageStep(refreshed, inp.pose, prm)
    else this.gotoStep()
    if (!this.hasTarget) return
    // a bump replans soon, but never more often than 6 Hz while the flag is held
    if (inp.bump && this.planTimer > 0.16) this.planTimer = 0.16
    if (this.planTimer <= 0 || (refreshed && this.pathBlocked())) this.replan(inp.pose)
    if (this.pursuit.n === 0) return
    this.pursuit.track(inp.pose.x, inp.pose.y, prm.lookahead, this.tgt)
    this.watchProgress(dt)
    if (this.tgt.done) {
      this.onTargetReached()
      return
    }
    this.follow.maxSpeed = this.phase === 'transit' || this.mode === 'goto' ? prm.maxSpeed : prm.maxSpeed * 0.85
    followTarget(inp.pose, this.tgt, this.follow, out)
  }

  private gotoStep(): void {
    if (!this.hasGoal || this.arrived) {
      this.hasTarget = false
      return
    }
    if (!this.hasTarget) this.setTarget(this.goalX, this.goalY)
  }

  private coverageStep(refreshed: boolean, pose: Pose2, prm: NavParams): void {
    if (refreshed || this.lanes.length === 0) this.refreshLanes(prm.brushWidth)
    if (this.phase === 'done') {
      this.hasTarget = false
      return
    }
    if (refreshed && this.lane) this.revalidateLane(pose)
    if (!this.lane) this.pickLane()
  }

  private refreshLanes(brush: number): void {
    const rows = laneRows(this.half, this.map.radius, laneSpacing(brush), CELL_SIZE)
    this.lanes = planLanes(this.map.blocked, this.map.grid.geom, this.half, rows)
    this.lanesVersion++
  }

  private pickLane(): void {
    const i = nextLane(this.lanes, this.cursorRow, this.cursorX)
    if (i < 0) {
      this.phase = 'done'
      this.lane = null
      this.hasTarget = false
      this.pursuit.clear()
      return
    }
    this.lane = { ...this.lanes[i] }
    this.phase = 'transit'
    this.setTarget(this.lane.xs, this.lane.y)
  }

  /**
   * After a map refresh: if the current lane target became blocked (new obstacle, or the
   * map edge moved), retarget to the overlapping free run of the same row; drop the lane
   * only when none is left.
   */
  private revalidateLane(pose: Pose2): void {
    const l = this.lane
    if (!l || !this.map.isBlockedAt(this.targetX, this.targetY)) return
    const lo = Math.min(l.xs, l.xe), hi = Math.max(l.xs, l.xe)
    const from = this.phase === 'sweep' ? pose.x : l.xs
    const dir = l.xe >= l.xs ? 1 : -1
    const same = this.lanes.find((c) => c.row === l.row && Math.max(c.xs, c.xe) > lo && Math.min(c.xs, c.xe) < hi && dir * (c.xe - from) > 0)
    if (!same) {
      if (this.phase === 'sweep') this.finishLane(pose.x)
      else this.lane = null
      return
    }
    if (this.phase === 'transit') {
      this.lane = { ...same }
      this.setTarget(same.xs, same.y)
    } else {
      this.lane = { ...l, xe: same.xe }
      this.setTarget(same.xe, l.y)
    }
  }

  private onTargetReached(): void {
    if (this.mode === 'goto') {
      this.arrived = true
      this.hasTarget = false
      this.pursuit.clear()
      return
    }
    const l = this.lane
    if (!l) return
    if (this.phase === 'transit') {
      this.phase = 'sweep'
      this.setTarget(l.xe, l.y)
    } else {
      this.finishLane(l.xe)
    }
  }

  private finishLane(x: number): void {
    if (this.lane) {
      this.cursorRow = this.lane.row
      this.cursorX = x
    }
    this.lane = null
    this.hasTarget = false
    this.pursuit.clear()
  }

  private setTarget(x: number, y: number): void {
    this.targetX = x
    this.targetY = y
    this.hasTarget = true
    this.pursuit.clear()
    this.planTimer = 0
    this.stuckTimer = 0
    this.bestRemaining = Infinity
  }

  private pathBlocked(): boolean {
    const p = this.pursuit
    // segment 0 starts at the robot, which may sit inside the inflation near a wall
    for (let i = Math.max(1, p.seg); i < p.n - 1; i++) {
      if (!this.map.segmentFree(p.pts[2 * i], p.pts[2 * i + 1], p.pts[2 * i + 2], p.pts[2 * i + 3])) return true
    }
    return false
  }

  private replan(pose: Pose2): void {
    this.planTimer = REPLAN_PERIOD
    const hadPath = this.pursuit.n > 0
    if (hadPath) this.pursuit.track(pose.x, pose.y, 0, this.tgt)
    const oldLen = this.pathRemaining
    const n = this.map.plan(pose.x, pose.y, this.targetX, this.targetY, this.buf)
    if (n === 0) {
      this.pursuit.clear()
      if (this.mode === 'coverage') this.skipLane(pose)
      return
    }
    // a snapped target (blocked goal) sticks, so later replans do not wander around it
    this.targetX = this.buf[2 * n - 2]
    this.targetY = this.buf[2 * n - 1]
    const newLen = pathLength(this.buf, n)
    if (hadPath && Math.abs(newLen - oldLen) > 0.1) this.replans++
    if (!hadPath || Math.abs(newLen - oldLen) > 0.02 || n !== this.pursuit.n) this.pursuit.setPath(this.buf, n)
  }

  /** Unreachable or stuck lane: skip it (count it done) and move on. */
  private skipLane(pose: Pose2): void {
    const l = this.lane
    if (!l) return
    this.finishLane(this.phase === 'sweep' ? pose.x : l.xe)
  }

  private watchProgress(dt: number): void {
    if (this.tgt.remaining < this.bestRemaining - 0.05) {
      this.bestRemaining = this.tgt.remaining
      this.stuckTimer = 0
      return
    }
    this.stuckTimer += dt
    if (this.stuckTimer < STUCK_TIME) return
    this.stuckTimer = 0
    this.bestRemaining = Infinity
    if (this.mode === 'coverage') this.finishLane(this.lane?.xe ?? 0)
    else this.pursuit.clear()
    this.replans++
  }
}
