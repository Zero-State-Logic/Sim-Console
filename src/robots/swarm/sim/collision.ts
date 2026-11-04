/*
 * Airframe contact between two quadrotors. Each rotor's swept disc is modelled as a
 * sphere of the prop radius around its motor hub, and the centre body as a small
 * sphere, all placed with the drone's real attitude. So whether two quads strike props
 * depends on their relative heading and height, as it does in the air: two 5" quads
 * side by side touch at 0.30 m centre distance with their arms crossed at 45° and at
 * 0.37 m with the arms aligned, while one hovering 0.2 m above the other does not touch.
 * Pure, allocation-free; state layout as dynamics.ts.
 */

/** Centre-body sphere radius, m (the shell is about 0.1 m across). */
export const BODY_RADIUS = 0.05

const ma = new Float64Array(12)
const mb = new Float64Array(12)
/** Motor directions in the body frame, X layout: FL, FR, RR, RL (see mixer.ts). */
const MX: readonly number[] = [1, 1, -1, -1]
const MY: readonly number[] = [1, -1, -1, 1]

/** World positions of the four motor hubs (x, y, z each) for state s, lever arm d = arm/√2. */
export function motorHubs(out: Float64Array, s: ArrayLike<number>, d: number): Float64Array {
  const w = s[6], x = s[7], y = s[8], z = s[9]
  // first two columns of R(q): body x and body y in the world
  const r00 = 1 - 2 * (y * y + z * z), r10 = 2 * (x * y + w * z), r20 = 2 * (x * z - w * y)
  const r01 = 2 * (x * y - w * z), r11 = 1 - 2 * (x * x + z * z), r21 = 2 * (y * z + w * x)
  for (let i = 0; i < 4; i++) {
    const bx = MX[i] * d, by = MY[i] * d
    out[3 * i] = s[0] + r00 * bx + r01 * by
    out[3 * i + 1] = s[1] + r10 * bx + r11 * by
    out[3 * i + 2] = s[2] + r20 * bx + r21 * by
  }
  return out
}

function dist(a: ArrayLike<number>, ia: number, b: ArrayLike<number>, ib: number): number {
  return Math.hypot(a[ia] - b[ib], a[ia + 1] - b[ib + 1], a[ia + 2] - b[ib + 2])
}

/** True when two airframes (states sa, sb) overlap: prop-prop, prop-body or body-body. */
export function airframesTouch(sa: ArrayLike<number>, sb: ArrayLike<number>, armLength: number, propRadius: number): boolean {
  const centre = dist(sa, 0, sb, 0)
  if (centre >= 2 * (armLength + propRadius)) return false
  if (centre < 2 * BODY_RADIUS) return true
  const d = armLength / Math.SQRT2
  motorHubs(ma, sa, d)
  motorHubs(mb, sb, d)
  for (let i = 0; i < 4; i++) {
    if (dist(ma, 3 * i, sb, 0) < propRadius + BODY_RADIUS) return true
    if (dist(mb, 3 * i, sa, 0) < propRadius + BODY_RADIUS) return true
    for (let j = 0; j < 4; j++) if (dist(ma, 3 * i, mb, 3 * j) < 2 * propRadius) return true
  }
  return false
}
