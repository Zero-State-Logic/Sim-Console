import * as THREE from 'three'
import { BaseModule } from '../../core/BaseModule'
import type { CmdMsg, TelMsg } from '../../core/protocol'
import type {
  CommandLevel,
  ControlDef,
  ControlValue,
  DriveSource,
  HardwareSpec,
  InstrumentLayout,
  PointerEvt,
  SandboxCommand,
  SandboxFnDef,
  SensorSnapshot,
  StepContext,
  TelemetryFrame,
  TelemetryTable,
  WorldConfig,
} from '../../core/types'
import { parseArenaConfig, rescaleLayout, startPose } from './arena'
import { FOOT_HX, FOOT_HY, MODES, type NavMode } from './constants'
import { FLAG_KEYS, PARAM_KEYS, PARAM_TOGGLES, isArenaAction, sanitizeControl, type ArenaAction } from './controls'
import { ArenaEditor } from './editor'
import { obstacleOverlapsObb, type Obstacle } from './geom2d'
import { buildCmd, hardwareSpec, parseTelemetry, telemetryRows } from './hardwareMap'
import { OdomAnchor } from './odomAnchor'
import { parseSnapshot, serializeArena, takeSnapshot } from './persist'
import { Rng } from './rng'
import { SANDBOX_API, applySandbox, sandboxSensors } from './sandboxApi'
import { LAYOUT, SCHEMA, schemaFor, worldFor } from './schema'
import { SweeperSim } from './sim'
import { TelemetryBuilder } from './telemetry'
import { SweeperView, type ViewFlags } from './view/SweeperView'

/*
 * SWEEPER module glue: the shell-facing RobotModule around SweeperSim (physics, LD06,
 * mapping, planning) and SweeperView (three.js). It routes controls, pointer editing,
 * the HARDWARE link (encoders, odometry, real scans) and the CODE sandbox.
 * HARDWARE: the pose comes from the board's odometry (anchored to where the twin stood,
 * see odomAnchor.ts) and the wheels from its encoders; the navigator keeps running so
 * its wheel / twist targets are what buildCommand() streams.
 */

/** Sim seconds without telemetry before the twin treats the board as silent. */
const TEL_STALE = 0.5
/** Sim seconds without a real scan before the simulated LD06 takes over again. */
const SCAN_STALE = 1
/** Status text refresh, sim seconds (it is a string, so not rebuilt every frame). */
const STATUS_PERIOD = 0.2
/** Goals stay this far inside the walls. */
const GOAL_INSET = 0.05

export class SweeperModule extends BaseModule {
  readonly kind = 'sweeper' as const
  readonly label = 'SWEEPER'
  readonly sim: SweeperSim
  private readonly view: SweeperView
  private readonly editor = new ArenaEditor()
  private readonly telemetry = new TelemetryBuilder()
  private readonly anchor = new OdomAnchor()
  private readonly editRng = new Rng(0xa7e4a)
  private readonly spec: HardwareSpec = hardwareSpec()
  private readonly flags: ViewFlags = { map: true, coverage: true, rays: true, plan: true }
  private readonly dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private readonly dragHit = new THREE.Vector3()
  private source: DriveSource = 'sim'
  private covOverride: number | null = null
  private goalDrag = false
  private goalX = 0
  private goalY = 0
  private telAge = Infinity
  private scanAge = Infinity
  private hasEnc = false
  private status = ''
  private statusAge = Infinity

  constructor() {
    super()
    this.sim = new SweeperSim()
    this.editor.setAll(this.sim.obstacles)
    this.initValues(SCHEMA)
    this.view = new SweeperView(this.sim)
    this.root.add(this.view.root)
    for (const d of SCHEMA) if (d.type !== 'button') this.onControl(d.key, this.values[d.key])
    this.view.setSource('sim')
  }

  get world(): WorldConfig {
    return worldFor(this.sim.size)
  }

  /* ---------------- frame ---------------- */

  update(dt: number, ctx: StepContext): void {
    if (dt > 0) {
      // dt = 0 frames include record/replay re-posing, which always reports 'sim'
      this.syncSource(ctx.source)
      this.covOverride = null
      if (this.source === 'hardware') this.watchHardware(dt)
      this.sim.step(dt)
      this.statusAge += dt
    }
    this.view.sync(this.sim, dt, this.flags)
  }

