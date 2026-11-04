import * as THREE from 'three'
import { BaseModule } from '../../core/BaseModule'
import type {
  CommandLevel,
  ControlDef,
  ControlValue,
  DriveSource,
  HardwareSpec,
  InstrumentLayout,
  RobotKind,
  SandboxCommand,
  SandboxFnDef,
  SensorSnapshot,
  StepContext,
  TelemetryFrame,
  TelemetryTable,
} from '../../core/types'
import type { CmdMsg, TelMsg } from '../../core/protocol'
import { clampDims, heightRange, standHeightFor, type WalkerDims } from './geometry'
import { MAX_DUTY } from './gaits'
import type { TwistCmd } from './gaitEngine'
import { ACTUATOR_PRESETS, type ActuatorParams, type ActuatorPresetId } from './actuator'
import {
  ACT_FIELDS,
  DIM_KEYS,
  KEY,
  PARAM_KEYS,
  POSE_KEYS,
  POSE_LIMITS,
  actuatorToUi,
  buildSchema,
  dirVector,
  legCountFrom,
  presetFrom,
  sanitizeControl,
  turnSign,
  uiToActuator,
  type ActuatorUi,
  type PhysicsMode,
} from './controls'
import { TelemetryWriter, buildInstrumentLayout } from './instruments'
import { highCommand, jointCommand, loadToNewtons, validAngles, validImu, walkerHardwareSpec, walkerTelemetryTable } from './hardwareSpec'
import { SandboxOverrides, WALKER_SANDBOX_API, applyWalkerCommands, walkerSensors, type SandboxTarget } from './sandboxApi'
import { parseWalkerConfig, parseWalkerSnapshot, serializeWalkerConfig, type WalkerConfig, type WalkerSnapshot } from './config'
import { rotationZYX, rpyFromRotation } from './pose'
import { WalkerSim } from './sim'
import { DynamicMode } from './physics/dynamicMode'
import type { Rapier } from './physics/loader'
import { WalkerVisual } from './scene/WalkerVisual'
import { createMaterials, materialList } from './scene/materials'
import { WALKER_WORLD } from './world'

/* ============================================================
   WALKER MODULE — the RobotModule the shell runs. It owns the
   control values and wires them to the pure sim (gait → IK →
   actuators → statics), the optional Rapier world, the three.js
   rig, the instruments, the HARDWARE wire format and the CODE API.
   ============================================================ */

const DEG = Math.PI / 180
/** Measured joint angles beyond this are clamped (a corrupt frame cannot fold the rig). */
const MAX_MEASURED_DEG = 180

export interface WalkerModuleOptions {
  /** Clock for hardware-telemetry freshness, seconds. Default: performance.now() / 1000. */
  clock?: () => number
  /** Rapier loader (tests inject a failing one). */
  loadPhysics?: () => Promise<Rapier>
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function sameDims(a: WalkerDims, b: WalkerDims): boolean {
  return a.coxa === b.coxa && a.femur === b.femur && a.tibia === b.tibia && a.bodyRadius === b.bodyRadius
}

export class WalkerModule extends BaseModule {
  readonly kind: RobotKind = 'walker'
  readonly label = 'WALKER'
  readonly world = WALKER_WORLD
  /** The pure simulation core (exposed for tests and inspection). */
  readonly sim = new WalkerSim(6)

  private readonly visual: WalkerVisual
  private readonly dynamic: DynamicMode
  private readonly writer: TelemetryWriter
  private readonly sb = new SandboxOverrides()
  private readonly clock: () => number
  private readonly cmd: TwistCmd = { vx: 0, vy: 0, wz: 0 }
  private readonly follow = new THREE.Vector3()
  private readonly rpy = new Float64Array(3)
  private schema: ControlDef[] = []
  private layout: InstrumentLayout
  private physicsMode: PhysicsMode = 'kinematic'
  private preset: ActuatorPresetId = 'ideal'
  /** CUSTOM actuator values (kept while another preset is active). */
  private custom: ActuatorUi = actuatorToUi(ACTUATOR_PRESETS.mg996r)
  private failedText = ''
  /** Something changed that a paused (dt = 0) frame should still show. */
  private dirty = true
  private disposed = false
  private t = 0

