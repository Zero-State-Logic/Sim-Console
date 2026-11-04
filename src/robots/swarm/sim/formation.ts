/*
 * Formation geometry as a virtual structure. Offsets are in the structure frame
 * (x forward along the formation heading, y left), with the leader at the origin,
 * so every shape is defined relative to the drone that flies the route.
 */

export type FormationShape = 'line' | 'wedge' | 'triangle' | 'circle' | 'column'

export const FORMATION_SHAPES: readonly FormationShape[] = ['line', 'wedge', 'triangle', 'circle', 'column']

/** Wedge arm angle from the backward axis. */
const WEDGE_ANGLE = (50 * Math.PI) / 180
const ROW_DEPTH = Math.sqrt(3) / 2

export function isFormationShape(v: unknown): v is FormationShape {
  return typeof v === 'string' && (FORMATION_SHAPES as readonly string[]).includes(v)
}

/**
 * Writes n offsets (x0, y0, x1, y1, ...) for the shape with the given spacing (m).
 * Every shape keeps neighbouring slots at least `spacing` apart.
 */
export function formationOffsets(out: Float64Array, shape: FormationShape, n: number, spacing: number): Float64Array {
  out[0] = 0
  out[1] = 0
  if (shape === 'triangle') {
    triangle(out, n, spacing)
    return out
  }
  if (shape === 'circle') {
    circle(out, n, spacing)
    return out
  }
  for (let k = 1; k < n; k++) {
    const rank = Math.ceil(k / 2)
    const side = k % 2 === 1 ? -1 : 1 // odd slots to the right (-y), even to the left
    let x = 0
    let y = 0
    if (shape === 'line') {
      y = side * rank * spacing
    } else if (shape === 'wedge') {
      x = -rank * spacing * Math.cos(WEDGE_ANGLE)
      y = side * rank * spacing * Math.sin(WEDGE_ANGLE)
    } else {
      x = -k * spacing
    }
    out[2 * k] = x
    out[2 * k + 1] = y
  }
  return out
}

/**
 * Filled rows of 1, 2, 3, ... on an equilateral lattice behind the leader. A partial
 * last row uses lattice positions picked symmetrically (centre block when the parity
 * allows, otherwise from the ends in), so spacing never drops below `s`.
 */
function triangle(out: Float64Array, n: number, s: number): void {
  let k = 1
  for (let row = 1; k < n; row++) {
    const slots = row + 1
    const m = Math.min(slots, n - k)
    for (let j = 0; j < m; j++, k++) {
      out[2 * k] = -row * s * ROW_DEPTH
      out[2 * k + 1] = (latticeIndex(j, m, slots) - row / 2) * s
    }
  }
}

function latticeIndex(j: number, m: number, slots: number): number {
  const spare = slots - m
  if (spare % 2 === 0) return spare / 2 + j
  // ends first: 0, slots-1, 1, slots-2, ...
  return j % 2 === 0 ? j / 2 : slots - 1 - (j - 1) / 2
}

/** Ring through the leader with chord length = spacing between neighbours. */
function circle(out: Float64Array, n: number, s: number): void {
  const r = s / (2 * Math.sin(Math.PI / n))
  for (let k = 1; k < n; k++) {
    const a = (2 * Math.PI * k) / n
    out[2 * k] = -r + r * Math.cos(a)
    out[2 * k + 1] = r * Math.sin(a)
  }
}

/**
 * World xy of slot k for a structure anchored at (ox, oy) and rotated by heading
 * (rad, CCW from +x). Writes out[0], out[1].
 */
export function slotWorld(out: Float64Array, offsets: Float64Array, k: number, ox: number, oy: number, heading: number): void {
  const c = Math.cos(heading), s = Math.sin(heading)
  const x = offsets[2 * k], y = offsets[2 * k + 1]
  out[0] = ox + c * x - s * y
  out[1] = oy + s * x + c * y
}