  reset(): void {
    this.sim.resetRobot()
    this.sim.resetMap()
    this.covOverride = null
    this.anchor.reset()
    this.editor.endDrag()
    this.goalDrag = false
    this.view.endGoalPreview()
    this.telemetry.invalidate()
    this.view.invalidateMap()
    this.statusAge = Infinity
  }

  dispose(): void {
    this.view.dispose()
    super.dispose()
  }

  getControlSchema(): ControlDef[] {
    return schemaFor(this.editor.selected !== null)
  }

  getInstrumentLayout(): InstrumentLayout {
    return LAYOUT
  }

  getTelemetry(): TelemetryFrame {
    if (this.statusAge >= STATUS_PERIOD) {
      this.status = this.statusText()
      this.statusAge = 0
    }
    return this.telemetry.update(this.sim, this.status, this.covOverride)
  }

  private statusText(): string {
    const nav = this.sim.nav.statusText()
    if (this.source === 'code' && this.sim.drive !== 'nav') return 'CODE · YOUR PROGRAM'
    if (this.source === 'hardware') return this.telAge > TEL_STALE ? 'HW · NO TELEMETRY' : `HW · ${nav}`
    return nav
  }

  followTarget(): THREE.Vector3 {
    return this.view.followTarget(this.sim)
  }

  /* ---------------- drive source ---------------- */

  private syncSource(src: DriveSource): void {
    if (src === this.source) return
    const prev = this.source
    this.source = src
    if (prev === 'hardware') {
      this.sim.external = false
      this.sim.simLidar = true
    }
    if (prev === 'code') this.releaseDrive()
    if (src === 'hardware') {
      this.sim.external = true
      this.sim.wheel.fill(0)
      this.anchor.reset()
      this.telAge = Infinity
      this.scanAge = Infinity
      this.hasEnc = false
    } else if (src === 'code') {
      // the robot waits for the program; setMode() hands it back to a built-in behaviour
      this.sim.drive = 'twist'
      this.zeroExternal()
    }
    this.view.setSource(src)
    this.statusAge = Infinity
  }

  private releaseDrive(): void {
    this.sim.drive = 'nav'
    this.zeroExternal()
  }

  private zeroExternal(): void {
    this.sim.extTwist.vx = 0
    this.sim.extTwist.vy = 0
    this.sim.extTwist.wz = 0
    this.sim.extWheels.fill(0)
  }

  /** Before each HARDWARE step: silent board -> twin stands still; no encoders -> show the command. */
  private watchHardware(dt: number): void {
    this.telAge += dt
    this.scanAge += dt
    if (this.telAge > TEL_STALE) this.sim.wheel.fill(0)
    else if (!this.hasEnc) this.sim.wheel.set(this.sim.wheelTarget)
    if (!this.sim.simLidar && this.scanAge > SCAN_STALE) this.sim.simLidar = true
  }

  /* ---------------- controls ---------------- */

  setControl(key: string, value: ControlValue): void {
    const def = this.getControlSchema().find((d) => d.key === key)
    if (!def || def.disabled) return
    const v = sanitizeControl(def, value)
    if (v === null) return
    super.setControl(key, v)
  }

  protected onControl(key: string, v: ControlValue): void {
    const sim = this.sim
    if (key in PARAM_KEYS && typeof v === 'number') {
      sim.params = { ...sim.params, [PARAM_KEYS[key]]: v }
      if (key === 'noise') sim.lidar.noise = v
      if (key === 'brush') this.view.setBrushWidth(v)
      return
    }
    if (key in PARAM_TOGGLES && typeof v === 'boolean') {
      sim.params = { ...sim.params, [PARAM_TOGGLES[key]]: v }
      return
    }
    if (key in FLAG_KEYS && typeof v === 'boolean') {
      this.flags[FLAG_KEYS[key]] = v
      this.view.invalidateMap()
      return
    }
    if (isArenaAction(key)) {
      this.arenaAction(key)
      return
    }
    this.otherControl(key, v)
  }

  private otherControl(key: string, v: ControlValue): void {
    const sim = this.sim
    switch (key) {
      case 'mode':
        this.setMode(v as NavMode)
        break
      case 'arena':
        if (typeof v === 'number') this.setArenaSize(v)
        break
      case 'inflation':
        if (typeof v === 'number') sim.setInflation(v)
        break
      case 'dir':
        sim.nav.teleopDir = String(v)
        if (v !== 'stop') this.enterTeleop()
        break
      case 'turn':
        sim.nav.teleopTurn = String(v)
        if (v !== 'none') this.enterTeleop()
        break
      case 'resetMap':
        sim.resetMap()
        this.view.invalidateMap()
        break
    }
  }

