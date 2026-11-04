import { ARENA_DEFAULT, ARENA_MAX, ARENA_MIN, FOOT_HX, FOOT_HY, MAX_OBSTACLES, ROBOT_RADIUS } from './constants'
import {
  clampObstacleToRoom,
  obstacleInsideRoom,
  obstacleOverlapsObb,
  obstaclesOverlap,
  type BoxObstacle,
  type CylObstacle,
  type Obstacle,
} from './geom2d'
import type { Pose2 } from './mecanum'
import type { Rng } from './rng'

/*
 * Arena: a square room of side `size` centered on the origin, plus obstacles.
 * Layout helpers return new arrays; they never mutate their inputs.
 */

export interface ArenaConfig {
  size: number
  obstacles: Obstacle[]
}

/** Gap kept between generated obstacles so the robot can pass between them. */
const PASSAGE_GAP = 2 * ROBOT_RADIUS + 0.2
const START_CLEAR = 0.75

export function startPose(size: number): Pose2 {
  const half = size / 2
  return { x: -half + 0.55, y: -half + 0.55, th: 0 }
}

type Proto = Omit<BoxObstacle, 'id'> | Omit<CylObstacle, 'id'>

/*
 * Furniture for the default 6 x 6 m room, positions as fractions of the half size so the
 * layout scales with ARENA SIZE (sizes stay real). Sofa, coffee table, armchair, dining
 * table with stools, bookshelf, plant, lamp, column and a low cabinet.
 */
const FURNITURE: Proto[] = [
  { kind: 'box', x: 0.0, y: 0.8, w: 1.9, h: 0.8, a: 0, hgt: 0.46 },
  { kind: 'box', x: 0.05, y: 0.32, w: 1.0, h: 0.55, a: 0, hgt: 0.4 },
  { kind: 'box', x: -0.68, y: 0.3, w: 0.78, h: 0.78, a: 0.35, hgt: 0.55 },
  { kind: 'box', x: 0.5, y: -0.36, w: 1.3, h: 0.85, a: 0, hgt: 0.74 },
  { kind: 'cyl', x: 0.5, y: -0.73, r: 0.17, hgt: 0.45 },
  { kind: 'cyl', x: 0.84, y: -0.36, r: 0.17, hgt: 0.45 },
  { kind: 'box', x: 0.915, y: 0.25, w: 0.38, h: 1.3, a: 0, hgt: 0.9 },
  { kind: 'cyl', x: -0.84, y: 0.84, r: 0.24, hgt: 0.62 },
  { kind: 'cyl', x: 0.88, y: 0.86, r: 0.14, hgt: 0.85 },
  { kind: 'cyl', x: -0.32, y: -0.25, r: 0.16, hgt: 0.9 },
  { kind: 'box', x: -0.22, y: -0.905, w: 1.2, h: 0.42, a: 0, hgt: 0.5 },
]

function withIds(protos: Proto[], firstId: number): Obstacle[] {
  return protos.map((p, i) => ({ ...p, id: firstId + i }) as Obstacle)
}

function clearOfStart(o: Obstacle, size: number): boolean {
  const s = startPose(size)
  return !obstacleOverlapsObb(o, s.x, s.y, FOOT_HX, FOOT_HY, s.th, START_CLEAR - FOOT_HX)
}

/** Keep the obstacles that fit the room, do not overlap earlier ones and leave the start clear. */
function admit(candidates: Obstacle[], size: number, gap: number): Obstacle[] {
  const half = size / 2
  const out: Obstacle[] = []
  for (const o of candidates) {
    if (!obstacleInsideRoom(o, half) || !clearOfStart(o, size)) continue
    if (out.some((p) => obstaclesOverlap(p, o, gap))) continue
    out.push(o)
  }
  return out
}

export function defaultLayout(size: number): Obstacle[] {
  const half = size / 2
  const scaled = FURNITURE.map((p) => ({ ...p, x: p.x * half, y: p.y * half }))
  return admit(withIds(scaled, 1).map((o) => clampObstacleToRoom(o, half)), size, 0.05)
}

/** Scale obstacle centers to a new room size (sizes unchanged), dropping ones that no longer fit. */
export function rescaleLayout(obstacles: readonly Obstacle[], from: number, to: number): Obstacle[] {
  const k = to / from
  const half = to / 2
  const moved = obstacles.map((o) => clampObstacleToRoom({ ...o, x: o.x * k, y: o.y * k }, half))
  return admit(moved, to, 0.02)
}

