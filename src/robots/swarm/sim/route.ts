/*
 * Waypoint route for the formation. A virtual reference point (the "rabbit") moves
 * along the polyline; the leader and the formation slots track it with velocity
 * feed-forward. Its speed profile is acceleration-limited and brakes into every
 * corner to a speed set by the turn angle (the velocity jump 2·v·sin(θ/2) at the
 * corner stays at CORNER_DV), so the reference never asks for an impossible turn.
 * The caller also scales the cruise speed down while the formation lags (lagFactor).
 */

export type RouteMode = 'loop' | 'pingpong' | 'once'

export const ROUTE_MODES: readonly RouteMode[] = ['loop', 'pingpong', 'once']

export function isRouteMode(v: unknown): v is RouteMode {
  return typeof v === 'string' && (ROUTE_MODES as readonly string[]).includes(v)
}

export interface RouteState {
  /** Index of the waypoint being flown to. */
  target: number
  /** Ping-pong direction. */
  dir: 1 | -1
  /** ONCE mode finished at the last waypoint. */
  done: boolean
  /** Reference position (world xy) and velocity. */
  x: number
  y: number
  vx: number
  vy: number
}

export function createRoute(): RouteState {
  return { target: 0, dir: 1, done: false, x: 0, y: 0, vx: 0, vy: 0 }
}

export function resetRoute(st: RouteState, x: number, y: number): void {
  st.target = 0
  st.dir = 1
  st.done = false
  st.x = x
  st.y = y
  st.vx = 0
  st.vy = 0
}

/** Advance the target index after the current waypoint has been reached. */
export function nextTarget(st: RouteState, mode: RouteMode, n: number): void {
  if (n <= 1) {
    st.target = 0
    if (mode === 'once') st.done = true
    return
  }
  if (mode === 'loop') {
    st.target = (st.target + 1) % n
  } else if (mode === 'pingpong') {
    if (st.target + st.dir >= n || st.target + st.dir < 0) st.dir = st.dir === 1 ? -1 : 1
    st.target += st.dir
  } else if (st.target >= n - 1) {
    st.done = true
  } else {
    st.target++
  }
}

/** Reference acceleration limit along the route, m/s². */
export const ROUTE_ACCEL = 1.2
/** Velocity jump the formation absorbs at a corner, m/s (sets the corner speed). */
export const CORNER_DV = 0.6

/** Waypoint after the current target, or -1 when the reference must stop there. */
export function peekNext(st: RouteState, mode: RouteMode, n: number): number {
  if (n <= 1) return -1
  const t = st.target
  if (mode === 'loop') return (t + 1) % n
  if (mode === 'once') return t + 1 < n ? t + 1 : -1
  const k = t + st.dir
  return k >= 0 && k < n ? k : t - st.dir
}

/** Speed allowed through a corner from direction (ax, ay) into (bx, by). */
export function cornerSpeed(ax: number, ay: number, bx: number, by: number, cruise: number): number {
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by)
  if (la < 1e-9 || lb < 1e-9) return cruise
  const c = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)))
  const halfSin = Math.sqrt((1 - c) / 2)
  return halfSin < 1e-6 ? cruise : Math.min(cruise, CORNER_DV / (2 * halfSin))
}

/**
 * Move the reference toward the target waypoint for dt seconds, at most at `speed`.
 * wps holds n waypoints as (x, y) pairs.
 */
export function stepRoute(st: RouteState, wps: Float64Array, n: number, mode: RouteMode, speed: number, dt: number): void {
  if (n === 0 || st.done || dt <= 0) {
    st.vx = 0
    st.vy = 0
    return
  }
  if (st.target >= n) st.target = st.target % n
  const tx = wps[2 * st.target], ty = wps[2 * st.target + 1]
  const dx = tx - st.x, dy = ty - st.y
  const dist = Math.hypot(dx, dy)
  if (dist < 1e-6) {
    nextTarget(st, mode, n)
    if (st.done) {
      st.vx = 0
      st.vy = 0
    }
    return
  }
  const k = peekNext(st, mode, n)
  const vEnd = k < 0 ? 0 : cornerSpeed(dx, dy, wps[2 * k] - tx, wps[2 * k + 1] - ty, speed)
  const vBrake = Math.sqrt(vEnd * vEnd + 2 * ROUTE_ACCEL * dist)
  const v = Math.max(0, Math.min(speed, vBrake, Math.hypot(st.vx, st.vy) + ROUTE_ACCEL * dt))
  const ux = dx / dist, uy = dy / dist
  st.vx = ux * v
  st.vy = uy * v
  const step = v * dt
  if (step >= dist) {
    st.x = tx
    st.y = ty
    nextTarget(st, mode, n)
    if (st.done) {
      st.vx = 0
      st.vy = 0
    }
    return
  }
  st.x += ux * step
  st.y += uy * step
}

/** Reference speed factor from how far the worst-placed drone trails its slot, m (1 = on station). */
export function lagFactor(lag: number): number {
  return Math.min(1, Math.max(0.1, (3 - lag) / 2))
}