  private setMode(m: NavMode): void {
    if (!MODES.includes(m)) return
    this.sim.nav.setMode(m)
    this.sim.drive = 'nav'
  }

  /** Drive keys take over in SIM and HARDWARE (in CODE the program keeps the wheel). */
  private enterTeleop(): void {
    if (this.source === 'code' || this.sim.nav.mode === 'teleop') return
    this.values = { ...this.values, mode: 'teleop' }
    this.setMode('teleop')
  }

  /** Mode changed from outside the control rail (sandbox, goal click): mirror it in the values. */
  private syncModeValue(): void {
    if (this.values.mode === this.sim.nav.mode) return
    this.values = { ...this.values, mode: this.sim.nav.mode }
    this.bumpRevision()
  }

  /* ---------------- arena ---------------- */

  private setArenaSize(size: number): void {
    if (Math.abs(size - this.sim.size) < 1e-9) return
    const obstacles = rescaleLayout(this.editor.obstacles, this.sim.size, size)
    this.applyArena(size, obstacles)
    // the world config (camera presets, shadow area) scales with the room
    this.bumpRevision()
  }

  private applyArena(size: number, obstacles: readonly Obstacle[]): void {
    this.sim.setArena(size, obstacles)
    this.editor.setAll(obstacles)
    this.view.rebuildArena(this.sim, this.editor.selected)
    this.anchor.reset()
    this.telemetry.invalidate()
  }

  private arenaAction(key: ArenaAction): void {
    const sim = this.sim
    const hadSelection = this.editor.selected !== null
    switch (key) {
      case 'addBox':
      case 'addCyl':
        this.editor.add(key === 'addBox' ? 'box' : 'cyl', this.editRng, sim.size, sim.pose)
        break
      case 'removeSel':
        this.editor.removeSelected()
        break
      case 'randomize':
        this.editor.randomize(this.editRng, sim.size, sim.pose)
        break
      case 'clear':
        this.editor.clear()
        break
    }
    this.commitObstacles()
    if (key === 'randomize' || key === 'clear') {
      // a different room: what was mapped and swept no longer applies
      sim.resetMap()
      this.view.invalidateMap()
    }
    if (hadSelection !== (this.editor.selected !== null)) this.bumpRevision()
  }

  private commitObstacles(): void {
    this.sim.setObstacles(this.editor.obstacles, true)
    this.view.setObstacles(this.editor.obstacles, this.editor.selected)
  }

  private select(id: number | null): void {
    const had = this.editor.selected !== null
    if (!this.editor.select(id)) return
    this.view.setSelected(this.editor.selected)
    if (had !== (this.editor.selected !== null)) this.bumpRevision()
  }

  /* ---------------- pointer ---------------- */

  onPointer(e: PointerEvt): boolean {
    if (e.type === 'down') return this.pointerDown(e)
    if (e.type === 'move') return this.pointerMove(e)
    return this.pointerUp(e)
  }

  private pointerDown(e: PointerEvt): boolean {
    if (e.button !== 0) return false
    const hit = this.view.pick(e.raycaster)
    if (hit) {
      this.select(hit.id)
      return this.editor.beginDrag(hit.id, hit.x, hit.y, hit.h, e.altKey)
    }
    const g = e.ground
    if (g && (this.sim.nav.mode === 'goto' || e.shiftKey) && this.insideRoom(g.x, -g.z)) {
      this.goalDrag = true
      this.moveGoalPreview(g.x, -g.z)
      return true
    }
    this.select(null)
    return false
  }

  private pointerMove(e: PointerEvt): boolean {
    if (this.editor.dragging) {
      this.dragPlane.constant = -this.editor.dragPlaneY
      const p = e.raycaster.ray.intersectPlane(this.dragPlane, this.dragHit)
      const moved = p ? this.editor.dragTo(p.x, -p.z, this.sim.half, this.sim.pose) : null
      if (moved) {
        // the LiDAR sees the obstacle move live; the coverage mask is rebuilt on release
        this.sim.setObstacles(this.editor.obstacles, false)
        this.view.moveObstacle(moved)
      }
      return true
    }
    if (this.goalDrag) {
      if (e.ground) this.moveGoalPreview(e.ground.x, -e.ground.z)
      return true
    }
    return false
  }

