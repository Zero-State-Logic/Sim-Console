import type { DroneMode } from './drone'
import { Q, STATE_LEN } from './dynamics'
import { clamp, wrapPi } from './frames'
import { quatNormalizeAt } from './quat'
import { MAX_DRONES, MIN_DRONES } from './swarmSim'
import type { Phase, SwarmSim } from './swarmSim'

/*
 * Record/replay state: per-drone rigid-body state, rotor speeds, charge and mode,
 * plus the mission bits needed to resume. Plain arrays only (structured-clonable,
 * JSON-safe). Restoring validates everything because recordings can be imported
 * from files.
 */

export interface SwarmSnapshot {
  v: 1
  n: number
  t: number
  flight: number
  phase: Phase
  heading: number
  /** target, dir, done(0/1), x, y, vx, vy */
  route: number[]
  /** n × 13: position, velocity, quaternion, body rates. */
  s: number[]
  /** n × 4 rotor speeds, rad/s. */
  w: number[]
  soc: number[]
  modes: DroneMode[]
}

const PHASES: readonly Phase[] = ['idle', 'takeoff', 'mission', 'landing']
const MODES: readonly DroneMode[] = ['landed', 'flying', 'landing', 'crashed']

export function takeSnapshot(sim: SwarmSim): SwarmSnapshot {
  const n = sim.count
  const s: number[] = new Array(n * STATE_LEN)
  const w: number[] = new Array(n * 4)
  const soc: number[] = new Array(n)
  const modes: DroneMode[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const d = sim.drones[i]
    for (let k = 0; k < STATE_LEN; k++) s[i * STATE_LEN + k] = d.s[k]
    for (let k = 0; k < 4; k++) w[i * 4 + k] = d.omega[k]
    soc[i] = d.battery.soc
    modes[i] = d.mode
  }
  const r = sim.route
  return {
    v: 1,
    n,
    t: sim.t,
    flight: sim.flightTime,
    phase: sim.phase,
    heading: sim.heading,
    route: [r.target, r.dir, r.done ? 1 : 0, r.x, r.y, r.vx, r.vy],
    s,
    w,
    soc,
    modes,
  }
}

function finiteArray(v: unknown, len: number): v is number[] {
  return Array.isArray(v) && v.length === len && v.every((x) => typeof x === 'number' && Number.isFinite(x))
}

/** Type guard for an untrusted snapshot. */
export function isSwarmSnapshot(v: unknown): v is SwarmSnapshot {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  const n = o.n
  if (o.v !== 1 || typeof n !== 'number' || !Number.isInteger(n) || n < MIN_DRONES || n > MAX_DRONES) return false
  if (![o.t, o.flight, o.heading].every((x) => typeof x === 'number' && Number.isFinite(x))) return false
  if (!PHASES.includes(o.phase as Phase)) return false
  if (!finiteArray(o.route, 7) || !finiteArray(o.s, n * STATE_LEN) || !finiteArray(o.w, n * 4) || !finiteArray(o.soc, n)) return false
  return Array.isArray(o.modes) && o.modes.length === n && o.modes.every((m) => MODES.includes(m as DroneMode))
}

/**
 * Restore a snapshot. Rebuilds the fleet when the drone count differs. Returns
 * whether the fleet was rebuilt (the caller must then rebuild visuals), or null
 * when the snapshot was rejected.
 */
export function applySnapshot(sim: SwarmSim, snap: unknown): boolean | null {
  if (!isSwarmSnapshot(snap)) return null
  const rebuilt = snap.n !== sim.count
  if (rebuilt) sim.rebuild(snap.n)
  const wMax = sim.params.omegaMax
  for (let i = 0; i < snap.n; i++) {
    const d = sim.drones[i]
    for (let k = 0; k < STATE_LEN; k++) d.s[k] = snap.s[i * STATE_LEN + k]
    // an imported file may carry a non-unit (or zero) attitude; a recorded one is already unit
    const qn = Math.hypot(d.s[Q], d.s[Q + 1], d.s[Q + 2], d.s[Q + 3])
    if (Math.abs(qn - 1) > 1e-9) quatNormalizeAt(d.s, Q)
    for (let k = 0; k < 4; k++) {
      d.omega[k] = clamp(snap.w[i * 4 + k], 0, wMax)
      d.omegaCmd[k] = d.omega[k]
      d.thrust[k] = sim.params.kT * d.omega[k] * d.omega[k]
    }
    d.battery.reset(snap.soc[i])
    d.mode = snap.modes[i]
    d.contact = d.s[2] <= sim.params.gearHeight + 1e-6
  }
  sim.t = snap.t
  sim.flightTime = snap.flight
  sim.phase = snap.phase
  sim.heading = wrapPi(snap.heading)
  const r = snap.route
  sim.route.target = Math.max(0, Math.round(r[0]))
  sim.route.dir = r[1] < 0 ? -1 : 1
  sim.route.done = r[2] !== 0
  sim.route.x = r[3]
  sim.route.y = r[4]
  sim.route.vx = r[5]
  sim.route.vy = r[6]
  return rebuilt
}
