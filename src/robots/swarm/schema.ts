import type { ControlDef, ControlValue, InstrumentLayout, ReadoutDef } from '../../core/types'
import { DEFAULT_GAINS } from './sim/controller'
import type { Gains } from './sim/controller'
import { isFormationShape } from './sim/formation'
import { isRouteMode } from './sim/route'
import { MAX_DRONES, MIN_DRONES, PHYSICS_RATES } from './sim/swarmSim'
import type { SwarmSettings } from './sim/swarmSim'
import { DRONE_COLORS } from './scene/kit'

/*
 * Control schema and instrument layout for the swarm. The schema is static; the
 * current values live in the module's value map and are pushed into SwarmSettings
 * by applyValues().
 */

/** Gain control keys, in display order, mapped to the controller's fields. */
export const GAIN_KEYS: readonly (keyof Gains)[] = ['posP', 'posD', 'velP', 'velI', 'attP', 'rateP', 'rateI', 'rateD']

const GAIN_DEFS: Record<keyof Gains, { label: string; max: number; step: number; unit: string; digits: number }> = {
  posP: { label: 'POSITION P', max: 4, step: 0.05, unit: '1/s', digits: 2 },
  posD: { label: 'POSITION D', max: 1, step: 0.01, unit: '', digits: 2 },
  velP: { label: 'VELOCITY P', max: 8, step: 0.1, unit: '1/s', digits: 1 },
  velI: { label: 'VELOCITY I', max: 4, step: 0.05, unit: '1/s²', digits: 2 },
  attP: { label: 'ATTITUDE P', max: 20, step: 0.25, unit: '1/s', digits: 2 },
  rateP: { label: 'RATE P', max: 60, step: 0.5, unit: '1/s', digits: 1 },
  rateI: { label: 'RATE I', max: 120, step: 1, unit: '1/s²', digits: 0 },
  rateD: { label: 'RATE D', max: 1, step: 0.01, unit: '', digits: 2 },
}

function gainControls(): ControlDef[] {
  const defs: ControlDef[] = GAIN_KEYS.map((k) => ({
    type: 'slider',
    key: k,
    label: GAIN_DEFS[k].label,
    group: 'GAINS',
    min: 0,
    max: GAIN_DEFS[k].max,
    step: GAIN_DEFS[k].step,
    value: DEFAULT_GAINS[k],
    unit: GAIN_DEFS[k].unit || undefined,
    digits: GAIN_DEFS[k].digits,
  }))
  defs.push({ type: 'button', key: 'resetGains', label: 'DEFAULT GAINS', group: 'GAINS', hint: 'Restore the tuned cascade gains' })
  return defs
}

const MISSION: ControlDef[] = [
  { type: 'button', key: 'takeoff', label: 'TAKEOFF', group: 'MISSION', tone: 'accent', hint: 'Arm and climb to the cruise altitude' },
  { type: 'button', key: 'land', label: 'LAND', group: 'MISSION', hint: 'Descend in place and disarm' },
  { type: 'button', key: 'clearWp', label: 'CLEAR WAYPOINTS', group: 'MISSION', hint: 'Click the ground to drop a waypoint, drag a marker to move it, shift-click a marker to remove it' },
  { type: 'button', key: 'defaultRoute', label: 'SQUARE ROUTE', group: 'MISSION', hint: 'Replace the route with the default 12 m square' },
  { type: 'button', key: 'reset', label: 'RESET', group: 'MISSION', tone: 'danger', hint: 'Back on the pads, full batteries' },
]

