import type * as THREE from 'three'
import type { CmdMsg, TelMsg } from './protocol'

/* ============================================================
   CORE CONTRACTS — every robot module implements RobotModule.
   The shell never knows what a spider is.
   Units: meters, seconds, radians internally; degrees on the wire
   and in the sandbox API. three.js is Y-up.
   ============================================================ */

export type RobotKind = 'walker' | 'sweeper' | 'swarm'
export type DriveSource = 'sim' | 'hardware' | 'code'

/* ---------------- controls ---------------- */

export type ControlValue = number | string | boolean

interface ControlBase {
  key: string
  label: string
  /** Panel the control is rendered in, e.g. 'LOCOMOTION', 'BODY POSE'. */
  group: string
  hint?: string
  hidden?: boolean
  disabled?: boolean
}

export interface SliderDef extends ControlBase {
  type: 'slider'
  min: number
  max: number
  step: number
  value: number
  unit?: string
  digits?: number
}

export interface SelectOption {
  value: string
  label: string
  /** Optional glyph for grid buttons (e.g. '↖'). */
  icon?: string
}

export interface SelectDef extends ControlBase {
  type: 'select'
  options: SelectOption[]
  value: string
  /** segmented = button row, dropdown = native select, grid3 = 3×3 direction pad. */
  display?: 'segmented' | 'dropdown' | 'grid3'
}

export interface ToggleDef extends ControlBase {
  type: 'toggle'
  value: boolean
}

/** A momentary action. The shell calls setControl(key, true). */
export interface ButtonDef extends ControlBase {
  type: 'button'
  tone?: 'default' | 'accent' | 'danger'
}

export type ControlDef = SliderDef | SelectDef | ToggleDef | ButtonDef

/* ---------------- instruments ---------------- */

export interface GaugeDef {
  key: string
  label: string
  /** CSS color or token var, e.g. 'var(--accent)'. */
  color: string
  min?: number
  max?: number
  unit?: string
}

export interface ChannelDef {
  key: string
  label: string
  color: string
}

export interface ChartDef {
  key: string
  title: string
  unit: string
  min?: number
  max?: number
  /** Seconds of history shown. Default 6. */
  windowSec?: number
  channels: ChannelDef[]
}

export interface BarsDef {
  title: string
  unit: string
  labels: string[]
  max: number
  colors?: string[]
}

export interface ReadoutDef {
  key: string
  label: string
  unit?: string
  digits?: number
}

export interface InstrumentLayout {
  /** Panel heading for the gauges, e.g. 'LOCOMOTION'. */
  title: string
  /** Right-aligned subheading, e.g. 'HEX · TRIPOD'. */
  subtitle: string
  gauges: GaugeDef[]
  charts: ChartDef[]
  bars?: BarsDef
  readouts: ReadoutDef[]
}

export interface TelemetryFrame {
  /** Sim time, seconds. */
  t: number
  gauges: Record<string, number>
  channels: Record<string, number>
  bars: number[]
  readouts: Record<string, number | string>
}

/* ---------------- scene / world ---------------- */

export type Vec3Tuple = [number, number, number]

export interface CameraPreset {
  id: string
  label: string
  position: Vec3Tuple
  target: Vec3Tuple
}

export interface WorldConfig {
  gridCellSize: number
  gridSectionSize: number
  gridFadeDistance: number
  /** Contact-shadow plane size in meters. */
  shadowScale: number
  minDistance: number
  maxDistance: number
  /** First entry is the default view. 'follow' is added by the shell. */
  cameraPresets: CameraPreset[]
}

export interface PointerEvt {
  type: 'down' | 'move' | 'up'
  button: number
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  raycaster: THREE.Raycaster
  /** Intersection of the pointer ray with the y=0 ground plane, if any. */
  ground: THREE.Vector3 | null
}

export interface StepContext {
  source: DriveSource
  /** Accumulated sim time, seconds. */
  t: number
}