function randomObstacle(rng: Rng, half: number, id: number, kind?: 'box' | 'cyl'): Obstacle {
  const k = kind ?? (rng.next() < 0.6 ? 'box' : 'cyl')
  const lim = Math.max(0.2, half - 0.3)
  const x = rng.range(-lim, lim)
  const y = rng.range(-lim, lim)
  if (k === 'cyl') return { kind: 'cyl', id, x, y, r: rng.range(0.12, 0.34), hgt: rng.range(0.35, 0.9) }
  return { kind: 'box', id, x, y, w: rng.range(0.35, 1.4), h: rng.range(0.3, 0.95), a: rng.range(0, Math.PI), hgt: rng.range(0.3, 0.85) }
}

/** True when an obstacle can be placed: inside, clear of the others and of the robot. */
export function canPlace(o: Obstacle, others: readonly Obstacle[], half: number, robot: Pose2, gap: number): boolean {
  if (!obstacleInsideRoom(o, half)) return false
  if (obstacleOverlapsObb(o, robot.x, robot.y, FOOT_HX, FOOT_HY, robot.th, 0.25)) return false
  return !others.some((p) => p.id !== o.id && obstaclesOverlap(p, o, gap))
}

/** Random room: 4 + 0.9 per meter of side obstacles, passable gaps, robot area kept clear. */
export function randomLayout(rng: Rng, size: number, robot: Pose2, firstId: number): Obstacle[] {
  const half = size / 2
  const target = Math.min(MAX_OBSTACLES, Math.round(4 + size * 0.9))
  const out: Obstacle[] = []
  for (let tries = 0; tries < 400 && out.length < target; tries++) {
    const o = randomObstacle(rng, half, firstId + out.length)
    if (!canPlace(o, out, half, robot, PASSAGE_GAP)) continue
    if (obstacleOverlapsObb(o, robot.x, robot.y, FOOT_HX, FOOT_HY, robot.th, START_CLEAR)) continue
    out.push(o)
  }
  return out
}

/** One more random obstacle of the given kind, or null when the room is full. */
export function addRandomObstacle(rng: Rng, existing: readonly Obstacle[], size: number, robot: Pose2, kind: 'box' | 'cyl', id: number): Obstacle | null {
  if (existing.length >= MAX_OBSTACLES) return null
  const half = size / 2
  for (let tries = 0; tries < 200; tries++) {
    const o = randomObstacle(rng, half, id, kind)
    if (canPlace(o, existing, half, robot, 0.3)) return o
  }
  return null
}

/* ---------------- validation of untrusted config (profiles, imports) ---------------- */

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function inRange(v: unknown, lo: number, hi: number): number | null {
  return finite(v) ? Math.min(hi, Math.max(lo, v)) : null
}

function parseObstacle(raw: unknown, id: number, half: number): Obstacle | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const x = inRange(r.x, -half, half)
  const y = inRange(r.y, -half, half)
  const hgt = inRange(r.hgt ?? 0.5, 0.05, 2) ?? 0.5
  if (x === null || y === null) return null
  if (r.kind === 'cyl') {
    const rad = inRange(r.r, 0.03, 1.5)
    return rad === null ? null : { kind: 'cyl', id, x, y, r: rad, hgt }
  }
  if (r.kind === 'box') {
    const w = inRange(r.w, 0.05, 4)
    const h = inRange(r.h, 0.05, 4)
    const a = finite(r.a) ? r.a : 0
    return w === null || h === null ? null : { kind: 'box', id, x, y, w, h, a, hgt }
  }
  return null
}

/** Validate an arena config from an untrusted source. Returns null when it is unusable. */
export function parseArenaConfig(c: unknown): ArenaConfig | null {
  if (!c || typeof c !== 'object') return null
  const r = c as Record<string, unknown>
  const raw = inRange(r.size ?? ARENA_DEFAULT, ARENA_MIN, ARENA_MAX)
  if (raw === null || !Array.isArray(r.obstacles)) return null
  // snap to the ARENA SIZE step first, so obstacles are clamped to the room actually built
  const size = Math.round(raw * 2) / 2
  const half = size / 2
  const obstacles: Obstacle[] = []
  for (const raw of r.obstacles.slice(0, MAX_OBSTACLES)) {
    const o = parseObstacle(raw, obstacles.length + 1, half)
    if (o) obstacles.push(clampObstacleToRoom(o, half))
  }
  return { size, obstacles }
}

export function serializeObstacle(o: Obstacle): Record<string, number | string> {
  const round = (v: number) => Math.round(v * 1000) / 1000
  if (o.kind === 'cyl') return { kind: 'cyl', x: round(o.x), y: round(o.y), r: round(o.r), hgt: round(o.hgt) }
  return { kind: 'box', x: round(o.x), y: round(o.y), w: round(o.w), h: round(o.h), a: round(o.a), hgt: round(o.hgt) }
}
