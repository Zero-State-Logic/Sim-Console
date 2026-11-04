import type { SandboxCommand, SandboxFnDef, SensorSnapshot } from '../../core/types'
import { DEG } from './sim/frames'
import { FORMATION_SHAPES } from './sim/formation'
import type { FormationShape } from './sim/formation'
import type { SwarmSim } from './sim/swarmSim'

/*
 * CODE drive source for the swarm. World coordinates are the three.js Y-up frame
 * (x, z on the ground, y = altitude), meters; angles in degrees; drone ids 0-based.
 */

export const SWARM_SANDBOX_API: readonly SandboxFnDef[] = [
  { name: 'setTarget', kind: 'command', params: ['id', 'x', 'y', 'z'], doc: 'Fly drone id to world point (x, y, z) m, y up. Takes it out of the formation until setFormation().' },
  { name: 'setYaw', kind: 'command', params: ['id', 'deg'], doc: 'Hold drone id at a heading, degrees CCW from +X seen from above.' },
  { name: 'setFormation', kind: 'command', params: ['index'], doc: 'Formation shape 0 line, 1 wedge, 2 triangle, 3 circle, 4 column. Every drone rejoins it.' },
  { name: 'takeoff', kind: 'command', params: [], doc: 'Arm every parked drone and climb to the cruise altitude.' },
  { name: 'land', kind: 'command', params: [], doc: 'Land every drone in place and disarm.' },
  { name: 'addWaypoint', kind: 'command', params: ['x', 'z'], doc: 'Append a route waypoint on the ground plane (flown at cruise altitude).' },
  { name: 'clearWaypoints', kind: 'command', params: [], doc: 'Remove every waypoint; the leader holds position.' },
  { name: 'readX', kind: 'query', params: ['id'], sensor: 'posX', doc: 'World x of drone id, m.' },
  { name: 'readY', kind: 'query', params: ['id'], sensor: 'posY', doc: 'Altitude of drone id, m.' },
  { name: 'readZ', kind: 'query', params: ['id'], sensor: 'posZ', doc: 'World z of drone id, m.' },
  { name: 'readBattery', kind: 'query', params: ['id'], sensor: 'battery', doc: 'Battery of drone id, percent.' },
  { name: 'readSpeed', kind: 'query', params: ['id'], sensor: 'speed', doc: 'Ground-frame speed of drone id, m/s.' },
  { name: 'droneCount', kind: 'query', params: [], sensor: 'drones', doc: 'Number of drones in the swarm.' },
]

export function swarmSensors(sim: SwarmSim): SensorSnapshot {
  const n = sim.count
  const posX: number[] = new Array(n)
  const posY: number[] = new Array(n)
  const posZ: number[] = new Array(n)
  const battery: number[] = new Array(n)
  const speed: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const d = sim.drones[i]
    posX[i] = d.s[0]
    posY[i] = d.s[2]
    posZ[i] = -d.s[1]
    battery[i] = d.battery.percent
    speed[i] = d.speed
  }
  return { posX, posY, posZ, battery, speed, drones: n }
}

export interface SandboxEffects {
  /** Formation shape selected by setFormation (the module mirrors it into its controls). */
  shape?: FormationShape
}

function finite(args: number[], count: number): boolean {
  if (args.length < count) return false
  for (let i = 0; i < count; i++) if (typeof args[i] !== 'number' || !Number.isFinite(args[i])) return false
  return true
}

function droneId(sim: SwarmSim, v: number): number | null {
  const id = Math.round(v)
  return id >= 0 && id < sim.count ? id : null
}

/** Apply one frame of user commands. Unknown names and bad arguments are ignored. */
export function applySwarmCommands(sim: SwarmSim, cmds: SandboxCommand[]): SandboxEffects {
  const fx: SandboxEffects = {}
  for (const c of cmds) {
    const a = Array.isArray(c.args) ? c.args : []
    switch (c.fn) {
      case 'setTarget': {
        const id = finite(a, 4) ? droneId(sim, a[0]) : null
        // world (x, y up, z) -> sim (x, -z, y)
        if (id !== null) sim.setManualTarget(id, a[1], -a[3], a[2])
        break
      }
      case 'setYaw': {
        const id = finite(a, 2) ? droneId(sim, a[0]) : null
        if (id !== null) sim.setYawOverride(id, a[1] * DEG)
        break
      }
      case 'setFormation': {
        const shape = finite(a, 1) ? FORMATION_SHAPES[Math.round(a[0])] : undefined
        if (shape) {
          fx.shape = shape
          sim.clearManual()
        }
        break
      }
      case 'takeoff':
        sim.takeoff()
        break
      case 'land':
        sim.land()
        break
      case 'addWaypoint':
        if (finite(a, 2)) sim.addWaypoint(a[0], -a[1])
        break
      case 'clearWaypoints':
        sim.clearWaypoints()
        break
      default:
        break
    }
  }
  return fx
}
