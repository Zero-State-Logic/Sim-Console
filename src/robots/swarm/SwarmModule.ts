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
  RobotKind,
  SandboxCommand,
  SandboxFnDef,
  SensorSnapshot,
  StepContext,
  TelemetryFrame,
  TelemetryTable,
} from '../../core/types'
import { parseSwarmConfig, serializeSwarmConfig } from './config'
import { applySwarmTelemetry, buildSwarmCommand, hardwareSpec, swarmTable } from './hardwareIO'
import { WaypointTool } from './pointer'
import { SWARM_SANDBOX_API, applySwarmCommands, swarmSensors } from './sandboxIO'
import { GAIN_KEYS, SCHEMA, applyValues, buildLayout, droneCountFrom, sanitizeControl, schemaFor } from './schema'
import { SwarmScene } from './scene/swarmScene'
import type { SceneOpts } from './scene/swarmScene'
import { DEFAULT_GAINS } from './sim/controller'
import { simToThree } from './sim/frames'
import { applySnapshot, takeSnapshot } from './sim/snapshot'
import type { SwarmSnapshot } from './sim/snapshot'
import { SwarmSim, defaultSettings } from './sim/swarmSim'
import { SwarmTelemetry } from './telemetry'
import { SWARM_WORLD } from './world'

/*
 * SWARM (PLAN §3.3): 3-6 quadrotors with 12-state rigid-body dynamics, cascaded PID,
 * a virtual-structure formation behind a route-flying leader, ORCA avoidance and wind.
 *
 * The module is glue: SwarmSim (pure TS, sim/) owns the physics and the mission,
 * SwarmScene (scene/) mirrors it into three.js, SwarmTelemetry fills the instruments,
 * and hardwareIO / sandboxIO translate the HARDWARE and CODE drive sources.
 *
 *   SIM       physics + inner loops at the PHYSICS RATE, guidance at 100 Hz
 *   CODE      the same sim; user commands retarget drones (one frame of latency)
 *   HARDWARE  no physics: telemetry mirrors the real drones, the mission layer runs
 *             on top and its targets go out as position setpoints (ghost slots)
 */

