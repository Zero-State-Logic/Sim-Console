/*
 * Plan-frame geometry: obstacles, oriented-box (OBB) and circle overlap tests, and the
 * robot footprint check against obstacles and the room walls. Pure, no three.js.
 */

export interface BoxObstacle {
  kind: 'box'
  id: number
  x: number
  y: number
  /** Full size along the box's local x. */
  w: number
  /** Full size along the box's local y. */
  h: number
  /** Yaw, radians CCW. */
  a: number
  /** Visual height, meters. */
  hgt: number
}

export interface CylObstacle {
  kind: 'cyl'
  id: number
  x: number
  y: number
  r: number
  hgt: number
}

export type Obstacle = BoxObstacle | CylObstacle

/** SAT overlap of two oriented boxes given centers, half extents and yaw. */
export function obbOverlapsObb(
  ax: number, ay: number, ahx: number, ahy: number, aa: number,
  bx: number, by: number, bhx: number, bhy: number, ba: number,
): boolean {
  const ac = Math.cos(aa), as = Math.sin(aa)
  const bc = Math.cos(ba), bs = Math.sin(ba)
  const dx = bx - ax, dy = by - ay
  // the four candidate separating axes: A.x, A.y, B.x, B.y
  return !separated(ac, as, dx, dy, ac, as, ahx, ahy, bc, bs, bhx, bhy)
    && !separated(-as, ac, dx, dy, ac, as, ahx, ahy, bc, bs, bhx, bhy)
    && !separated(bc, bs, dx, dy, ac, as, ahx, ahy, bc, bs, bhx, bhy)
    && !separated(-bs, bc, dx, dy, ac, as, ahx, ahy, bc, bs, bhx, bhy)
}

function separated(
  lx: number, ly: number, dx: number, dy: number,
  ac: number, as: number, ahx: number, ahy: number,
  bc: number, bs: number, bhx: number, bhy: number,
): boolean {
  const ra = ahx * Math.abs(ac * lx + as * ly) + ahy * Math.abs(-as * lx + ac * ly)
  const rb = bhx * Math.abs(bc * lx + bs * ly) + bhy * Math.abs(-bs * lx + bc * ly)
  return Math.abs(dx * lx + dy * ly) > ra + rb
}

/** Oriented box vs circle: closest point of the box to the circle center. */
export function obbOverlapsCircle(ax: number, ay: number, ahx: number, ahy: number, aa: number, cx: number, cy: number, r: number): boolean {
  const c = Math.cos(aa), s = Math.sin(aa)
  const dx = cx - ax, dy = cy - ay
  const lx = c * dx + s * dy
  const ly = -s * dx + c * dy
  const qx = Math.max(-ahx, Math.min(ahx, lx))
  const qy = Math.max(-ahy, Math.min(ahy, ly))
  const ex = lx - qx, ey = ly - qy
  return ex * ex + ey * ey <= r * r
}

/** World-axis half extents of an oriented box. */
export function obbExtents(hx: number, hy: number, a: number): [number, number] {
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a))
  return [hx * c + hy * s, hx * s + hy * c]
}

/** True when the whole oriented box lies inside the square room [-half, half]^2. */
export function obbInsideRoom(x: number, y: number, hx: number, hy: number, a: number, half: number): boolean {
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a))
  const ex = hx * c + hy * s
  const ey = hx * s + hy * c
  return Math.abs(x) + ex <= half && Math.abs(y) + ey <= half
}

/** Obstacle vs an oriented box, both grown by `margin`. */
export function obstacleOverlapsObb(o: Obstacle, x: number, y: number, hx: number, hy: number, a: number, margin = 0): boolean {
  if (o.kind === 'cyl') return obbOverlapsCircle(x, y, hx + margin, hy + margin, a, o.x, o.y, o.r)
  return obbOverlapsObb(x, y, hx + margin, hy + margin, a, o.x, o.y, o.w / 2, o.h / 2, o.a)
}

/** Robot footprint (oriented box) against every obstacle and the walls. */
export function footprintCollides(x: number, y: number, th: number, hx: number, hy: number, obstacles: readonly Obstacle[], half: number): boolean {
  if (!obbInsideRoom(x, y, hx, hy, th, half)) return true
  for (let i = 0; i < obstacles.length; i++) {
    if (obstacleOverlapsObb(obstacles[i], x, y, hx, hy, th)) return true
  }
  return false
}

/** A plan-frame vector, written in place. */
export interface Vec2 {
  x: number
  y: number
}

/**
 * Minimum translation that separates the robot footprint (oriented box) from one
 * obstacle: writes the unit direction the robot must move in to `n` and returns the
 * penetration depth (0 = just touching), or -1 when they are apart. Boxes use the SAT
 * axis of least overlap, circles the closest point of the footprint.
 */
