import type { HardwareSpec, TelemetryTable } from '../../core/types'
import type { CmdMsg, DroneSetpoint, DroneTel, TelMsg } from '../../core/protocol'
import { DEG, RAD } from './sim/frames'
import { quatToEuler } from './sim/quat'
import type { SwarmSim } from './sim/swarmSim'

/*
 * HARDWARE drive source for the swarm. Every drone is one "joint". The app sends
 * position setpoints (world meters, three.js Y-up, as protocol.ts DroneSetpoint)
 * and the drones run their own flight controllers; telemetry mirrors their real
 * positions and attitudes back into the scene. Ids are 0-based, labels D1..DN.
 * Attitude on the wire: [roll, pitch, yaw] degrees, REP-103 ZYX Euler.
 * The ground is y = 0 on the wire: landing and parked drones are commanded to it.
 *
 * Battery: protocol.ts leaves DroneTel.bat unitless and the two producers differ. The
 * generated firmware (src/codegen/cpp/swarm.ts) sends whole percent; the Virtual Device
 * sends the 1S cell voltage on the LiPo curve below. batteryPercent() accepts both:
 * up to 4.35 (a charged cell) it is volts, above that percent. A missing or negative
 * value is unknown.
 */

export function hardwareSpec(sim: SwarmSim): HardwareSpec {
  const n = sim.count
  return {
    robot: 'swarm',
    joints: n,
    jointNames: Array.from({ length: n }, (_, i) => `D${i + 1}`),
    jointLimits: Array.from({ length: n }, () => [-180, 180] as [number, number]),
    homePose: new Array(n).fill(0),
    drones: n,
    defaultLevel: { wired: 'high', wireless: 'high' },
    geometry: {
      armLength: sim.params.armLength,
      mass: sim.params.mass,
      cruiseAlt: sim.settings.cruiseAlt,
    },
  }
}

const mm = (v: number): number => Math.round(v * 1000) / 1000

/** LiPo resting voltage per cell vs state of charge, [volts, percent] (typical curve, as the Virtual Device uses). */
const CELL_CURVE: readonly (readonly [number, number])[] = [
  [3.3, 0], [3.5, 5], [3.68, 20], [3.74, 40], [3.8, 55], [3.87, 70], [3.95, 80], [4.05, 90], [4.2, 100],
]
/** Readings up to this are a cell voltage; a charged LiPo (or LiHV) cell rests at most here, V. */
export const CELL_MAX_V = 4.35

/** Cell voltage -> state of charge %, piecewise linear on CELL_CURVE. */
export function cellPercent(volts: number): number {
  if (volts <= CELL_CURVE[0][0]) return 0
  for (let i = 1; i < CELL_CURVE.length; i++) {
    const [v1, p1] = CELL_CURVE[i]
    if (volts <= v1) {
      const [v0, p0] = CELL_CURVE[i - 1]
      return p0 + ((volts - v0) / (v1 - v0)) * (p1 - p0)
    }
  }
  return 100
}

/**
 * Battery reading -> percent in [0, 100], NaN when unknown. Up to CELL_MAX_V it is a
 * cell voltage (Virtual Device), above that a percentage (generated firmware). The only
 * overlap is a firmware reading of exactly 4 %, which decodes as ~85 % for a moment; by
 * then the 10 % low-battery failsafe has already latched the drone into landing.
 */
export function batteryPercent(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return Number.NaN
  return v <= CELL_MAX_V ? cellPercent(v) : Math.min(v, 100)
}

/**
 * Outbound altitude for a drone, wire meters. The sim holds a parked airframe at its
 * gear height, but a real (or virtual) drone only disarms once its setpoint is on the
 * ground, so a landing or parked drone is sent y = 0.
 */
function setpointAltitude(sim: SwarmSim, i: number): number {
  const d = sim.drones[i]
  if (d.mode === 'landing' || (!d.armed && d.contact)) return 0
  return d.target[2]
}

/**
 * One setpoint per drone (its current target), plus the mission phase as mode. While
 * mirroring real drones, a drone gets no setpoint until its first telemetry sample, so
 * a stale sim position is never sent to a real airframe.
 */
export function buildSwarmCommand(sim: SwarmSim, mirror: boolean): CmdMsg {
  const sp: DroneSetpoint[] = []
  for (const d of sim.drones) {
    if (mirror && d.mirrorT < 0) continue
    sp.push({
      id: d.id,
      // sim (x, y, z) -> wire/three.js (x, z, -y)
      p: [mm(d.target[0]), mm(setpointAltitude(sim, d.id)), mm(-d.target[1])],
      yaw: Math.round(d.yawSp * RAD * 10) / 10,
    })
  }
  return { t: 'cmd', sp, mode: sim.phase }
}

function validDroneTel(d: unknown): d is DroneTel {
  if (!d || typeof d !== 'object') return false
  const o = d as Record<string, unknown>
  const triple = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))
  return typeof o.id === 'number' && Number.isInteger(o.id) && triple(o.p) && triple(o.att)
}

/** Mirror real drones into the sim. Malformed entries are skipped. */
export function applySwarmTelemetry(sim: SwarmSim, tel: TelMsg): number {
  if (!Array.isArray(tel.drones)) return 0
  let applied = 0
  for (const d of tel.drones) {
    if (!validDroneTel(d) || d.id < 0 || d.id >= sim.count) continue
    const pct = batteryPercent(d.bat)
    sim.mirrorDrone(d.id, d.p[0], -d.p[2], d.p[1], d.att[0] * DEG, d.att[1] * DEG, d.att[2] * DEG, Number.isFinite(pct) ? pct : undefined)
    applied++
  }
  return applied
}

const COLS = ['x', 'y', 'z', 'roll', 'pitch', 'yaw', 'battery']
const r2 = (v: number): number => Math.round(v * 100) / 100
const r1 = (v: number): number => Math.round(v * 10) / 10

/** Live per-drone table from the latest telemetry (wire frame, degrees, %; '—' where a drone is missing). */
export function swarmTable(sim: SwarmSim, tel: TelMsg | null): TelemetryTable {
  const byId = new Map<number, DroneTel>()
  if (tel && Array.isArray(tel.drones)) for (const d of tel.drones) if (validDroneTel(d)) byId.set(d.id, d)
  const rows = sim.drones.map((dr) => {
    const d = byId.get(dr.id)
    if (!d) return { label: `D${dr.id + 1}`, cells: COLS.map((): number | string => '—') }
    const pct = batteryPercent(d.bat)
    const bat = Number.isFinite(pct) ? Math.round(pct) : '—'
    return { label: `D${dr.id + 1}`, cells: [r2(d.p[0]), r2(d.p[1]), r2(d.p[2]), r1(d.att[0]), r1(d.att[1]), r1(d.att[2]), bat] }
  })
  return { cols: COLS, rows }
}

const eul = new Float64Array(3)

/** Sim state as DroneTel entries, as the generated firmware reports them (battery in percent). */
export function simDroneTel(sim: SwarmSim): DroneTel[] {
  return sim.drones.map((d) => {
    quatToEuler(eul, d.s, 6)
    return {
      id: d.id,
      p: [d.s[0], d.s[2], -d.s[1]],
      att: [eul[0] * RAD, eul[1] * RAD, eul[2] * RAD],
      bat: r1(d.battery.percent),
    }
  })
}
