import { L_MAX, L_MIN } from '../occupancy'

/*
 * Map overlays as RGBA8 texels (sRGB, straight alpha), one per grid cell, row-major with
 * ix fastest (DataTexture rows run along +plan y). Occupancy: unknown transparent, free a
 * faint SIM teal, occupied dark ink, bumper contacts danger red; the alpha follows the
 * evidence, so cells firm up as scans accumulate. Coverage: faint orange where the brush
 * passed.
 */

const TEAL = [12, 143, 155] as const
const INK = [20, 23, 26] as const
const DANGER = [209, 31, 45] as const
const ORANGE = [255, 90, 31] as const

/** Log-odds magnitude below which a cell is drawn as unknown. */
const DEAD = 0.25
export const FREE_ALPHA = 44
export const OCC_ALPHA = 215
export const CONTACT_ALPHA = 220
export const COVER_ALPHA = 70

function put(out: Uint8Array, k: number, c: readonly [number, number, number], a: number): void {
  out[k] = c[0]
  out[k + 1] = c[1]
  out[k + 2] = c[2]
  out[k + 3] = a
}

export function paintOccupancy(lo: Float32Array, contact: Uint8Array, out: Uint8Array): void {
  for (let i = 0, k = 0; i < lo.length; i++, k += 4) {
    const v = lo[i]
    if (contact[i]) put(out, k, DANGER, CONTACT_ALPHA)
    else if (v > DEAD) put(out, k, INK, Math.round(OCC_ALPHA * Math.min(1, (v - DEAD) / (L_MAX / 2 - DEAD))))
    else if (v < -DEAD) put(out, k, TEAL, Math.round(FREE_ALPHA * Math.min(1, (-v - DEAD) / (-L_MIN / 2 - DEAD))))
    else put(out, k, INK, 0)
  }
}

export function paintCoverage(covered: Uint8Array, out: Uint8Array): void {
  for (let i = 0, k = 0; i < covered.length; i++, k += 4) put(out, k, ORANGE, covered[i] ? COVER_ALPHA : 0)
}