export function footprintPush(x: number, y: number, th: number, hx: number, hy: number, o: Obstacle, n: Vec2): number {
  const c = Math.cos(th), s = Math.sin(th)
  return o.kind === 'cyl' ? pushFromCircle(x, y, c, s, hx, hy, o, n) : pushFromBox(x, y, c, s, hx, hy, o, n)
}

function pushFromCircle(x: number, y: number, c: number, s: number, hx: number, hy: number, o: CylObstacle, n: Vec2): number {
  const dx = o.x - x, dy = o.y - y
  const lx = c * dx + s * dy
  const ly = -s * dx + c * dy
  const ex = lx - Math.max(-hx, Math.min(hx, lx))
  const ey = ly - Math.max(-hy, Math.min(hy, ly))
  const d = Math.hypot(ex, ey)
  let ux: number, uy: number, depth: number
  if (d > 0) {
    if (d > o.r) return -1
    depth = o.r - d
    ux = -ex / d
    uy = -ey / d
  } else {
    // circle center inside the footprint: leave through the nearest face
    const fx = hx - Math.abs(lx), fy = hy - Math.abs(ly)
    depth = o.r + Math.min(fx, fy)
    ux = fx <= fy ? (lx >= 0 ? -1 : 1) : 0
    uy = fx <= fy ? 0 : ly >= 0 ? -1 : 1
  }
  n.x = c * ux - s * uy
  n.y = s * ux + c * uy
  return depth
}

function pushFromBox(x: number, y: number, c: number, s: number, hx: number, hy: number, o: BoxObstacle, n: Vec2): number {
  const bc = Math.cos(o.a), bs = Math.sin(o.a)
  const dx = o.x - x, dy = o.y - y
  let best = Infinity
  for (let k = 0; k < 4; k++) {
    // candidate axes: footprint x, footprint y, box x, box y
    const lx = k === 0 ? c : k === 1 ? -s : k === 2 ? bc : -bs
    const ly = k === 0 ? s : k === 1 ? c : k === 2 ? bs : bc
    const ra = hx * Math.abs(c * lx + s * ly) + hy * Math.abs(-s * lx + c * ly)
    const rb = (o.w / 2) * Math.abs(bc * lx + bs * ly) + (o.h / 2) * Math.abs(-bs * lx + bc * ly)
    const proj = dx * lx + dy * ly
    const overlap = ra + rb - Math.abs(proj)
    if (overlap < 0) return -1
    if (overlap < best) {
      best = overlap
      // move away from the obstacle center along this axis
      n.x = proj >= 0 ? -lx : lx
      n.y = proj >= 0 ? -ly : ly
    }
  }
  return best
}

export function pointInObstacle(px: number, py: number, o: Obstacle, margin = 0): boolean {
  const dx = px - o.x, dy = py - o.y
  if (o.kind === 'cyl') {
    const r = o.r + margin
    return dx * dx + dy * dy <= r * r
  }
  const c = Math.cos(o.a), s = Math.sin(o.a)
  const lx = c * dx + s * dy
  const ly = -s * dx + c * dy
  return Math.abs(lx) <= o.w / 2 + margin && Math.abs(ly) <= o.h / 2 + margin
}

/** Two obstacles overlap once each is grown by `gap / 2`. */
export function obstaclesOverlap(a: Obstacle, b: Obstacle, gap = 0): boolean {
  const g = gap / 2
  if (a.kind === 'cyl' && b.kind === 'cyl') return Math.hypot(a.x - b.x, a.y - b.y) <= a.r + b.r + gap
  if (a.kind === 'box' && b.kind === 'box') {
    return obbOverlapsObb(a.x, a.y, a.w / 2 + g, a.h / 2 + g, a.a, b.x, b.y, b.w / 2 + g, b.h / 2 + g, b.a)
  }
  const box = (a.kind === 'box' ? a : b) as BoxObstacle
  const cyl = (a.kind === 'cyl' ? a : b) as CylObstacle
  return obbOverlapsCircle(box.x, box.y, box.w / 2 + g, box.h / 2 + g, box.a, cyl.x, cyl.y, cyl.r + g)
}

/** True when the obstacle lies fully inside the room. */
export function obstacleInsideRoom(o: Obstacle, half: number): boolean {
  if (o.kind === 'cyl') return Math.abs(o.x) + o.r <= half && Math.abs(o.y) + o.r <= half
  return obbInsideRoom(o.x, o.y, o.w / 2, o.h / 2, o.a, half)
}

/** Clamp an obstacle center so the obstacle stays inside the room. Returns a new obstacle. */
export function clampObstacleToRoom(o: Obstacle, half: number): Obstacle {
  const [ex, ey] = o.kind === 'cyl' ? [o.r, o.r] : obbExtents(o.w / 2, o.h / 2, o.a)
  const lx = Math.max(0, half - ex)
  const ly = Math.max(0, half - ey)
  return { ...o, x: Math.max(-lx, Math.min(lx, o.x)), y: Math.max(-ly, Math.min(ly, o.y)) }
}
