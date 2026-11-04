import { serializeObstacle } from './arena'
import type { Obstacle } from './geom2d'
import type { SweeperSim } from './sim'

/*
 * Record/replay snapshots and profile configs.
 * A snapshot holds the pose, the wheel speeds and the coverage percent. The occupancy
 * and coverage textures are NOT part of it (40k cells per frame at 30 Hz would bloat the
 * recording): during replay the robot and instruments rewind, the painted maps keep
 * their latest state.
 */

export interface SweeperSnapshot {
  x: number
  y: number
  th: number
  w: [number, number, number, number]
  cov: number
  bump: boolean
}

export function takeSnapshot(sim: SweeperSim): SweeperSnapshot {
  const w = sim.wheel
  return { x: sim.pose.x, y: sim.pose.y, th: sim.pose.th, w: [w[0], w[1], w[2], w[3]], cov: sim.coverage.percent(), bump: sim.bump }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Validate a snapshot from the recorder (or an imported recording). */
export function parseSnapshot(s: unknown): SweeperSnapshot | null {
  if (!s || typeof s !== 'object') return null
  const r = s as Record<string, unknown>
  if (!finite(r.x) || !finite(r.y) || !finite(r.th) || !finite(r.cov)) return null
  const w = r.w
  if (!Array.isArray(w) || w.length !== 4 || !w.every(finite)) return null
  return { x: r.x, y: r.y, th: r.th, w: [w[0], w[1], w[2], w[3]], cov: Math.max(0, Math.min(100, r.cov)), bump: r.bump === true }
}

export interface SweeperConfigJson {
  v: 1
  size: number
  obstacles: Record<string, number | string>[]
}

export function serializeArena(size: number, obstacles: readonly Obstacle[]): SweeperConfigJson {
  return { v: 1, size, obstacles: obstacles.map(serializeObstacle) }
}
