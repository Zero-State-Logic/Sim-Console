import type { ControlValue, RobotKind } from '../../core/types'

/*
 * Built-in presets per robot. A preset starts from a fresh module (factory state) and
 * then applies its control values through the same validated path as a saved profile,
 * so a key or option the live schema does not offer is skipped and reported, never
 * forced. FACTORY is the empty preset: just the fresh module.
 */

export interface BuiltinPreset {
  id: string
  kind: RobotKind
  name: string
  desc: string
  controls: Readonly<Record<string, ControlValue>>
}

export const FACTORY_ID = 'factory'

const WALKER: BuiltinPreset[] = [
  { id: 'hex-tripod', kind: 'walker', name: 'HEX · TRIPOD', desc: 'Six legs, fast alternating tripod.', controls: { legs: '6', gait: 'tripod', speed: 70, gaitHz: 1.4 } },
  { id: 'hex-wave', kind: 'walker', name: 'HEX · WAVE', desc: 'One leg at a time: slow, five feet down.', controls: { legs: '6', gait: 'wave', speed: 50, gaitHz: 0.8 } },
  { id: 'quad-crawl', kind: 'walker', name: 'QUAD · CRAWL', desc: 'Statically stable creep on four legs.', controls: { legs: '4', gait: 'crawl', speed: 45 } },
  { id: 'quad-trot', kind: 'walker', name: 'QUAD · TROT', desc: 'Diagonal pairs, dynamic on four legs.', controls: { legs: '4', gait: 'trot', speed: 60 } },
  { id: 'octo-tetrapod', kind: 'walker', name: 'OCTO · TETRAPOD', desc: 'Eight legs, four down at all times.', controls: { legs: '8', gait: 'tetrapod', speed: 60 } },
  { id: 'hex-mg996r', kind: 'walker', name: 'REAL SERVOS', desc: 'Hexapod on MG996R actuator limits.', controls: { legs: '6', gait: 'tripod', actuator: 'mg996r' } },
]

const SWEEPER: BuiltinPreset[] = [
  { id: 'coverage', kind: 'sweeper', name: 'COVERAGE RUN', desc: 'Boustrophedon lanes over the mapped free space.', controls: { mode: 'coverage', showCoverage: true, showPlan: true } },
  { id: 'wander', kind: 'sweeper', name: 'WANDER', desc: 'Reactive roaming on the LiDAR safety layer.', controls: { mode: 'wander', safety: true } },
  { id: 'teleop', kind: 'sweeper', name: 'TELEOP', desc: 'Drive it yourself with W A S D and Q / E.', controls: { mode: 'teleop' } },
  { id: 'noisy', kind: 'sweeper', name: 'NOISY LIDAR', desc: '3× range noise and wheel slip: stress the map.', controls: { mode: 'coverage', noise: 3, slip: true } },
]

const SWARM: BuiltinPreset[] = [
  { id: 'wedge', kind: 'swarm', name: 'FOUR · WEDGE', desc: 'V formation behind the leader, light wind.', controls: { drones: '4', shape: 'wedge', wind: true, windSpeed: 2 } },
  { id: 'circle', kind: 'swarm', name: 'SIX · CIRCLE', desc: 'Six drones on a ring around the centroid.', controls: { drones: '6', shape: 'circle', spacing: 2.5 } },
  { id: 'calm-line', kind: 'swarm', name: 'CALM · LINE', desc: 'No wind, line abreast: clean tracking.', controls: { shape: 'line', wind: false } },
  { id: 'gusty', kind: 'swarm', name: 'GUSTY AIR', desc: 'Strong wind with gusts: watch the PID work.', controls: { wind: true, windSpeed: 6, gust: 2 } },
]

const BY_KIND: Readonly<Record<RobotKind, BuiltinPreset[]>> = { walker: WALKER, sweeper: SWEEPER, swarm: SWARM }

/** Factory preset first, then the curated ones for that robot. */
export function presetsFor(kind: RobotKind): BuiltinPreset[] {
  const factory: BuiltinPreset = { id: FACTORY_ID, kind, name: 'FACTORY', desc: 'Fresh module: every control at its default.', controls: {} }
  return [factory, ...BY_KIND[kind]]
}