  private readonly sandboxTarget: SandboxTarget = {
    setJoint: (j, rad) => {
      this.sim.jointOverride[j] = rad
    },
    setLeg: (i, x, y, z) => {
      this.sim.legOverride[i * 3] = x
      this.sim.legOverride[i * 3 + 1] = y
      this.sim.legOverride[i * 3 + 2] = z
    },
    walk: (vx, vy, wz) => this.sb.walk(vx, vy, wz),
    stop: () => this.sb.walk(0, 0, 0),
    setGait: (index) => {
      const g = this.sim.gaits[index]
      if (g) this.selectGait(g.id)
    },
    setBodyHeight: (h) => {
      this.sb.height = h
    },
    setBodyPose: (roll, pitch, yaw) => {
      this.sb.roll = clamp(roll, -POSE_LIMITS.roll * DEG, POSE_LIMITS.roll * DEG)
      this.sb.pitch = clamp(pitch, -POSE_LIMITS.pitch * DEG, POSE_LIMITS.pitch * DEG)
      this.sb.yaw = clamp(yaw, -POSE_LIMITS.yaw * DEG, POSE_LIMITS.yaw * DEG)
    },
  }

  constructor(opts: WalkerModuleOptions = {}) {
    super()
    this.clock = opts.clock ?? (() => performance.now() / 1000)
    const materials = createMaterials()
    for (const m of materialList(materials)) this.track(m)
    this.visual = this.track(new WalkerVisual(materials))
    this.root.add(this.visual.frame)
    this.dynamic = new DynamicMode(() => this.onPhysicsSettled(), opts.loadPhysics)
    this.writer = new TelemetryWriter(this.sim.n)
    this.layout = this.buildLayout()
    this.rebuildSchema()
    this.visual.build(this.sim.layout)
    this.applyParams()
    this.applyPose()
    this.sim.settle(this.clock())
    this.render()
  }

  /* ---------------- frame ---------------- */

  update(dt: number, ctx: StepContext): void {
    if (this.disposed) return
    this.t = ctx.t
    if (dt > 0) this.step(dt, ctx.source)
    else if (this.dirty && !this.dynamic.running) this.sim.settle(this.clock())
    this.dirty = false
    this.render()
  }

  /** RESET from the shell: back to the origin, standing (re-spawns the physics body). */
  reset(): void {
    this.respawn()
    this.render()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.dynamic.dispose()
    super.dispose()
  }

  followTarget(): THREE.Vector3 {
    return this.visual.followPoint(this.sim.state, this.follow)
  }

  /** Resolves once a pending DYNAMIC switch has settled (true = the world runs). */
  physicsReady(): Promise<boolean> {
    return this.dynamic.status === 'loading' || this.dynamic.running ? this.dynamic.enable(this.sim) : Promise.resolve(false)
  }

  private step(dt: number, source: DriveSource): void {
    const cmd = this.twist(source)
    const sim = this.sim
    if (!this.dynamic.running) {
      sim.stepKinematic(dt, cmd, this.clock())
      return
    }
    sim.plan(dt, cmd, false)
    sim.observe(this.clock())
    // a fresh hardware stream drives the physics twin with the measured angles
    this.dynamic.step(dt, sim, sim.isFresh(sim.measQAt) ? sim.measQ : sim.actuators.out)
  }

  /** Commanded body twist: CODE's walk() while it drives, else the direction pad, turn and speed. */
  private twist(source: DriveSource): TwistCmd {
    const c = this.cmd
    if (source === 'code' && this.sb.walking) {
      c.vx = this.sb.vx
      c.vy = this.sb.vy
      c.wz = this.sb.wz
      return c
    }
    const [dx, dy] = dirVector(this.str(KEY.dir, 'stop'))
    const k = this.num(KEY.speed, 60) / 100
    const e = this.sim.engine
    const p = this.sim.params
    const v = e.maxSpeed(p) * k
    c.vx = dx * v
    c.vy = dy * v
    c.wz = turnSign(this.str(KEY.turn, 'none')) * e.maxYawRate(p) * k
    return c
  }

  private render(): void {
    const s = this.sim.state
    this.visual.apply(s, this.sim.n, s.margin > 0)
    const g = this.sim.engine.ground
    this.visual.applyBelt(this.sim.params.treadmill, g[0], g[1], g[2])
  }

  /* ---------------- controls ---------------- */

  getControlSchema(): ControlDef[] {
    return this.schema
  }

