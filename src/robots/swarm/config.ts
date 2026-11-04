import type { ControlValue } from '../../core/types'
import { isFormationShape } from './sim/formation'
import type { FormationShape } from './sim/formation'
import { isRouteMode } from './sim/route'
import type { RouteMode } from './sim/route'
import { MAX_WAYPOINTS, VOLUME_HALF } from './sim/swarmSim'
import type { SwarmSim } from './sim/swarmSim'

/*
 * Profile config for the swarm: the waypoint route (three.js ground coordinates
 * [x, z]) and the formation settings. Parsing is strict about types and lenient
 * about ranges (values are clamped), so a hand-edited JSON file still loads.
 */

export interface SwarmConfig {
  v: 1
  waypoints: [number, number][]
  shape: FormationShape
  spacing: number
  cruiseAlt: number
  cruiseSpeed: number
  routeMode: RouteMode
}

/** -v without producing -0 (which survives structured cloning and breaks equality checks). */
function flip(v: number): number {
  return 0 - v
}

export function serializeSwarmConfig(sim: SwarmSim): SwarmConfig {
  const waypoints: [number, number][] = []
  for (let i = 0; i < sim.wpCount; i++) {
    // sim (x, y) -> ground (x, z = -y)
    waypoints.push([sim.waypoints[2 * i], flip(sim.waypoints[2 * i + 1])])
  }
  const st = sim.settings
  return {
    v: 1,
    waypoints,
    shape: st.shape,
    spacing: st.spacing,
    cruiseAlt: st.cruiseAlt,
    cruiseSpeed: st.cruiseSpeed,
    routeMode: st.routeMode,
  }
}

export interface ParsedSwarmConfig {
  /** Sim-frame xy pairs, already clamped to the volume. */
  waypoints?: [number, number][]
  values: Record<string, ControlValue>
}

function clampNum(v: unknown, lo: number, hi: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : undefined
}

/** Validate an untrusted config. Returns null when it is not a swarm config at all. */
export function parseSwarmConfig(c: unknown): ParsedSwarmConfig | null {
  if (!c || typeof c !== 'object') return null
  const o = c as Record<string, unknown>
  if (o.v !== undefined && o.v !== 1) return null
  const out: ParsedSwarmConfig = { values: {} }
  if (Array.isArray(o.waypoints)) {
    const wps: [number, number][] = []
    for (const w of o.waypoints.slice(0, MAX_WAYPOINTS)) {
      if (!Array.isArray(w) || w.length < 2) continue
      const x = clampNum(w[0], -VOLUME_HALF, VOLUME_HALF)
      const z = clampNum(w[1], -VOLUME_HALF, VOLUME_HALF)
      if (x !== undefined && z !== undefined) wps.push([x, flip(z)])
    }
    out.waypoints = wps
  }
  if (isFormationShape(o.shape)) out.values.shape = o.shape
  if (isRouteMode(o.routeMode)) out.values.routeMode = o.routeMode
  const spacing = clampNum(o.spacing, 1, 4)
  const alt = clampNum(o.cruiseAlt, 1, 8)
  const speed = clampNum(o.cruiseSpeed, 0.5, 6)
  if (spacing !== undefined) out.values.spacing = spacing
  if (alt !== undefined) out.values.cruiseAlt = alt
  if (speed !== undefined) out.values.cruiseSpeed = speed
  return out
}
