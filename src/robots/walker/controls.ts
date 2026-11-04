import type { ControlDef, ControlValue, SelectOption } from '../../core/types'
import { DIM_RANGES, DEFAULT_DIMS, type LegCount } from './geometry'
import { MAX_DUTY, type GaitDef } from './gaits'
import { ACTUATOR_LABELS, ACTUATOR_PRESETS, type ActuatorParams, type ActuatorPresetId } from './actuator'

/* ============================================================
   CONTROL SCHEMA — groups in rail order. Shared conventions:
   'dir' is a grid3 select (row-major ↖ ↑ ↗ ← ■ → ↙ ↓ ↘) and 'turn'
   is ccw / none / cw, so the shell can bind the keyboard.
   Sliders show UI units (degrees, ms); the module converts.
   ============================================================ */

export const KEY = {
  legs: 'legs',
  physics: 'physics',
  actuator: 'actuator',
  gait: 'gait',
  dir: 'dir',
  turn: 'turn',
  speed: 'speed',
  treadmill: 'treadmill',
  gaitHz: 'gaitHz',
  stride: 'stride',
  stepHeight: 'stepHeight',
  duty: 'duty',
  height: 'height',
  roll: 'roll',
  pitch: 'pitch',
  yaw: 'yaw',
  shiftX: 'shiftX',
  shiftY: 'shiftY',
  coxa: 'coxa',
  femur: 'femur',
  tibia: 'tibia',
  bodyRadius: 'bodyRadius',
  actTau: 'actTau',
  actSpeed: 'actSpeed',
  actStall: 'actStall',
  actDeadband: 'actDeadband',
  actBacklash: 'actBacklash',
  resetPose: 'resetPose',
  respawn: 'respawn',
} as const

export type PhysicsMode = 'kinematic' | 'dynamic'

export const DIR_OPTIONS: SelectOption[] = [
  { value: 'fl', label: 'FWD-LEFT', icon: '↖' },
  { value: 'f', label: 'FORWARD', icon: '↑' },
  { value: 'fr', label: 'FWD-RIGHT', icon: '↗' },
  { value: 'l', label: 'LEFT', icon: '←' },
  { value: 'stop', label: 'STOP', icon: '■' },
  { value: 'r', label: 'RIGHT', icon: '→' },
  { value: 'bl', label: 'BACK-LEFT', icon: '↙' },
  { value: 'b', label: 'BACK', icon: '↓' },
  { value: 'br', label: 'BACK-RIGHT', icon: '↘' },
]

/** Unit direction in the body frame (x forward, y left) for each pad value. */
const DIR_VECTORS: Record<string, readonly [number, number]> = {
  fl: [Math.SQRT1_2, Math.SQRT1_2],
  f: [1, 0],
  fr: [Math.SQRT1_2, -Math.SQRT1_2],
  l: [0, 1],
  stop: [0, 0],
  r: [0, -1],
  bl: [-Math.SQRT1_2, Math.SQRT1_2],
  b: [-1, 0],
  br: [-Math.SQRT1_2, -Math.SQRT1_2],
}

export function dirVector(dir: string): readonly [number, number] {
  return DIR_VECTORS[dir] ?? DIR_VECTORS.stop
}

/** +1 = CCW (left turn), −1 = CW. */
export function turnSign(turn: string): number {
  return turn === 'ccw' ? 1 : turn === 'cw' ? -1 : 0
}

/** Actuator sliders in UI units. */
export interface ActuatorUi {
  tauMs: number
  speedDeg: number
  stallNm: number
  deadbandDeg: number
  backlashDeg: number
}

export const ACT_RANGES: Readonly<Record<keyof ActuatorUi, readonly [number, number]>> = {
  tauMs: [0, 150],
  speedDeg: [60, 1000],
  stallNm: [0.05, 3],
  deadbandDeg: [0, 3],
  backlashDeg: [0, 4],
}

const DEG = Math.PI / 180

/** Preset → slider values (IDEAL shows the slider maxima: unlimited). */
export function actuatorToUi(p: ActuatorParams): ActuatorUi {
  return {
    tauMs: p.tau * 1000,
    speedDeg: Number.isFinite(p.speed) ? p.speed / DEG : ACT_RANGES.speedDeg[1],
    stallNm: Number.isFinite(p.stall) ? p.stall : ACT_RANGES.stallNm[1],
    deadbandDeg: p.deadband / DEG,
    backlashDeg: p.backlash / DEG,
  }
}

/** Slider values → model parameters; electrical constants come from MG996R-class servos. */
export function uiToActuator(u: ActuatorUi): ActuatorParams {
  const ref = ACTUATOR_PRESETS.mg996r
  return {
    tau: u.tauMs / 1000,
    speed: u.speedDeg * DEG,
    stall: u.stallNm,
    deadband: u.deadbandDeg * DEG,
    backlash: u.backlashDeg * DEG,
    // keep the stall current of the reference servo: Kt scales with stall torque
    kt: u.stallNm / (ref.stall / ref.kt),
    idle: ref.idle,
    volts: ref.volts,
  }
}