  /** Validated write: unknown keys and out-of-schema values are ignored, sliders clamped. */
  setControl(key: string, value: ControlValue): void {
    if (this.disposed) return
    const def = this.schema.find((d) => d.key === key)
    if (!def) return
    const v = sanitizeControl(def, value)
    if (v === null) return
    if (def.type !== 'button') this.values = { ...this.values, [key]: v }
    this.dirty = true
    this.onControl(key, v)
  }

  protected onControl(key: string, value: ControlValue): void {
    if (key === KEY.legs || (DIM_KEYS as readonly string[]).includes(key)) this.reconfigure()
    else if (key === KEY.physics) this.setPhysics(value === 'dynamic' ? 'dynamic' : 'kinematic')
    else if (key === KEY.actuator) this.setPreset(presetFrom(String(value)))
    else if (Object.prototype.hasOwnProperty.call(ACT_FIELDS, key) && typeof value === 'number') this.setCustom(ACT_FIELDS[key], value)
    else if (key === KEY.gait) this.selectGait(String(value))
    else if (PARAM_KEYS.includes(key)) this.applyParams()
    else if (POSE_KEYS.includes(key)) this.applyPose()
    else if (key === KEY.resetPose) this.resetPose()
    else if (key === KEY.respawn) this.respawn()
  }

  private buildLayout(): InstrumentLayout {
    const sim = this.sim
    return buildInstrumentLayout({ n: sim.n, gaitLabel: sim.gait.label, stall: sim.actuator.stall, weight: sim.weight })
  }

  /** New schema + instrument layout for the current shape (leg count, gait, dims, physics, servo). */
  private rebuildSchema(): void {
    const sim = this.sim
    const range = heightRange(sim.layout.dims)
    this.schema = buildSchema({
      gaits: sim.gaits,
      minDuty: sim.gait.minDuty,
      physics: this.physicsMode,
      heightRange: range,
      standHeight: standHeightFor(sim.layout.dims),
    })
    this.initValues(this.schema)
    this.values = {
      ...this.values,
      [KEY.gait]: sim.gait.id,
      [KEY.duty]: clamp(this.num(KEY.duty, sim.gait.duty), sim.gait.minDuty, MAX_DUTY),
      [KEY.height]: clamp(this.num(KEY.height, range[0]), range[0], range[1]),
    }
    this.layout = this.buildLayout()
    this.bumpRevision()
  }

  /** Leg count or dimensions changed: rebuild the sim, the rig, the schema and the physics world. */
  private reconfigure(): void {
    const n = legCountFrom(this.str(KEY.legs, '6'))
    const dims = clampDims({ coxa: this.num('coxa'), femur: this.num('femur'), tibia: this.num('tibia'), bodyRadius: this.num('bodyRadius') })
    const sim = this.sim
    if (n === sim.n && sameDims(dims, sim.layout.dims)) return
    const gait = sim.gait.id
    sim.configure(n, dims)
    if (sim.gait.id !== gait) this.values = { ...this.values, [KEY.gait]: sim.gait.id, [KEY.duty]: sim.gait.duty, [KEY.gaitHz]: sim.gait.freq }
    this.visual.build(sim.layout)
    this.writer.resize(n)
    this.rebuildSchema()
    this.applyParams()
    this.applyPose()
    sim.settle(this.clock())
    this.dynamic.respawn(sim)
  }

  private selectGait(id: string): void {
    const sim = this.sim
    const g = sim.gaits.find((x) => x.id === id)
    if (!g || g.id === sim.gait.id) return
    sim.setGait(g.id)
    this.values = { ...this.values, [KEY.gait]: g.id, [KEY.duty]: g.duty, [KEY.gaitHz]: g.freq }
    this.applyParams()
    this.rebuildSchema()
  }

  private applyParams(): void {
    const p = this.sim.params
    p.freq = this.num(KEY.gaitHz, 1.2)
    p.stride = this.num(KEY.stride, 0.06)
    p.stepHeight = this.num(KEY.stepHeight, 0.035)
    p.duty = this.num(KEY.duty, this.sim.gait.duty)
    const treadmill = this.bool(KEY.treadmill) && this.physicsMode === 'kinematic'
    if (treadmill !== p.treadmill) this.sim.engine.ground.fill(0)
    p.treadmill = treadmill
  }