const SIMULATION: ControlDef[] = [
  {
    type: 'select', key: 'drones', label: 'DRONES', group: 'SIMULATION', display: 'segmented', value: '4',
    options: ['3', '4', '5', '6'].map((v) => ({ value: v, label: v })),
    hint: 'Rebuilds the fleet on its landing pads',
  },
  {
    type: 'select', key: 'rate', label: 'PHYSICS RATE', group: 'SIMULATION', display: 'segmented', value: '1000',
    options: PHYSICS_RATES.map((r) => ({ value: String(r), label: r >= 1000 ? `${r / 1000}K` : String(r) })),
    hint: 'Rigid-body + inner-loop rate, Hz',
  },
  {
    type: 'select', key: 'integrator', label: 'INTEGRATOR', group: 'SIMULATION', display: 'segmented', value: 'rk4',
    options: [{ value: 'rk4', label: 'RK4' }, { value: 'euler', label: 'SEMI-IMPLICIT' }],
  },
  { type: 'toggle', key: 'avoid', label: 'ORCA AVOIDANCE', group: 'SIMULATION', value: true },
  { type: 'toggle', key: 'wind', label: 'WIND', group: 'SIMULATION', value: true },
  { type: 'slider', key: 'windSpeed', label: 'WIND SPEED', group: 'SIMULATION', min: 0, max: 10, step: 0.1, value: 2, unit: 'm/s', digits: 1 },
  { type: 'slider', key: 'windDir', label: 'WIND DIR', group: 'SIMULATION', min: 0, max: 355, step: 5, value: 45, unit: '°', digits: 0, hint: 'Direction it blows toward, CCW from +X' },
  { type: 'slider', key: 'gust', label: 'GUSTS σ', group: 'SIMULATION', min: 0, max: 4, step: 0.05, value: 0.5, unit: 'm/s', digits: 2 },
]

const FORMATION: ControlDef[] = [
  {
    type: 'select', key: 'shape', label: 'SHAPE', group: 'FORMATION', display: 'segmented', value: 'wedge',
    options: [
      { value: 'line', label: 'LINE' },
      { value: 'wedge', label: 'WEDGE' },
      { value: 'triangle', label: 'TRI' },
      { value: 'circle', label: 'CIRCLE' },
      { value: 'column', label: 'COLUMN' },
    ],
  },
  { type: 'slider', key: 'spacing', label: 'SPACING', group: 'FORMATION', min: 1, max: 4, step: 0.1, value: 2, unit: 'm', digits: 1 },
  { type: 'slider', key: 'cruiseAlt', label: 'CRUISE ALT', group: 'FORMATION', min: 1, max: 8, step: 0.1, value: 3, unit: 'm', digits: 1 },
  { type: 'slider', key: 'cruiseSpeed', label: 'CRUISE SPEED', group: 'FORMATION', min: 0.5, max: 6, step: 0.1, value: 2, unit: 'm/s', digits: 1 },
  {
    type: 'select', key: 'routeMode', label: 'ROUTE', group: 'FORMATION', display: 'segmented', value: 'loop',
    options: [{ value: 'loop', label: 'LOOP' }, { value: 'pingpong', label: 'PING-PONG' }, { value: 'once', label: 'ONCE' }],
  },
]

const DISPLAY: ControlDef[] = [
  { type: 'toggle', key: 'trails', label: 'FLIGHT TRAILS', group: 'DISPLAY', value: true },
  { type: 'toggle', key: 'slots', label: 'FORMATION SLOTS', group: 'DISPLAY', value: true },
  {
    type: 'slider', key: 'vscale', label: 'DRONE SCALE', group: 'DISPLAY', min: 1, max: 4, step: 0.1, value: 2.5, unit: '×', digits: 1,
    hint: 'Visual size only; physics uses the real 250-class airframe',
  },
]

export const SCHEMA: readonly ControlDef[] = [...MISSION, ...SIMULATION, ...FORMATION, ...gainControls(), ...DISPLAY]

const WIND_DETAIL = new Set(['windSpeed', 'windDir', 'gust'])

/** The live schema: SCHEMA with state-dependent flags (wind detail greyed out while the wind is off). */
export function schemaFor(v: Record<string, ControlValue>): ControlDef[] {
  const windOff = v.wind === false
  return SCHEMA.map((d): ControlDef => (WIND_DETAIL.has(d.key) ? { ...d, disabled: windOff } : d))
}

/** Validate a value for a control: sliders clamp, selects must name an option. null = reject. */
export function sanitizeControl(def: ControlDef, v: ControlValue): ControlValue | null {
  switch (def.type) {
    case 'slider':
      return typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, def.min), def.max) : null
    case 'select':
      return typeof v === 'string' && def.options.some((o) => o.value === v) ? v : null
    case 'toggle':
      return typeof v === 'boolean' ? v : null
    default:
      return v
  }
}

