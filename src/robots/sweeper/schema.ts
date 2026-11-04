import type { ControlDef, InstrumentLayout, WorldConfig } from '../../core/types'
import { ARENA_DEFAULT, ARENA_MAX, ARENA_MIN, MAX_WHEEL_SPEED } from './constants'
import { DEFAULT_PARAMS } from './sim'

/** Swept width range: the side-brush tips reach at most a few cm past the 0.25 m body. */
export const BRUSH_MIN = 0.12
export const BRUSH_MAX = 0.34

/*
 * SWEEPER control schema, instrument layout and world config. The schema keeps a fixed
 * shape (the module never needs a revision bump), and follows the shell conventions:
 * 'dir' is a grid3 select with row-major 'fl'..'br', 'turn' is 'ccw' | 'none' | 'cw'.
 */

export const MODE_OPTIONS = [
  { value: 'coverage', label: 'COVERAGE' },
  { value: 'goto', label: 'GOTO' },
  { value: 'teleop', label: 'TELEOP' },
  { value: 'wander', label: 'WANDER' },
]

const DIR_OPTIONS = [
  { value: 'fl', label: 'FWD LEFT', icon: '↖' },
  { value: 'f', label: 'FORWARD', icon: '↑' },
  { value: 'fr', label: 'FWD RIGHT', icon: '↗' },
  { value: 'l', label: 'LEFT', icon: '←' },
  { value: 'stop', label: 'STOP', icon: '■' },
  { value: 'r', label: 'RIGHT', icon: '→' },
  { value: 'bl', label: 'BACK LEFT', icon: '↙' },
  { value: 'b', label: 'BACK', icon: '↓' },
  { value: 'br', label: 'BACK RIGHT', icon: '↘' },
]

const TURN_OPTIONS = [
  { value: 'ccw', label: 'CCW', icon: '↺' },
  { value: 'none', label: 'NONE', icon: '·' },
  { value: 'cw', label: 'CW', icon: '↻' },
]

const SIM = 'SIMULATION'
const LOCO = 'LOCOMOTION'
const PARAMS = 'PARAMETERS'
const ARENA = 'ARENA'

export const SCHEMA: ControlDef[] = [
  { type: 'select', key: 'mode', label: 'MODE', group: SIM, options: MODE_OPTIONS, value: 'coverage', display: 'segmented', hint: 'GOTO: click or drag on the floor to place the goal (orbit by dragging outside the room). Drive keys switch to TELEOP.' },
  { type: 'slider', key: 'arena', label: 'ARENA SIZE', group: SIM, min: ARENA_MIN, max: ARENA_MAX, step: 0.5, value: ARENA_DEFAULT, unit: 'm', digits: 1 },
  { type: 'slider', key: 'noise', label: 'LIDAR NOISE', group: SIM, min: 0, max: 3, step: 0.1, value: DEFAULT_PARAMS.noise, unit: '×', digits: 1, hint: '1× = LD06 spec: max(10 mm, 1 % of range)' },
  { type: 'toggle', key: 'safety', label: 'SAFETY LAYER', group: SIM, value: DEFAULT_PARAMS.safety, hint: 'Slow down / stop from the LiDAR range in the direction of motion' },
  { type: 'toggle', key: 'slip', label: 'WHEEL SLIP', group: SIM, value: DEFAULT_PARAMS.slip, hint: 'Per-wheel traction noise (4 %). The robot then navigates and maps on wheel odometry, which drifts like the real one (ODOM DRIFT)' },
  { type: 'toggle', key: 'showMap', label: 'MAP', group: SIM, value: true },
  { type: 'toggle', key: 'showCoverage', label: 'COVERAGE', group: SIM, value: true },
  { type: 'toggle', key: 'showRays', label: 'LIDAR RAYS', group: SIM, value: true },
  { type: 'toggle', key: 'showPlan', label: 'PATH + LANES', group: SIM, value: true },
  { type: 'button', key: 'resetMap', label: 'RESET MAP', group: SIM },

  { type: 'select', key: 'dir', label: 'DIRECTION', group: LOCO, options: DIR_OPTIONS, value: 'stop', display: 'grid3' },
  { type: 'select', key: 'turn', label: 'TURN', group: LOCO, options: TURN_OPTIONS, value: 'none', display: 'segmented' },
  { type: 'slider', key: 'speed', label: 'SPEED', group: LOCO, min: 0.05, max: 0.6, step: 0.01, value: DEFAULT_PARAMS.teleopSpeed, unit: 'm/s', digits: 2 },

  { type: 'slider', key: 'maxSpeed', label: 'MAX SPEED', group: PARAMS, min: 0.1, max: 0.6, step: 0.01, value: DEFAULT_PARAMS.maxSpeed, unit: 'm/s', digits: 2 },
  { type: 'slider', key: 'lookahead', label: 'LOOKAHEAD', group: PARAMS, min: 0.1, max: 1, step: 0.05, value: DEFAULT_PARAMS.lookahead, unit: 'm', digits: 2 },
  { type: 'slider', key: 'inflation', label: 'INFLATION', group: PARAMS, min: 0, max: 0.25, step: 0.01, value: DEFAULT_PARAMS.inflation, unit: 'm', digits: 2, hint: 'Margin beyond the 0.195 m footprint radius' },
  { type: 'slider', key: 'brush', label: 'BRUSH WIDTH', group: PARAMS, min: BRUSH_MIN, max: BRUSH_MAX, step: 0.01, value: DEFAULT_PARAMS.brushWidth, unit: 'm', digits: 2, hint: 'Swept width (roller + side brushes); also the boustrophedon lane spacing, less 8 % overlap' },

  { type: 'button', key: 'addBox', label: 'ADD BOX', group: ARENA, hint: 'Drag an obstacle to move it, Alt+drag rotates a box. Shift+click the floor sets a GOTO goal.' },
  { type: 'button', key: 'addCyl', label: 'ADD CYLINDER', group: ARENA },
  { type: 'button', key: 'removeSel', label: 'REMOVE SELECTED', group: ARENA, tone: 'danger', hint: 'Click an obstacle to select it' },
  { type: 'button', key: 'randomize', label: 'RANDOMIZE', group: ARENA, hint: 'New random room; the map and coverage start over' },
  { type: 'button', key: 'clear', label: 'CLEAR', group: ARENA, tone: 'danger', hint: 'Remove every obstacle; the map and coverage start over' },
]