  private pointerUp(_e: PointerEvt): boolean {
    if (this.editor.endDrag()) {
      this.sim.setObstacles(this.editor.obstacles, true)
      return true
    }
    if (!this.goalDrag) return false
    this.goalDrag = false
    this.view.endGoalPreview()
    this.setGoal(this.goalX, this.goalY)
    return true
  }

  private moveGoalPreview(x: number, y: number): void {
    const lim = this.sim.half - GOAL_INSET
    this.goalX = Math.max(-lim, Math.min(lim, x))
    this.goalY = Math.max(-lim, Math.min(lim, y))
    this.view.previewGoal(this.goalX, this.goalY)
  }

  private insideRoom(x: number, y: number): boolean {
    return Math.abs(x) < this.sim.half && Math.abs(y) < this.sim.half
  }

  /** GOTO goal (plan meters): switches to GOTO and hands the wheels to the navigator. */
  setGoal(x: number, y: number): void {
    if (this.sim.nav.mode !== 'goto') this.sim.nav.setMode('goto')
    this.sim.drive = 'nav'
    this.sim.nav.setGoal(x, y)
    this.syncModeValue()
  }

  /* ---------------- record / replay, profiles ---------------- */

  snapshot(): unknown {
    return takeSnapshot(this.sim)
  }

  /** Rewinds pose, wheels, bump and the coverage figure; the map textures keep their live state. */
  restore(s: unknown): void {
    const snap = parseSnapshot(s)
    if (!snap) return
    const sim = this.sim
    sim.pose.x = snap.x
    sim.pose.y = snap.y
    sim.pose.th = snap.th
    sim.snapRender()
    sim.resetOdom()
    sim.wheel.set(snap.w)
    sim.bump = snap.bump
    this.covOverride = snap.cov
  }

  serializeConfig(): unknown {
    return serializeArena(this.sim.size, this.editor.obstacles)
  }

  /** Arena size + obstacles from a profile. Obstacles that would sit on the start pose are dropped. */
  loadConfig(c: unknown): void {
    if (c === null || c === undefined) return
    const parsed = parseArenaConfig(c)
    if (!parsed) throw new Error('SWEEPER: the saved arena is not a valid {size, obstacles} config.')
    const s = startPose(parsed.size)
    const obstacles = parsed.obstacles.filter((o) => !obstacleOverlapsObb(o, s.x, s.y, FOOT_HX, FOOT_HY, s.th, 0.05))
    this.values = { ...this.values, arena: parsed.size }
    this.applyArena(parsed.size, obstacles)
    this.bumpRevision()
  }

  /* ---------------- HARDWARE ---------------- */

  getHardwareSpec(): HardwareSpec {
    return this.spec
  }

  buildCommand(level: CommandLevel): CmdMsg {
    return buildCmd(level, this.sim.wheelTarget, this.sim.cmdTwist, this.sim.nav.mode)
  }

  applyTelemetry(tel: TelMsg): void {
    // telemetry only flows in HARDWARE, and the bridge applies it before this frame's update()
    this.syncSource('hardware')
    const p = parseTelemetry(tel)
    const sim = this.sim
    this.telAge = 0
    if (p.enc) {
      sim.wheel.set(p.enc)
      this.hasEnc = true
    }
    if (p.pose) {
      const [ox, oy, oth] = p.pose
      if (!this.anchor.valid) this.anchor.set(sim.pose, ox, oy, oth)
      this.anchor.map(ox, oy, oth, sim.pose)
    }
    if (p.scan) {
      // also pauses the simulated LD06 and drops its virtual-room ranges
      sim.ingestScan(p.scan)
      this.scanAge = 0
    }
  }

  telemetryTable(tel: TelMsg | null): TelemetryTable {
    return telemetryRows(this.sim.wheelTarget, tel)
  }

  /* ---------------- CODE ---------------- */

  getSandboxApi(): SandboxFnDef[] {
    return SANDBOX_API
  }

  getSandboxSensors(): SensorSnapshot {
    return sandboxSensors(this.sim)
  }

  applySandboxCommands(cmds: SandboxCommand[]): void {
    // commands only flow in CODE and arrive before update(): enter CODE first, so the
    // entry reset cannot swallow a program's very first drive()
    this.syncSource('code')
    applySandbox(this.sim, cmds)
    this.syncModeValue()
  }

  releaseSandbox(): void {
    this.releaseDrive()
  }
}