/** Push control values into the sim settings (validated; bad values are ignored). */
export function applyValues(v: Record<string, ControlValue>, st: SwarmSettings): void {
  const num = (k: string, lo: number, hi: number): number | null => {
    const x = v[k]
    return typeof x === 'number' && Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : null
  }
  const rate = Number(v.rate)
  if (PHYSICS_RATES.includes(rate)) st.physicsHz = rate
  if (v.integrator === 'rk4' || v.integrator === 'euler') st.integrator = v.integrator
  if (isFormationShape(v.shape)) st.shape = v.shape
  if (isRouteMode(v.routeMode)) st.routeMode = v.routeMode
  if (typeof v.avoid === 'boolean') st.avoid = v.avoid
  if (typeof v.wind === 'boolean') st.wind.enabled = v.wind
  st.spacing = num('spacing', 1, 4) ?? st.spacing
  st.cruiseAlt = num('cruiseAlt', 1, 8) ?? st.cruiseAlt
  st.cruiseSpeed = num('cruiseSpeed', 0.5, 6) ?? st.cruiseSpeed
  st.wind.speed = num('windSpeed', 0, 10) ?? st.wind.speed
  st.wind.dirDeg = num('windDir', 0, 360) ?? st.wind.dirDeg
  st.wind.gust = num('gust', 0, 4) ?? st.wind.gust
  for (const k of GAIN_KEYS) st.gains[k] = num(k, 0, GAIN_DEFS[k].max) ?? st.gains[k]
}

export function droneCountFrom(v: ControlValue | undefined): number {
  const n = Number(v)
  return Number.isInteger(n) && n >= MIN_DRONES && n <= MAX_DRONES ? n : 4
}

const READOUTS: ReadoutDef[] = [
  { key: 'phase', label: 'PHASE' },
  { key: 'status', label: 'STATUS' },
  { key: 'shape', label: 'FORMATION' },
  { key: 'wp', label: 'WAYPOINT' },
  { key: 'minSep', label: 'MIN SEPARATION', unit: 'm', digits: 2 },
  { key: 'leaderSpeed', label: 'LEADER SPEED', unit: 'm/s', digits: 2 },
  { key: 'wind', label: 'WIND', unit: 'm/s', digits: 1 },
  { key: 'flight', label: 'FLIGHT TIME' },
  { key: 'airborne', label: 'AIRBORNE' },
  { key: 'loopHz', label: 'CTRL LOOP', unit: 'Hz', digits: 0 },
  { key: 'cost', label: 'STEP COST', unit: 'ms', digits: 2 },
]

export function buildLayout(n: number): InstrumentLayout {
  const ids = Array.from({ length: n }, (_, i) => i)
  return {
    title: 'SWARM',
    subtitle: `${n} × QUAD · X-FRAME`,
    gauges: [
      { key: 'formation', label: 'Formation', color: 'var(--accent)', min: 0, max: 100, unit: '%' },
      { key: 'battery', label: 'Battery', color: 'var(--sim)', min: 0, max: 100, unit: '%' },
    ],
    charts: [
      { key: 'alt', title: 'ALTITUDE', unit: 'm', min: 0, max: 10, windowSec: 12, channels: ids.map((i) => ({ key: `alt${i + 1}`, label: `D${i + 1}`, color: DRONE_COLORS[i] })) },
      { key: 'err', title: 'TRACKING ERROR', unit: 'm', min: 0, max: 2, windowSec: 12, channels: ids.map((i) => ({ key: `err${i + 1}`, label: `D${i + 1}`, color: DRONE_COLORS[i] })) },
      {
        // fixed range: wider than the 35° tilt limit so saturation shows instead of clipping
        key: 'att', title: 'ATTITUDE · LEADER', unit: 'deg', min: -40, max: 40,
        channels: [{ key: 'roll', label: 'roll', color: '#FF5A1F' }, { key: 'pitch', label: 'pitch', color: '#0C8F9B' }],
      },
    ],
    bars: { title: 'THRUST', unit: 'norm', labels: ids.map((i) => `D${i + 1}`), max: 1, colors: ids.map((i) => DRONE_COLORS[i]) },
    readouts: READOUTS,
  }
}