/** Schema with REMOVE SELECTED enabled only while an obstacle is selected. */
const SCHEMA_NO_SELECTION: ControlDef[] = SCHEMA.map((d) => (d.key === 'removeSel' ? { ...d, disabled: true } : d))

export function schemaFor(hasSelection: boolean): ControlDef[] {
  return hasSelection ? SCHEMA : SCHEMA_NO_SELECTION
}

const L = ['#FF5A1F', '#0C8F9B', '#6C4CF0', '#1F9D57']

export const LAYOUT: InstrumentLayout = {
  title: 'NAVIGATION',
  subtitle: 'MECANUM · LD06',
  gauges: [
    { key: 'coverage', label: 'COVERAGE %', color: '#FF5A1F', min: 0, max: 100, unit: '%' },
    { key: 'clearance', label: 'CLEARANCE CM', color: '#0C8F9B', min: 0, max: 200, unit: 'cm' },
  ],
  charts: [
    {
      key: 'wheels',
      title: 'WHEEL SPEED',
      unit: 'rad/s',
      min: -MAX_WHEEL_SPEED,
      max: MAX_WHEEL_SPEED,
      windowSec: 6,
      channels: [
        { key: 'wFL', label: 'FL', color: L[0] },
        { key: 'wFR', label: 'FR', color: L[1] },
        { key: 'wRL', label: 'RL', color: L[2] },
        { key: 'wRR', label: 'RR', color: L[3] },
      ],
    },
    {
      key: 'range',
      title: 'RANGE',
      unit: 'm',
      min: 0,
      max: 4,
      windowSec: 6,
      channels: [
        { key: 'minRange', label: 'MIN', color: '#E8A200' },
        { key: 'frontRange', label: 'FRONT', color: '#2D7DD2' },
      ],
    },
  ],
  bars: { title: 'WHEELS', unit: '|rad/s|', labels: ['FL', 'FR', 'RL', 'RR'], max: MAX_WHEEL_SPEED, colors: L },
  readouts: [
    { key: 'x', label: 'POSE X', unit: 'm', digits: 2 },
    { key: 'y', label: 'POSE Y', unit: 'm', digits: 2 },
    { key: 'hdg', label: 'HEADING', unit: 'deg', digits: 1 },
    { key: 'speed', label: 'SPEED', unit: 'm/s', digits: 2 },
    { key: 'drift', label: 'ODOM DRIFT', unit: 'm', digits: 3 },
    { key: 'path', label: 'PATH LENGTH', unit: 'm', digits: 2 },
    { key: 'replans', label: 'REPLANS', digits: 0 },
    { key: 'bumps', label: 'BUMPS', digits: 0 },
    { key: 'known', label: 'MAP KNOWN', unit: '%', digits: 0 },
    { key: 'status', label: 'STATUS' },
  ],
}

/*
 * World config scaled to the room: camera presets frame the whole arena, and the shadow
 * area covers it. Cached per size so the shell sees a stable object until the size changes.
 */
const worlds = new Map<number, WorldConfig>()

export function worldFor(size: number): WorldConfig {
  const hit = worlds.get(size)
  if (hit) return hit
  const k = size / ARENA_DEFAULT
  const w: WorldConfig = {
    gridCellSize: 0.25,
    gridSectionSize: 1,
    gridFadeDistance: 34 * k,
    shadowScale: 2 * size,
    minDistance: 0.4,
    maxDistance: 26 * k,
    cameraPresets: [
      { id: 'iso', label: 'ISO', position: [4.7 * k, 5.2 * k, 5.7 * k], target: [0, 0, 0] },
      { id: 'front', label: 'FRONT', position: [0, 3.4 * k, 7.8 * k], target: [0, 0.1, 0] },
      { id: 'side', label: 'SIDE', position: [7.8 * k, 3.4 * k, 0], target: [0, 0.1, 0] },
      { id: 'top', label: 'TOP', position: [0, 10.8 * k, 0.001], target: [0, 0, 0] },
    ],
  }
  worlds.set(size, w)
  return w
}
