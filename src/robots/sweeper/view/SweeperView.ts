import * as THREE from 'three'
import type { DriveSource } from '../../../core/types'
import type { Obstacle } from '../geom2d'
import type { SweeperSim } from '../sim'
import { ArenaView, type PickHit } from './arenaView'
import { makeLayerHook } from './layers'
import { LidarFan } from './lidarFan'
import { MapLayer } from './mapLayer'
import { disposePalette, makePalette, sourceColor, type Palette } from './materials'
import { PlanLayer } from './planLayer'
import { RobotModel } from './robotModel'

/*
 * Everything the SWEEPER draws, as one object the module poses once per frame from the
 * sim state: robot, room + obstacles, occupancy / coverage textures, LiDAR fan, planner
 * overlays. Holds no simulation state of its own beyond visual integrators (wheel spin).
 */

export interface ViewFlags {
  map: boolean
  coverage: boolean
  rays: boolean
  plan: boolean
}

/** Point the FOLLOW camera tracks: the chassis center, a little above the floor. */
const FOLLOW_HEIGHT = 0.08

export class SweeperView {
  readonly root = new THREE.Group()
  private readonly pal: Palette
  private readonly robot: RobotModel
  private readonly arena: ArenaView
  private readonly map = new MapLayer()
  private readonly fan: LidarFan
  private readonly plan = new PlanLayer()
  private readonly hook: THREE.Mesh
  private readonly follow = new THREE.Vector3()
  private forceMap = true
  private goalPreview = false

  constructor(sim: SweeperSim) {
    this.pal = makePalette()
    this.robot = new RobotModel(this.pal)
    this.arena = new ArenaView(this.pal)
    this.fan = new LidarFan(sim.lidar.samples)
    this.hook = makeLayerHook()
    this.root.name = 'sweeper-view'
    this.root.add(this.hook, this.arena.group, this.map.group, this.plan.group, this.fan.group, this.robot.group)
    this.rebuildArena(sim, null)
  }

  /** New room size or a new map grid: walls, floor marks, textures and obstacles. */
  rebuildArena(sim: SweeperSim, selected: number | null): void {
    this.arena.buildRoom(sim.size)
    this.map.rebuild(sim.grid.geom)
    this.arena.setObstacles(sim.obstacles, selected)
    this.forceMap = true
  }

  setObstacles(obstacles: readonly Obstacle[], selected: number | null): void {
    this.arena.setObstacles(obstacles, selected)
  }

  moveObstacle(o: Obstacle): void {
    this.arena.moveObstacle(o)
  }

  setSelected(id: number | null): void {
    this.arena.setSelected(id)
  }

  setBrushWidth(width: number): void {
    this.robot.setBrushWidth(width)
  }

  setSource(source: DriveSource): void {
    this.robot.setSourceColor(sourceColor(source))
  }

  /** The next map upload ignores the 10 Hz throttle (RESET MAP while paused, edits). */
  invalidateMap(): void {
    this.forceMap = true
  }

  /** Goal marker preview while the user drags a GOTO goal (endGoalPreview hands it back). */
  previewGoal(x: number, y: number): void {
    this.goalPreview = true
    this.plan.setGoal(x, y, true)
  }

  endGoalPreview(): void {
    this.goalPreview = false
  }

  pick(raycaster: THREE.Raycaster): PickHit | null {
    return this.arena.pick(raycaster)
  }

  sync(sim: SweeperSim, dt: number, flags: ViewFlags): void {
    const nav = sim.nav
    const moving = sim.speed > 0.01 || Math.abs(sim.twist.wz) > 0.05
    this.robot.update(sim.renderPose, sim.wheel, dt, sim.lidar.headAngle, moving, sim.bump)
    this.map.sync(sim.grid, sim.coverage, dt, flags.map, flags.coverage, this.forceMap)
    this.forceMap = false
    this.fan.visible = flags.rays
    if (flags.rays) this.fan.sync(sim.lidar)
    if (!this.goalPreview) this.plan.setGoal(nav.goalX, nav.goalY, nav.mode === 'goto' && nav.hasGoal)
    this.plan.sync(nav, dt, flags.plan)
  }

  followTarget(sim: SweeperSim): THREE.Vector3 {
    return this.follow.set(sim.renderPose.x, FOLLOW_HEIGHT, -sim.renderPose.y)
  }

  dispose(): void {
    this.robot.dispose()
    this.arena.dispose()
    this.map.dispose()
    this.fan.dispose()
    this.plan.dispose()
    this.hook.geometry.dispose()
    ;(this.hook.material as THREE.Material).dispose()
    disposePalette(this.pal)
    this.root.removeFromParent()
    this.root.clear()
  }
}
