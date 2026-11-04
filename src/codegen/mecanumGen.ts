import type { HardwareSpec } from '../core/types'

/* ============================================================
   SWEEPER GEOMETRY FOR THE FIRMWARE — mecanum X-roller mixing in
   the REP-103 body frame. Wheel i at (x_i, y_i) with roller sign
   k_i = -sign(x_i * y_i):
     w_i r = vx - wz y_i + k_i (vy + wz x_i)
   which is the standard  w_fl = (vx - vy - (lx+ly) wz) / r  set.
   Forward kinematics is the least-squares pseudo-inverse, so it
   stays exact for any wheel layout.
   ============================================================ */

export interface SweeperGeom {
  wheelRadius: number
  halfLength: number
  halfWidth: number
  maxWheelSpeed: number
}

export interface WheelRow {
  name: string
  x: number
  y: number
  k: number
}

/** Romi-class defaults, used (with a warning) when the spec carries no geometry. */
export const SWEEPER_DEFAULTS: SweeperGeom = { wheelRadius: 0.04, halfLength: 0.095, halfWidth: 0.105, maxWheelSpeed: 15 }

export function readSweeperGeometry(spec: HardwareSpec): { geom: SweeperGeom; missing: string[] } {
  const g = spec.geometry ?? {}
  const missing: string[] = []
  const pick = (key: keyof SweeperGeom): number => {
    const v = g[key]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
    missing.push(key)
    return SWEEPER_DEFAULTS[key]
  }
  return {
    geom: { wheelRadius: pick('wheelRadius'), halfLength: pick('halfLength'), halfWidth: pick('halfWidth'), maxWheelSpeed: pick('maxWheelSpeed') },
    missing,
  }
}

const POSITIONS: Record<string, [number, number]> = { FL: [1, 1], FR: [1, -1], RL: [-1, 1], RR: [-1, -1] }
const DEFAULT_ORDER = ['FL', 'FR', 'RL', 'RR']

/** Two-letter corner codes: position first (FL, RR, BL) or side first (LF, RB). */
function compactCorner(t: string): string | null {
  const [a, b] = [t[0], t[1]]
  if ((a === 'F' || a === 'B') && (b === 'L' || b === 'R')) return `${a === 'F' ? 'F' : 'R'}${b}`
  if (a === 'L' && (b === 'F' || b === 'R' || b === 'B')) return `${b === 'F' ? 'F' : 'R'}L`
  if (a === 'R' && (b === 'L' || b === 'R')) return `R${b}`
  if (a === 'R' && (b === 'F' || b === 'B')) return `${b === 'F' ? 'F' : 'R'}R`
  return null
}

/** Map a joint name to a wheel corner ('front left', 'BL', 'wheel_rr', ...). */
export function wheelCorner(name: string): string | null {
  const tokens = name.toUpperCase().split(/[^A-Z]+/).filter(Boolean)
  for (const t of tokens) {
    const c = t.length === 2 ? compactCorner(t) : null
    if (c) return c
  }
  const has = (w: string) => tokens.includes(w)
  const front = has('FRONT')
  const rear = has('REAR') || has('BACK')
  const left = has('LEFT')
  const right = has('RIGHT')
  if (front === rear || left === right) return null
  return `${front ? 'F' : 'R'}${left ? 'L' : 'R'}`
}

/** One row per wheel joint, in joint order. Falls back to FL, FR, RL, RR when names do not parse. */
export function wheelTable(spec: HardwareSpec, g: SweeperGeom): { rows: WheelRow[]; guessed: boolean } {
  const corners = spec.jointNames.map(wheelCorner)
  const parsed = corners.length === 4 && corners.every((c) => c !== null) && new Set(corners).size === 4
  const order = parsed ? (corners as string[]) : DEFAULT_ORDER
  const rows = Array.from({ length: spec.joints }, (_, i) => {
    const corner = order[i % 4]
    const [sx, sy] = POSITIONS[corner]
    const x = sx * g.halfLength
    const y = sy * g.halfWidth
    return { name: spec.jointNames[i] ?? corner, x, y, k: -Math.sign(x * y) }
  })
  return { rows, guessed: !parsed }
}

/** Inverse kinematics, the firmware formula: body twist → wheel speeds (rad/s). */
export function wheelSpeeds(rows: WheelRow[], r: number, vx: number, vy: number, wz: number): number[] {
  return rows.map((w) => (vx - wz * w.y + w.k * (vy + wz * w.x)) / r)
}

/** 3×N forward matrix M with [vx, vy, wz] = M · w (least squares). */
export function forwardMatrix(rows: WheelRow[], r: number): number[][] {
  // A (N×3) maps twist to r*w: row = [1, k, k x - y]
  const A = rows.map((w) => [1, w.k, w.k * w.x - w.y])
  const AtA = [0, 1, 2].map((i) => [0, 1, 2].map((j) => A.reduce((s, row) => s + row[i] * row[j], 0)))
  const inv = invert3(AtA)
  return [0, 1, 2].map((i) => rows.map((_, n) => r * [0, 1, 2].reduce((s, j) => s + inv[i][j] * A[n][j], 0)))
}

function invert3(m: number[][]): number[][] {
  const [a, b, c] = m[0]
  const [d, e, f] = m[1]
  const [g, h, i] = m[2]
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) return [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const k = 1 / det
  return [
    [A * k, -(b * i - c * h) * k, (b * f - c * e) * k],
    [B * k, (a * i - c * g) * k, -(a * f - c * d) * k],
    [C * k, -(a * h - b * g) * k, (a * e - b * d) * k],
  ]
}