export interface SchemaContext {
  gaits: GaitDef[]
  minDuty: number
  physics: PhysicsMode
  /** Reachable body-height range for the current dimensions, meters. */
  heightRange: readonly [number, number]
  /** Default standing height for the current dimensions, meters. */
  standHeight: number
}

/** Body pose slider limits, degrees (roll, pitch, yaw) and meters (shift). */
export const POSE_LIMITS = { roll: 15, pitch: 15, yaw: 20, shift: 0.04 } as const

const PRESET_ORDER: ActuatorPresetId[] = ['ideal', 'sg90', 'mg996r', 'ds3218', 'custom']

function simulation(): ControlDef[] {
  return [
    {
      type: 'select', key: KEY.legs, label: 'LEGS', group: 'SIMULATION', display: 'segmented', value: '6',
      options: [{ value: '4', label: '4' }, { value: '6', label: '6' }, { value: '8', label: '8' }],
    },
    {
      type: 'select', key: KEY.physics, label: 'PHYSICS', group: 'SIMULATION', display: 'segmented', value: 'kinematic',
      options: [{ value: 'kinematic', label: 'KINEMATIC' }, { value: 'dynamic', label: 'DYNAMIC' }],
      hint: 'DYNAMIC runs a Rapier rigid-body model: it can slip and tip over.',
    },
    {
      type: 'select', key: KEY.actuator, label: 'ACTUATOR', group: 'SIMULATION', display: 'dropdown', value: 'ideal',
      options: PRESET_ORDER.map((p) => ({ value: p, label: ACTUATOR_LABELS[p] })),
    },
  ]
}

function locomotion(ctx: SchemaContext): ControlDef[] {
  return [
    {
      type: 'select', key: KEY.gait, label: 'GAIT', group: 'GAIT PATTERN', display: 'segmented', value: ctx.gaits[0].id,
      options: ctx.gaits.map((g) => ({ value: g.id, label: g.label })),
    },
    { type: 'select', key: KEY.dir, label: 'DIRECTION', group: 'LOCOMOTION', display: 'grid3', value: 'stop', options: DIR_OPTIONS },
    {
      type: 'select', key: KEY.turn, label: 'TURN', group: 'LOCOMOTION', display: 'segmented', value: 'none',
      options: [{ value: 'ccw', label: 'CCW', icon: '⟲' }, { value: 'none', label: 'NONE', icon: '·' }, { value: 'cw', label: 'CW', icon: '⟳' }],
    },
    { type: 'slider', key: KEY.speed, label: 'SPEED', group: 'LOCOMOTION', min: 0, max: 100, step: 1, value: 60, unit: '%', digits: 0 },
    {
      type: 'toggle', key: KEY.treadmill, label: 'TREADMILL', group: 'LOCOMOTION', value: false,
      disabled: ctx.physics === 'dynamic', hint: 'Keeps the body centred; the ground moves instead.',
    },
    {
      type: 'slider', key: KEY.gaitHz, label: 'GAIT SPEED', group: 'PARAMETERS', min: 0.3, max: 3, step: 0.05, value: 1.2, unit: 'Hz', digits: 2,
      hint: 'Gait cycles per second. Picking a gait resets it to the default for that gait (the crawl runs slower).',
    },
    { type: 'slider', key: KEY.stride, label: 'STRIDE', group: 'PARAMETERS', min: 0.02, max: 0.1, step: 0.002, value: 0.06, unit: 'm', digits: 3 },
    { type: 'slider', key: KEY.stepHeight, label: 'STEP HEIGHT', group: 'PARAMETERS', min: 0.01, max: 0.06, step: 0.001, value: 0.035, unit: 'm', digits: 3 },
    {
      type: 'slider', key: KEY.duty, label: 'DUTY FACTOR', group: 'PARAMETERS', min: ctx.minDuty, max: MAX_DUTY, step: 0.01,
      value: ctx.gaits[0].duty, digits: 2, hint: 'Fraction of the cycle each foot is on the ground.',
    },
  ]
}

function bodyPose(ctx: SchemaContext): ControlDef[] {
  const g = 'BODY POSE'
  const L = POSE_LIMITS
  const [lo, hi] = ctx.heightRange
  return [
    {
      type: 'slider', key: KEY.height, label: 'HEIGHT', group: g, min: lo, max: hi, step: 0.001, value: ctx.standHeight, unit: 'm', digits: 3,
      hint: 'Coxa mount plane above the ground. The range follows the leg dimensions.',
    },
    { type: 'slider', key: KEY.roll, label: 'ROLL', group: g, min: -L.roll, max: L.roll, step: 0.5, value: 0, unit: '°', digits: 1 },
    { type: 'slider', key: KEY.pitch, label: 'PITCH', group: g, min: -L.pitch, max: L.pitch, step: 0.5, value: 0, unit: '°', digits: 1 },
    { type: 'slider', key: KEY.yaw, label: 'YAW', group: g, min: -L.yaw, max: L.yaw, step: 0.5, value: 0, unit: '°', digits: 1 },
    { type: 'slider', key: KEY.shiftX, label: 'SHIFT X', group: g, min: -L.shift, max: L.shift, step: 0.001, value: 0, unit: 'm', digits: 3 },
    { type: 'slider', key: KEY.shiftY, label: 'SHIFT Y', group: g, min: -L.shift, max: L.shift, step: 0.001, value: 0, unit: 'm', digits: 3 },
  ]
}