/* ---------------- HARDWARE drive source ---------------- */

/** 'joint' = stream every joint target (USB). 'high' = send twist/gait, board runs its own IK (wireless). */
export type CommandLevel = 'joint' | 'high'

export interface HardwareSpec {
  robot: RobotKind
  /** Number of actuated joints the firmware drives (servos, wheel motors, or drones×1). */
  joints: number
  jointNames: string[]
  /** Degrees, joint space (0 = neutral). */
  jointLimits: [number, number][]
  /** Safe pose, degrees joint space. */
  homePose: number[]
  legs?: number
  wheels?: number
  drones?: number
  /** Default command level per transport class. */
  defaultLevel: { wired: CommandLevel; wireless: CommandLevel }
  /**
   * Geometry the firmware needs for on-board IK / kinematics ('high' level), in the
   * firmware body frame (REP-103: x forward, y left, z up; meters; degrees).
   *  walker : coxa, femur, tibia, standHeight, footReach, mountX[], mountY[], mountYawDeg[]
   *  sweeper: wheelRadius, halfLength, halfWidth, maxWheelSpeed
   *  swarm  : armLength, mass, cruiseAlt
   * Joint order is leg-major: [L1 coxa, L1 femur, L1 tibia, L2 coxa, ...].
   * Joint zero (neutral) = coxa straight out from its mount, femur horizontal, tibia
   * vertical pointing down. Signs: coxa + = CCW seen from above, femur + = up, tibia + = foot out.
   */
  geometry?: Record<string, number | number[]>
}

export interface TelemetryTable {
  cols: string[]
  rows: { label: string; cells: (number | string)[] }[]
}

/* ---------------- CODE drive source ---------------- */

export interface SandboxFnDef {
  /** Function name exposed to user code, e.g. 'setJoint', 'readLoad'. */
  name: string
  /** command = sent back to the module; query = answered in the worker from the sensor snapshot. */
  kind: 'command' | 'query'
  /** Parameter names, all numeric. */
  params: string[]
  /** query only: key in the sensor snapshot. If the value is an array, params[0] is the index. */
  sensor?: string
  doc: string
}

export interface SandboxCommand {
  fn: string
  args: number[]
}

export type SensorSnapshot = Record<string, number | number[]>

/* ---------------- the module ---------------- */

export interface RobotModule {
  readonly kind: RobotKind
  readonly label: string
  readonly root: THREE.Group
  readonly world: WorldConfig
  /** Bumped whenever the control schema or instrument layout changes shape. */
  readonly revision: number

  update(dt: number, ctx: StepContext): void
  reset(): void
  dispose(): void

  getControlSchema(): ControlDef[]
  getControlValues(): Record<string, ControlValue>
  setControl(key: string, value: ControlValue): void

  getInstrumentLayout(): InstrumentLayout
  getTelemetry(): TelemetryFrame

  /** World-space point the FOLLOW camera tracks. */
  followTarget(): THREE.Vector3 | null
  /** Return true when the module consumed the event (the shell then locks orbit). */
  onPointer?(e: PointerEvt): boolean

  /** Small structured-clonable state for record/replay. */
  snapshot(): unknown
  restore(s: unknown): void

  /** Module config beyond control values (e.g. obstacle layout, waypoints). */
  serializeConfig(): unknown
  loadConfig(c: unknown): void

  getHardwareSpec(): HardwareSpec
  buildCommand(level: CommandLevel): CmdMsg
  applyTelemetry(tel: TelMsg): void
  telemetryTable(tel: TelMsg | null): TelemetryTable

  getSandboxApi(): SandboxFnDef[]
  getSandboxSensors(): SensorSnapshot
  applySandboxCommands(cmds: SandboxCommand[]): void
  /** Called when leaving CODE: hand control back to the sim. */
  releaseSandbox(): void
}

export interface RobotEntry {
  kind: RobotKind
  label: string
  create: () => RobotModule
}