/** Smoothing of the measured step cost readout. */
const COST_ALPHA = 0.1
/** A restore this soon after the previous one continues the trails (replay playback), s. */
const TRAIL_CONTINUE_S = 0.5
const VSCALE_MIN = 1
const VSCALE_MAX = 4

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export class SwarmModule extends BaseModule {
  readonly kind: RobotKind = 'swarm'
  readonly label = 'SWARM'
  readonly world = SWARM_WORLD
  private readonly sim: SwarmSim
  private readonly scene: SwarmScene
  private readonly tel: SwarmTelemetry
  private readonly tool = new WaypointTool()
  private readonly api: SandboxFnDef[] = [...SWARM_SANDBOX_API]
  private readonly opts: SceneOpts = { trails: true, slots: true, vscale: 2.5, hover: -1 }
  private readonly follow = new THREE.Vector3()
  private readonly ray = new Float64Array(6)
  private layout: InstrumentLayout
  private schema: ControlDef[]
  private source: DriveSource = 'sim'
  private costMs = 0
  private lastRestoreT = Number.NaN
  /** Sim state when HARDWARE was entered, restored if no telemetry ever arrived. */
  private preMirror: SwarmSnapshot | null = null
  private mirrored = false

  constructor() {
    super()
    this.initValues([...SCHEMA])
    const n = droneCountFrom(this.values.drones)
    this.sim = new SwarmSim(n, defaultSettings())
    applyValues(this.values, this.sim.settings)
    this.scene = new SwarmScene(this.root)
    this.scene.buildFleet(this.sim)
    this.tel = new SwarmTelemetry(n)
    this.layout = buildLayout(n)
    this.schema = schemaFor(this.values)
    this.readDisplay()
    this.syncScene(0)
  }

  /** The simulation behind the module (read-only use: tests, tools). */
  get simulation(): SwarmSim {
    return this.sim
  }

  /* ---------------- loop ---------------- */

  update(dt: number, ctx: StepContext): void {
    // dt = 0 calls are re-poses (pause, replay scrubbing restores with source 'sim'), not
    // drive-source switches; HARDWARE and CODE are also entered from their own entry points
    if (dt > 0) this.enterSource(ctx.source)
    const t0 = nowMs()
    if (this.source === 'hardware') this.sim.advanceMirror(dt)
    else this.sim.advance(dt)
    if (dt > 0) this.costMs += (nowMs() - t0 - this.costMs) * COST_ALPHA
    this.syncScene(dt)
  }

  reset(): void {
    this.sim.reset()
    this.tool.cancel()
    this.scene.clearTrails()
    this.costMs = 0
    if (this.source === 'hardware') this.beginMirror()
    this.syncScene(0)
  }

  dispose(): void {
    this.scene.dispose()
    super.dispose()
  }

  /** Drive-source transitions, detected from the step context (the runtime has no hook). */
  private enterSource(next: DriveSource): void {
    const prev = this.source
    if (next === prev) return
    this.source = next
    if (prev === 'hardware') this.endMirror()
    if (prev === 'code') this.sim.clearManual()
    if (next === 'hardware') this.beginMirror()
  }

  private beginMirror(): void {
    this.preMirror = takeSnapshot(this.sim)
    this.mirrored = false
    this.sim.enterMirror()
  }

  /** Back to the sim: from the real drones' last state, or as it was if none ever reported. */
  private endMirror(): void {
    const snap = this.preMirror
    this.preMirror = null
    if (this.mirrored || !snap) {
      this.sim.resumeFromMirror()
      return
    }
    const t = this.sim.t
    if (applySnapshot(this.sim, snap)) this.onFleetChanged()
    this.sim.t = Math.max(t, this.sim.t)
    this.sim.refreshGuidance()
  }

  private syncScene(dt: number): void {
    this.opts.hover = this.tool.hover
    this.scene.sync(this.sim, dt, this.opts)
  }

  /* ---------------- controls ---------------- */

  getControlSchema(): ControlDef[] {
    return this.schema
  }

  setControl(key: string, value: ControlValue): void {
    const def = this.schema.find((d) => d.key === key)
    if (!def) return
    const v = sanitizeControl(def, value)
    if (v !== null) super.setControl(key, v)
  }

  protected onControl(key: string, value: ControlValue): void {
    switch (key) {
      case 'takeoff':
        this.sim.takeoff()
        break
      case 'land':
        this.sim.land()
        break
      case 'clearWp':
        this.sim.clearWaypoints()
        this.tool.cancel()
        break
      case 'defaultRoute':
        this.sim.setDefaultRoute()
        this.tool.cancel()
        break
      case 'reset':
        this.reset()
        break
      case 'resetGains':
        this.resetGains()
        break
      case 'drones':
        this.rebuildFleet(droneCountFrom(value))
        break
      default:
        applyValues(this.values, this.sim.settings)
        this.readDisplay()
    }
    this.schema = schemaFor(this.values)
  }

  private resetGains(): void {
    const next = { ...this.values }
    for (const k of GAIN_KEYS) next[k] = DEFAULT_GAINS[k]
    this.values = next
    applyValues(this.values, this.sim.settings)
  }

  private readDisplay(): void {
    this.opts.trails = this.bool('trails', true)
    this.opts.slots = this.bool('slots', true)
    this.opts.vscale = Math.min(Math.max(this.num('vscale', 2.5), VSCALE_MIN), VSCALE_MAX)
  }

  private rebuildFleet(n: number): void {
    this.values = { ...this.values, drones: String(n) }
    if (n === this.sim.count) return
    this.sim.rebuild(n)
    if (this.source === 'hardware') this.beginMirror()
    this.onFleetChanged()
  }

  /** The drone count changed: new visuals, telemetry shape and layout. */
  private onFleetChanged(): void {
    const n = this.sim.count
    this.values = { ...this.values, drones: String(n) }
    this.scene.buildFleet(this.sim)
    this.tel.resize(n)
    this.layout = buildLayout(n)
    this.tool.cancel()
    this.bumpRevision()
    this.syncScene(0)
  }

  /* ---------------- instruments ---------------- */

  getInstrumentLayout(): InstrumentLayout {
    return this.layout
  }

  getTelemetry(): TelemetryFrame {
    return this.tel.fill(this.sim, this.costMs, this.source === 'hardware')
  }

  /* ---------------- scene ---------------- */

  /** The leader, or the fleet centroid while nobody leads. */
  followTarget(): THREE.Vector3 {
    const l = this.sim.leader
    if (l) {
      const k = this.sim.renderLead
      simToThree(this.follow, l.s[0] + l.s[3] * k, l.s[1] + l.s[4] * k, l.s[2] + l.s[5] * k)
      return this.follow
    }
    let x = 0, y = 0, z = 0
    for (const d of this.sim.drones) {
      x += d.s[0]
      y += d.s[1]
      z += d.s[2]
    }
    const k = 1 / Math.max(1, this.sim.count)
    simToThree(this.follow, x * k, y * k, z * k)
    return this.follow
  }

  onPointer(e: PointerEvt): boolean {
    const r = e.raycaster.ray
    const ray = this.ray
    ray[0] = r.origin.x
    ray[1] = r.origin.y
    ray[2] = r.origin.z
    ray[3] = r.direction.x
    ray[4] = r.direction.y
    ray[5] = r.direction.z
    if (e.type === 'down') return !e.ctrlKey && !e.altKey && this.tool.down(this.sim, e.button, e.shiftKey, ray)
    if (e.type === 'move') return this.tool.move(this.sim, ray)
    return this.tool.up(this.sim, ray)
  }

  /* ---------------- record / replay, profiles ---------------- */

  snapshot(): SwarmSnapshot {
    return takeSnapshot(this.sim)
  }

  restore(s: unknown): void {
    const rebuilt = applySnapshot(this.sim, s)
    if (rebuilt === null) return
    if (rebuilt) this.onFleetChanged()
    this.sim.refreshGuidance()
    const step = this.sim.t - this.lastRestoreT
    if (step > 0 && step < TRAIL_CONTINUE_S) this.scene.pushTrails(this.sim)
    else this.scene.clearTrails()
    this.lastRestoreT = this.sim.t
    this.syncScene(0)
  }

  serializeConfig(): unknown {
    return serializeSwarmConfig(this.sim)
  }

  /** Waypoints + formation settings. Throws on a value that is not a swarm config. */
  loadConfig(c: unknown): void {
    if (c === null || c === undefined) return
    const parsed = parseSwarmConfig(c)
    if (!parsed) throw new Error('Not a swarm config (expected waypoints and formation settings).')
    if (parsed.waypoints) this.sim.setWaypoints(parsed.waypoints)
    this.values = { ...this.values, ...parsed.values }
    applyValues(this.values, this.sim.settings)
    this.schema = schemaFor(this.values)
    this.tool.cancel()
    // the schema was rebuilt: tell the shell to re-read controls and layout
    this.bumpRevision()
  }

  /* ---------------- HARDWARE ---------------- */

  getHardwareSpec(): HardwareSpec {
    return hardwareSpec(this.sim)
  }

  buildCommand(_level: CommandLevel): CmdMsg {
    // only the bridge asks, under HARDWARE, and it can ask before this frame's update():
    // enter the mirror first so stale sim targets never go out to real airframes
    this.enterSource('hardware')
    // both levels are position setpoints: every drone runs its own flight controller
    return buildSwarmCommand(this.sim, true)
  }

  applyTelemetry(tel: TelMsg): void {
    // telemetry only flows under HARDWARE, possibly before this frame's update()
    this.enterSource('hardware')
    if (applySwarmTelemetry(this.sim, tel) > 0) this.mirrored = true
  }

  telemetryTable(tel: TelMsg | null): TelemetryTable {
    return swarmTable(this.sim, tel)
  }

  /* ---------------- CODE ---------------- */

  getSandboxApi(): SandboxFnDef[] {
    return this.api
  }

  getSandboxSensors(): SensorSnapshot {
    return swarmSensors(this.sim)
  }

  applySandboxCommands(cmds: SandboxCommand[]): void {
    this.enterSource('code')
    const fx = applySwarmCommands(this.sim, cmds)
    if (fx.shape && fx.shape !== this.values.shape) {
      this.values = { ...this.values, shape: fx.shape }
      this.sim.settings.shape = fx.shape
      // the control rail re-reads values on a revision bump
      this.bumpRevision()
    }
  }

  releaseSandbox(): void {
    this.sim.clearManual()
  }
}