  /** Body pose from the sliders, with CODE's overrides on top; height kept reachable. */
  private applyPose(): void {
    const p = this.sim.pose
    const sb = this.sb
    const [lo, hi] = heightRange(this.sim.layout.dims)
    const pick = (override: number, key: string, scale: number): number => (Number.isNaN(override) ? this.num(key) * scale : override)
    p.height = clamp(pick(sb.height, KEY.height, 1), lo, hi)
    p.roll = pick(sb.roll, KEY.roll, DEG)
    p.pitch = pick(sb.pitch, KEY.pitch, DEG)
    p.yaw = pick(sb.yaw, KEY.yaw, DEG)
    p.shiftX = this.num(KEY.shiftX)
    p.shiftY = this.num(KEY.shiftY)
  }

  private resetPose(): void {
    const h = standHeightFor(this.sim.layout.dims)
    this.values = { ...this.values, [KEY.height]: h, [KEY.roll]: 0, [KEY.pitch]: 0, [KEY.yaw]: 0, [KEY.shiftX]: 0, [KEY.shiftY]: 0 }
    this.applyPose()
  }

  private respawn(): void {
    this.sim.reset()
    this.dynamic.respawn(this.sim)
    this.dirty = true
  }

  /* ---------------- actuator + physics ---------------- */

  private setPreset(id: ActuatorPresetId): void {
    this.preset = id
    const p = id === 'custom' ? uiToActuator(this.custom) : { ...ACTUATOR_PRESETS[id] }
    this.applyActuator(p, id === 'custom' ? this.custom : actuatorToUi(p))
  }

  /** An actuator slider moved: switch to CUSTOM, starting from the active preset's values. */
  private setCustom(field: keyof ActuatorUi, v: number): void {
    const current = this.preset === 'custom' ? this.custom : actuatorToUi(this.sim.actuator)
    // re-applying a preset's own value (profiles do) keeps the preset
    if (this.preset !== 'custom' && Math.abs(current[field] - v) < 1e-9) return
    this.custom = { ...current, [field]: v }
    this.preset = 'custom'
    this.values = { ...this.values, [KEY.actuator]: 'custom' }
    this.applyActuator(uiToActuator(this.custom), this.custom)
  }

  private applyActuator(p: ActuatorParams, ui: ActuatorUi): void {
    this.sim.actuator = p
    this.values = {
      ...this.values,
      [KEY.actTau]: ui.tauMs,
      [KEY.actSpeed]: ui.speedDeg,
      [KEY.actStall]: ui.stallNm,
      [KEY.actDeadband]: ui.deadbandDeg,
      [KEY.actBacklash]: ui.backlashDeg,
    }
    this.dynamic.configure(p)
    // the torque chart range and stall line follow the servo; other edits keep the layout
    const next = this.buildLayout()
    if (JSON.stringify(next.charts[0]) !== JSON.stringify(this.layout.charts[0])) this.rebuildSchema()
  }

  private setPhysics(mode: PhysicsMode): void {
    if (mode === this.physicsMode) return
    if (mode === 'kinematic') {
      if (this.dynamic.running) this.sim.adoptBodyPose()
      this.dynamic.disable()
    } else {
      this.failedText = ''
      void this.dynamic.enable(this.sim)
    }
    this.physicsMode = mode
    this.applyParams()
    this.rebuildSchema()
  }

  /** The async Rapier load finished: running, or failed and fell back to KINEMATIC. */
  private onPhysicsSettled(): void {
    if (this.disposed) return
    if (this.dynamic.status === 'failed') {
      this.failedText = `KINEMATIC · PHYSICS FAILED: ${this.dynamic.error}`.slice(0, 120)
      this.physicsMode = 'kinematic'
      this.values = { ...this.values, [KEY.physics]: 'kinematic' }
      this.applyParams()
    }
    this.dirty = true
    this.rebuildSchema()
  }

  private physicsText(): string {
    const d = this.dynamic
    if (d.status === 'loading') return 'INITIALIZING PHYSICS'
    if (d.running) return d.tipped ? 'DYNAMIC · TIPPED, PRESS RESPAWN' : 'DYNAMIC · RAPIER 240 Hz'
    return this.failedText || 'KINEMATIC'
  }

  /* ---------------- instruments ---------------- */

  getInstrumentLayout(): InstrumentLayout {
    return this.layout
  }