function dimensions(): ControlDef[] {
  const g = 'DIMENSIONS'
  const s = (key: keyof typeof DIM_RANGES, label: string): ControlDef => ({
    type: 'slider', key, label, group: g, min: DIM_RANGES[key][0], max: DIM_RANGES[key][1], step: 0.001,
    value: DEFAULT_DIMS[key], unit: 'm', digits: 3,
  })
  return [s('coxa', 'COXA'), s('femur', 'FEMUR'), s('tibia', 'TIBIA'), s('bodyRadius', 'BODY RADIUS')]
}

function actuator(): ControlDef[] {
  const g = 'ACTUATOR'
  const ideal = actuatorToUi(ACTUATOR_PRESETS.ideal)
  const hint = 'Editing switches the preset to CUSTOM.'
  return [
    { type: 'slider', key: KEY.actTau, label: 'TIME CONSTANT', group: g, min: ACT_RANGES.tauMs[0], max: ACT_RANGES.tauMs[1], step: 1, value: ideal.tauMs, unit: 'ms', digits: 0, hint },
    { type: 'slider', key: KEY.actSpeed, label: 'SPEED LIMIT', group: g, min: ACT_RANGES.speedDeg[0], max: ACT_RANGES.speedDeg[1], step: 5, value: ideal.speedDeg, unit: '°/s', digits: 0, hint },
    { type: 'slider', key: KEY.actStall, label: 'STALL TORQUE', group: g, min: ACT_RANGES.stallNm[0], max: ACT_RANGES.stallNm[1], step: 0.01, value: ideal.stallNm, unit: 'Nm', digits: 2, hint },
    { type: 'slider', key: KEY.actDeadband, label: 'DEADBAND', group: g, min: ACT_RANGES.deadbandDeg[0], max: ACT_RANGES.deadbandDeg[1], step: 0.1, value: ideal.deadbandDeg, unit: '°', digits: 1, hint },
    { type: 'slider', key: KEY.actBacklash, label: 'BACKLASH', group: g, min: ACT_RANGES.backlashDeg[0], max: ACT_RANGES.backlashDeg[1], step: 0.1, value: ideal.backlashDeg, unit: '°', digits: 1, hint },
  ]
}

function actions(): ControlDef[] {
  return [
    { type: 'button', key: KEY.resetPose, label: 'RESET POSE', group: 'ACTIONS' },
    { type: 'button', key: KEY.respawn, label: 'RESPAWN', group: 'ACTIONS', tone: 'accent', hint: 'Back to the origin, standing. Re-spawns the physics body.' },
  ]
}

export function buildSchema(ctx: SchemaContext): ControlDef[] {
  return [...simulation(), ...locomotion(ctx), ...bodyPose(ctx), ...dimensions(), ...actuator(), ...actions()]
}

/** Coerce a control write to a valid value for its definition, or null to reject it. */
export function sanitizeControl(def: ControlDef, value: ControlValue): ControlValue | null {
  switch (def.type) {
    case 'slider': {
      const v = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
      return Number.isFinite(v) ? Math.min(Math.max(v, def.min), def.max) : null
    }
    case 'select':
      return typeof value === 'string' && def.options.some((o) => o.value === value) ? value : null
    case 'toggle':
      return typeof value === 'boolean' ? value : null
    case 'button':
      return true
  }
}

/** Range lookup for a slider key (used to clamp sandbox / config writes). */
export function sliderRange(schema: ControlDef[], key: string): [number, number] | null {
  const d = schema.find((x) => x.key === key)
  return d && d.type === 'slider' ? [d.min, d.max] : null
}

export function legCountFrom(v: string): LegCount {
  return v === '4' ? 4 : v === '8' ? 8 : 6
}

export function presetFrom(v: string): ActuatorPresetId {
  return PRESET_ORDER.find((p) => p === v) ?? 'ideal'
}

/** Actuator slider key → the UI field it edits. */
export const ACT_FIELDS: Readonly<Record<string, keyof ActuatorUi>> = {
  [KEY.actTau]: 'tauMs',
  [KEY.actSpeed]: 'speedDeg',
  [KEY.actStall]: 'stallNm',
  [KEY.actDeadband]: 'deadbandDeg',
  [KEY.actBacklash]: 'backlashDeg',
}

/** Dimension slider keys (they match the WalkerDims fields). */
export const DIM_KEYS = ['coxa', 'femur', 'tibia', 'bodyRadius'] as const

/** Gait parameter and body pose keys: a change only updates parameters, no rebuild. */
export const PARAM_KEYS: readonly string[] = [KEY.gaitHz, KEY.stride, KEY.stepHeight, KEY.duty, KEY.treadmill]
export const POSE_KEYS: readonly string[] = [KEY.height, KEY.roll, KEY.pitch, KEY.yaw, KEY.shiftX, KEY.shiftY]