  getTelemetry(): TelemetryFrame {
    const e = this.sim.engine
    const speed = this.dynamic.running ? this.dynamic.speed : Math.hypot(e.twist[0], e.twist[1])
    return this.writer.write(this.sim, { t: this.t, speed, driveUtil: e.driveUtil, physics: this.physicsText() })
  }

  /* ---------------- record / replay + profiles ---------------- */

  snapshot(): WalkerSnapshot {
    const s = this.sim.state
    const n = this.sim.n
    rpyFromRotation(s.bodyR, this.rpy)
    return {
      v: 1,
      body: [s.bodyPos[0], s.bodyPos[1], s.bodyPos[2], this.rpy[0], this.rpy[1], this.rpy[2]],
      q: Array.from(s.q.subarray(0, n * 3)),
      c: Array.from(s.contact.subarray(0, n)),
    }
  }

  /** Shows a recorded frame (display state only; the live gait and physics are untouched). */
  restore(snap: unknown): void {
    const r = parseWalkerSnapshot(snap, this.sim.n)
    if (!r) return
    const s = this.sim.state
    s.bodyPos[0] = r.body[0]
    s.bodyPos[1] = r.body[1]
    s.bodyPos[2] = r.body[2]
    rotationZYX(r.body[5], r.body[4], r.body[3], s.bodyR)
    for (let j = 0; j < r.q.length; j++) s.q[j] = r.q[j]
    for (let i = 0; i < r.c.length; i++) s.contact[i] = r.c[i]
    this.sim.evaluateRestored()
    this.dirty = false
    this.render()
  }

  serializeConfig(): WalkerConfig {
    return serializeWalkerConfig(this.sim.layout.dims, this.custom)
  }

  loadConfig(c: unknown): void {
    const cfg = parseWalkerConfig(c, this.serializeConfig())
    if (!cfg) return
    this.custom = cfg.actuator
    const d = cfg.dims
    this.values = { ...this.values, coxa: d.coxa, femur: d.femur, tibia: d.tibia, bodyRadius: d.bodyRadius }
    this.reconfigure()
    if (this.preset === 'custom') this.applyActuator(uiToActuator(this.custom), this.custom)
    this.dirty = true
  }

  /* ---------------- HARDWARE ---------------- */

  getHardwareSpec(): HardwareSpec {
    return walkerHardwareSpec(this.sim)
  }

  buildCommand(level: CommandLevel): CmdMsg {
    return level === 'joint' ? jointCommand(this.sim) : highCommand(this.sim)
  }

  /** Fresh measured angles pose the rig (FK), loads drive the bars, the IMU tilts the body. */
  applyTelemetry(tel: TelMsg): void {
    if (!tel || typeof tel !== 'object') return
    const sim = this.sim
    const n = sim.n
    const now = this.clock()
    if (validAngles(tel.ang, n * 3)) {
      for (let j = 0; j < n * 3; j++) sim.measQ[j] = clamp(tel.ang[j], -MAX_MEASURED_DEG, MAX_MEASURED_DEG) * DEG
      sim.measQAt = now
    }
    if (Array.isArray(tel.load) && tel.load.length >= n) {
      loadToNewtons(tel.load, sim.weight, sim.measLoad, n)
      sim.measLoadAt = now
    }
    if (validImu(tel.imu)) {
      for (let k = 0; k < 3; k++) sim.measImu[k] = clamp(tel.imu[k], -MAX_MEASURED_DEG, MAX_MEASURED_DEG) * DEG
      sim.measImuAt = now
    }
    this.dirty = true
  }

  telemetryTable(tel: TelMsg | null): TelemetryTable {
    return walkerTelemetryTable(this.sim, tel)
  }

  /* ---------------- CODE ---------------- */

  getSandboxApi(): SandboxFnDef[] {
    return WALKER_SANDBOX_API
  }

  getSandboxSensors(): SensorSnapshot {
    rpyFromRotation(this.sim.state.bodyR, this.rpy)
    return walkerSensors(this.sim, this.rpy)
  }

  applySandboxCommands(cmds: SandboxCommand[]): void {
    if (this.disposed || !Array.isArray(cmds) || cmds.length === 0) return
    applyWalkerCommands(cmds, this.sim.n, this.sandboxTarget)
    this.applyPose()
    this.dirty = true
  }

  releaseSandbox(): void {
    this.sim.clearOverrides()
    this.sb.clear()
    this.applyPose()
    this.dirty = true
  }
}
