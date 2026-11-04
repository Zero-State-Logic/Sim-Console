import { AGENT_IGNORED, AGENT_MOVING, AGENT_STATIC, DEFAULT_ORCA, orcaVelocities, separationGuard } from './avoidance'
import type { OrcaParams } from './avoidance'
import { airframesTouch } from './collision'
import { DEFAULT_GAINS, DEFAULT_LIMITS, positionLoop } from './controller'
import type { Gains, Limits } from './controller'
import { Drone, TOUCHDOWN_HOLD } from './drone'
import type { Integrator } from './dynamics'
import { formationOffsets, slotWorld } from './formation'
import type { FormationShape } from './formation'
import { clamp, wrapPi } from './frames'
import { thrustToOmega } from './dynamics'
import { mixerGeom } from './mixer'
import type { MixerGeom } from './mixer'
import { QUAD_250, maxMotorThrust } from './params'
import type { QuadParams } from './params'
import { eulerToQuat, quatCosTilt } from './quat'
import { Rng } from './rng'
import { createRoute, lagFactor, resetRoute, stepRoute } from './route'
import type { RouteMode } from './route'
import { WindField } from './wind'
import type { WindSettings } from './wind'

/*
 * The swarm: N quadrotors, a mission state machine, the leader's waypoint route,
 * the virtual-structure formation, reciprocal avoidance and wind.
 *
 * Timing: physics + inner control loops run at the selected rate (500/1000/2000 Hz)
 * from a fixed-step accumulator; guidance (phase logic, route, slots, position
 * loops, ORCA, wind) runs at a fixed 100 Hz inside the same accumulator, exactly
 * like a flight stack's position controller running slower than its rate loop.
 * All positions here are in the sim frame (REP-103, z up); see frames.ts.
 */

export const MIN_DRONES = 3
export const MAX_DRONES = 6
export const MAX_WAYPOINTS = 32
export const GUIDANCE_HZ = 100
/** Half-extent of the flight volume, m (the volume is about 20 m across). */
export const VOLUME_HALF = 10
export const PHYSICS_RATES: readonly number[] = [500, 1000, 2000]
/** Battery percentage that triggers the land-in-place failsafe. */
export const LOW_BATTERY = 10
/** Leader horizontal speed cap as a multiple of the cruise speed (PX4-style 5 % tolerance). */
const LEADER_SPEED_MARGIN = 1.05
const PAD_SPACING = 1.8
const PAD_ROW_Y = -1.5
/** Formation heading slew limit, rad/s. */
const HEADING_RATE = 1.2
/** Fastest sideways swing asked of the outermost slot while the formation turns, m/s. */
const SLOT_SWING = 2.5
const GUARD_DIST = 0.8
const GUARD_GAIN = 1.5
const DESCENT_FAST = 0.9
const DESCENT_SLOW = 0.45
/** HARDWARE mirror: a real drone this close above its gear height counts as on the ground, m. */
const MIRROR_CONTACT = 0.08
/** HARDWARE mirror: a reported coordinate beyond this is malformed telemetry and dropped, m. */
const MIRROR_RANGE = 1000

export type Phase = 'idle' | 'takeoff' | 'mission' | 'landing'

export interface SwarmSettings {
  physicsHz: number
  integrator: Integrator
  shape: FormationShape
  spacing: number
  cruiseAlt: number
  cruiseSpeed: number
  routeMode: RouteMode
  avoid: boolean
  wind: WindSettings
  gains: Gains
}

export function defaultSettings(): SwarmSettings {
  return {
    physicsHz: 1000,
    integrator: 'rk4',
    shape: 'wedge',
    spacing: 2,
    cruiseAlt: 3,
    cruiseSpeed: 2,
    routeMode: 'loop',
    avoid: true,
    wind: { enabled: true, speed: 2, dirDeg: 45, gust: 0.5 },
    gains: { ...DEFAULT_GAINS },
  }
}

/** Default square route, sim-frame xy. */
export const DEFAULT_ROUTE: readonly (readonly [number, number])[] = [[-6, 6], [6, 6], [6, -6], [-6, -6]]

export class SwarmSim {
  readonly params: QuadParams = QUAD_250
  readonly settings: SwarmSettings
  readonly limits: Limits = { ...DEFAULT_LIMITS }
  readonly orca: OrcaParams = { ...DEFAULT_ORCA }
  drones: Drone[] = []

  readonly waypoints = new Float64Array(2 * MAX_WAYPOINTS)
  wpCount = 0
  /** Bumped whenever the waypoint list changes (the scene rebuilds markers). */
  wpRevision = 0
  readonly route = createRoute()
  phase: Phase = 'idle'
  leaderId = -1
  /** Formation heading, rad (CCW from +x). */
  heading = 0
  /** Heading rate applied in the last guidance step, rad/s (slot velocity feed-forward). */
  headingRate = 0
  t = 0
  flightTime = 0

  /* metrics */
  formationRms = 0
  minSeparation = 0
  loopHz = 0
  autoFlying = 0

  private readonly rng = new Rng(1)
  readonly wind = new WindField(this.rng, MAX_DRONES)
  readonly offsets = new Float64Array(2 * MAX_DRONES)
  private readonly geom: MixerGeom
  private readonly pos = new Float64Array(3 * MAX_DRONES)
  private readonly vel = new Float64Array(3 * MAX_DRONES)
  private readonly pref = new Float64Array(3 * MAX_DRONES)
  private readonly vout = new Float64Array(3 * MAX_DRONES)
  private readonly mask = new Uint8Array(MAX_DRONES)
  private readonly tmp3 = new Float64Array(3)
  private readonly tmp2 = new Float64Array(2)
  private readonly leaderVel = new Float64Array(2)
  private acc = 0
  private gAcc = 0

  constructor(n = 4, settings: SwarmSettings = defaultSettings()) {
    this.settings = settings
    this.geom = mixerGeom(this.params)
    this.rebuild(n)
    this.setDefaultRoute()
  }

  get count(): number {
    return this.drones.length
  }

  get leader(): Drone | null {
    return this.leaderId >= 0 ? this.drones[this.leaderId] ?? null : null
  }

  /** Replace the fleet with n drones parked on their pads. */
  rebuild(n: number): void {
    const count = Math.round(clamp(n, MIN_DRONES, MAX_DRONES))
    this.drones = Array.from({ length: count }, (_, i) => new Drone(i))
    this.reset()
  }

  /** Everything back on the pads, full batteries, same waypoints and settings. */
  reset(): void {
    const n = this.drones.length
    for (const d of this.drones) {
      const pad = padXY(d.id, n)
      d.placeOnGround(pad[0], pad[1], 0, this.params)
    }
    this.phase = 'idle'
    this.leaderId = -1
    this.heading = 0
    this.headingRate = 0
    this.t = 0
    this.flightTime = 0
    this.acc = 0
    this.gAcc = 0
    this.leaderVel.fill(0)
    this.rng.reseed(1)
    this.wind.reset()
    resetRoute(this.route, 0, 0)
    this.formationRms = 0
    this.minSeparation = this.computeMinDistance()
  }

  /* ---------------- commands ---------------- */

  takeoff(): void {
    if (this.phase === 'idle') this.flightTime = 0
    for (const d of this.drones) d.arm()
    if (this.phase !== 'mission') this.phase = 'takeoff'
  }

  land(): void {
    for (const d of this.drones) {
      d.manual = false
      d.beginLanding()
    }
    this.phase = 'landing'
  }

  /** CODE source: fly drone `id` to an explicit sim-frame target (arms it if parked). */
  setManualTarget(id: number, x: number, y: number, z: number): void {
    const d = this.drones[id]
    if (!d || d.mode === 'crashed') return
    d.manualTarget[0] = clamp(x, -3 * VOLUME_HALF, 3 * VOLUME_HALF)
    d.manualTarget[1] = clamp(y, -3 * VOLUME_HALF, 3 * VOLUME_HALF)
    d.manualTarget[2] = clamp(z, 0, 2 * VOLUME_HALF)
    d.manual = true
    if (d.mode !== 'flying') d.arm()
  }

  setYawOverride(id: number, yaw: number | null): void {
    const d = this.drones[id]
    if (d) d.yawOverride = yaw === null ? null : wrapPi(yaw)
  }

  clearManual(): void {
    for (const d of this.drones) {
      d.manual = false
      d.yawOverride = null
    }
  }

  addWaypoint(x: number, y: number): boolean {
    if (this.wpCount >= MAX_WAYPOINTS || !Number.isFinite(x + y)) return false
    this.waypoints[2 * this.wpCount] = clamp(x, -VOLUME_HALF, VOLUME_HALF)
    this.waypoints[2 * this.wpCount + 1] = clamp(y, -VOLUME_HALF, VOLUME_HALF)
    this.wpCount++
    this.wpRevision++
    if (this.route.done) {
      this.route.done = false
      this.route.target = this.wpCount - 1
    }
    return true
  }

  /** Index of the waypoint nearest (x, y) within radius, or -1. */
  nearestWaypoint(x: number, y: number, radius: number): number {
    let best = -1
    let bestD = radius
    for (let i = 0; i < this.wpCount; i++) {
      const d = Math.hypot(this.waypoints[2 * i] - x, this.waypoints[2 * i + 1] - y)
      if (d <= bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  /** Move waypoint i to (x, y), clamped to the volume. */
  moveWaypoint(i: number, x: number, y: number): boolean {
    if (!Number.isInteger(i) || i < 0 || i >= this.wpCount || !Number.isFinite(x + y)) return false
    this.waypoints[2 * i] = clamp(x, -VOLUME_HALF, VOLUME_HALF)
    this.waypoints[2 * i + 1] = clamp(y, -VOLUME_HALF, VOLUME_HALF)
    this.wpRevision++
    return true
  }

  removeWaypoint(i: number): boolean {
    if (!Number.isInteger(i) || i < 0 || i >= this.wpCount) return false
    this.waypoints.copyWithin(2 * i, 2 * i + 2, 2 * this.wpCount)
    this.wpCount--
    if (this.route.target > i) this.route.target--
    if (this.route.target >= this.wpCount) this.route.target = 0
    this.wpRevision++
    return true
  }

  /** Remove the waypoint nearest (x, y) within radius. */
  removeNearestWaypoint(x: number, y: number, radius: number): boolean {
    return this.removeWaypoint(this.nearestWaypoint(x, y, radius))
  }

  clearWaypoints(): void {
    this.wpCount = 0
    this.wpRevision++
    resetRoute(this.route, this.route.x, this.route.y)
  }

  setWaypoints(list: readonly (readonly [number, number])[]): void {
    this.wpCount = 0
    for (const [x, y] of list) {
      if (this.wpCount >= MAX_WAYPOINTS) break
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      this.waypoints[2 * this.wpCount] = clamp(x, -VOLUME_HALF, VOLUME_HALF)
      this.waypoints[2 * this.wpCount + 1] = clamp(y, -VOLUME_HALF, VOLUME_HALF)
      this.wpCount++
    }
    this.wpRevision++
    resetRoute(this.route, this.route.x, this.route.y)
  }

  setDefaultRoute(): void {
    this.setWaypoints(DEFAULT_ROUTE)
  }

  /* ---------------- stepping ---------------- */

  /**
   * Seconds of frame time not yet simulated (0 .. one substep). Drawing positions at
   * s + v·renderLead removes the 16/17-substeps-per-frame aliasing that otherwise makes
   * fast drones saw back and forth by a few mm per frame; exact to O(a·h²) ≈ 10 µm.
   */
  get renderLead(): number {
    return Math.min(Math.max(this.acc, 0), 1 / this.settings.physicsHz)
  }

  /** Advance the simulation by dt seconds. Returns the number of physics substeps run. */
  advance(dt: number): number {
    if (!(dt > 0)) return 0
    const hz = this.settings.physicsHz
    const h = 1 / hz
    const gDt = 1 / GUIDANCE_HZ
    const maxSteps = Math.ceil(0.12 * hz)
    this.acc += dt
    let steps = 0
    while (this.acc >= h && steps < maxSteps) {
      if (this.gAcc <= 1e-12) {
        this.guidance(gDt, false)
        this.gAcc += gDt
      }
      this.substep(h)
      this.gAcc -= h
      this.acc -= h
      this.t += h
      steps++
    }
    if (steps >= maxSteps) this.acc = 0
    const rate = steps / dt
    this.loopHz = this.loopHz > 0 ? this.loopHz + (rate - this.loopHz) * 0.1 : rate
    return steps
  }

  private substep(h: number): void {
    const p = this.params
    const st = this.settings
    for (const d of this.drones) {
      d.controlStep(h, p, st.gains, this.limits, this.geom)
      d.physicsStep(h, p, st.integrator, this.geom)
    }
  }

  /**
   * HARDWARE source: the drones are real (mirrored from telemetry), so only the
   * mission and guidance layers run; their targets become the outbound setpoints.
   */
  advanceMirror(dt: number): void {
    if (!(dt > 0)) return
    const gear = this.params.gearHeight
    for (const d of this.drones) {
      d.contact = d.s[2] < gear + MIRROR_CONTACT
      d.contactTime = d.contact ? d.contactTime + dt : 0
      this.mirrorRotors(d)
    }
    this.t += dt
    this.guidance(dt, true)
    this.loopHz = 0
  }

  /**
   * Rotor state is not on the wire, so the mirror estimates it for the visuals and the
   * THRUST bars: an airborne drone carries its weight along its tilted body axis
   * (T = m·g / cos tilt, split evenly), an armed one on the ground idles.
   */
  private mirrorRotors(d: Drone): void {
    const p = this.params
    let perMotor = 0
    if (d.armed && !d.contact) perMotor = (p.mass * p.g) / (4 * Math.max(0.3, quatCosTilt(d.s, 6)))
    else if (d.armed) perMotor = p.idleFrac * maxMotorThrust(p)
    const w = thrustToOmega(perMotor, p)
    for (let i = 0; i < 4; i++) {
      d.omega[i] = w
      d.omegaCmd[i] = w
      d.thrust[i] = p.kT * w * w
    }
  }

  /**
   * HARDWARE source entered. The real drones take over, so the mission layer stands
   * down: nothing is armed and no setpoint goes out for a drone until its first
   * telemetry sample arrives (buildSwarmCommand skips unmirrored drones). A real
   * drone therefore holds where it is until the user presses TAKEOFF.
   */
  enterMirror(): void {
    for (const d of this.drones) {
      d.mirrorT = -1
      d.standDown()
    }
    this.phase = 'idle'
    this.leaderId = -1
    this.autoFlying = 0
    this.loopHz = 0
  }

  /**
   * Mirror one real drone's telemetry (sim frame, radians, battery %). A board that
   * reports its feet on the ground (z = 0) is held at gear height, like a parked sim drone.
   */
  mirrorDrone(id: number, x: number, y: number, zIn: number, roll: number, pitch: number, yaw: number, bat?: number): void {
    const d = this.drones[id]
    // the sum is finite only when every term is (NaN and ±Infinity propagate); no allocation
    if (!d || !Number.isFinite(x + y + zIn + roll + pitch + yaw)) return
    // reject (never clamp) nonsense positions: a clamped one could become a landing anchor
    if (Math.abs(x) > MIRROR_RANGE || Math.abs(y) > MIRROR_RANGE || Math.abs(zIn) > MIRROR_RANGE) return
    const z = Math.max(zIn, this.params.gearHeight)
    const s = d.s
    const dt = this.t - d.mirrorT
    if (d.mirrorT >= 0 && dt > 1e-3) {
      const a = Math.min(1, dt / 0.15)
      s[3] += ((x - s[0]) / dt - s[3]) * a
      s[4] += ((y - s[1]) / dt - s[4]) * a
      s[5] += ((z - s[2]) / dt - s[5]) * a
    }
    d.mirrorT = this.t
    s[0] = x
    s[1] = y
    s[2] = z
    eulerToQuat(s, 6, roll, pitch, yaw)
    // body rates are not on the wire; stale sim rates must not survive a hand-back
    s[10] = 0
    s[11] = 0
    s[12] = 0
    if (bat !== undefined && Number.isFinite(bat)) d.battery.reset(bat / 100)
  }

  /** Recompute leader, targets and metrics without advancing time (after a restore). */
  refreshGuidance(): void {
    this.autoFlying = this.countAutoFlying()
    this.pickLeader()
    this.assignTargets()
    this.updateMetrics(0)
  }

  private countAutoFlying(): number {
    let n = 0
    for (const d of this.drones) if (d.mode === 'flying' && !d.manual) n++
    return n
  }

  /** Spin every airborne drone up to hover when control returns from HARDWARE. */
  resumeFromMirror(): void {
    for (const d of this.drones) {
      d.mirrorT = -1
      if (d.s[2] <= this.params.gearHeight + MIRROR_CONTACT) continue
      // airborne in the real world: the sim keeps it flying instead of dropping it
      if (!d.armed) d.arm()
      d.primeHover(this.params)
    }
  }

  /* ---------------- guidance (100 Hz) ---------------- */

  private guidance(dt: number, mirror: boolean): void {
    this.updateModes()
    this.updatePhase()
    this.pickLeader()
    this.updateRoute(dt)
    this.updateHeading(dt)
    this.assignTargets()
    this.velocitySetpoints()
    if (!mirror) this.checkCollisions()
    this.updateWind(dt)
    this.updateMetrics(dt)
  }

  /** Touchdown detection and the low-battery failsafe. */
  private updateModes(): void {
    for (const d of this.drones) {
      if (d.mode === 'landing' && d.contact && d.contactTime > TOUCHDOWN_HOLD) d.disarm()
      if (d.mode === 'flying' && d.battery.percent < LOW_BATTERY) {
        d.lowBattery = true
        d.manual = false
        d.beginLanding()
      }
    }
  }

  private updatePhase(): void {
    let auto = 0
    let landing = 0
    let atAlt = 0
    for (const d of this.drones) {
      if (d.mode === 'landing') landing++
      if (d.mode !== 'flying' || d.manual) continue
      auto++
      if (Math.abs(d.s[2] - this.settings.cruiseAlt) < 0.3) atAlt++
    }
    this.autoFlying = auto
    const ph = this.phase
    if (ph === 'takeoff' && auto > 0 && atAlt === auto) this.beginMission()
    else if ((ph === 'takeoff' || ph === 'mission') && auto === 0) this.phase = landing > 0 ? 'landing' : 'idle'
    else if (ph === 'landing' && landing === 0 && auto === 0) this.phase = 'idle'
    else if (ph === 'idle' && auto > 0) this.beginMission()
  }

  /** Reference starts on the leader; the structure faces the first waypoint from the start. */
  private beginMission(): void {
    this.phase = 'mission'
    this.pickLeader()
    const l = this.leader
    const x = l ? l.s[0] : 0
    const y = l ? l.s[1] : 0
    resetRoute(this.route, x, y)
    this.leaderVel.fill(0)
    this.headingRate = 0
    if (this.wpCount === 0) return
    const dx = this.waypoints[0] - x, dy = this.waypoints[1] - y
    if (Math.hypot(dx, dy) > 0.5) this.heading = Math.atan2(dy, dx)
  }

  private pickLeader(): void {
    this.leaderId = -1
    for (const d of this.drones) {
      if (d.mode === 'flying' && !d.manual) {
        this.leaderId = d.id
        return
      }
    }
  }

  /**
   * Move the structure's reference point along the route. Formation feedback: the
   * reference slows down while the worst-placed drone lags its slot (the virtual
   * structure waits for its members), so corners and gusts do not tear it apart.
   */
  private updateRoute(dt: number): void {
    const l = this.leader
    if (this.phase !== 'mission' || !l) {
      this.route.vx = 0
      this.route.vy = 0
      if (l && this.phase === 'takeoff') {
        this.route.x = l.s[0]
        this.route.y = l.s[1]
      }
      return
    }
    let lag = Math.hypot(l.s[0] - this.route.x, l.s[1] - this.route.y)
    for (const d of this.drones) if (d.mode === 'flying' && !d.manual && d.trackErr > lag) lag = d.trackErr
    const st = this.settings
    stepRoute(this.route, this.waypoints, this.wpCount, st.routeMode, st.cruiseSpeed * lagFactor(lag), dt)
  }

  /**
   * Formation heading follows the leader's (low-passed) velocity, slew-limited so the
   * outermost slot never has to swing faster than SLOT_SWING m/s.
   */
  private updateHeading(dt: number): void {
    this.headingRate = 0
    const l = this.leader
    if (!l || !(dt > 0)) return
    const a = 1 - Math.exp(-dt / 0.3)
    this.leaderVel[0] += (l.s[3] - this.leaderVel[0]) * a
    this.leaderVel[1] += (l.s[4] - this.leaderVel[1]) * a
    if (Math.hypot(this.leaderVel[0], this.leaderVel[1]) < 0.4) return
    const err = wrapPi(Math.atan2(this.leaderVel[1], this.leaderVel[0]) - this.heading)
    const m = this.maxHeadingRate() * dt
    const step = clamp(err, -m, m)
    this.heading = wrapPi(this.heading + step)
    this.headingRate = step / dt
  }

  /** Slew limit for the formation heading, rad/s, from the structure's radius. */
  private maxHeadingRate(): number {
    let r = 0
    const n = Math.max(this.autoFlying, 1)
    for (let k = 1; k < n; k++) r = Math.max(r, Math.hypot(this.offsets[2 * k], this.offsets[2 * k + 1]))
    return r > 1e-6 ? Math.min(HEADING_RATE, SLOT_SWING / r) : HEADING_RATE
  }

  private assignTargets(): void {
    const st = this.settings
    const alt = st.cruiseAlt
    const l = this.leader
    formationOffsets(this.offsets, st.shape, Math.max(this.autoFlying, 1), st.spacing)
    let slot = 0
    for (const d of this.drones) {
      const tg = d.target
      d.targetVel.fill(0)
      d.yawSp = d.yawOverride ?? this.heading
      if (!d.armed) {
        tg[0] = d.s[0]
        tg[1] = d.s[1]
        tg[2] = d.s[2]
      } else if (d.mode === 'landing') {
        tg[0] = d.anchor[0]
        tg[1] = d.anchor[1]
        tg[2] = this.params.gearHeight
      } else if (d.manual) {
        tg.set(d.manualTarget)
      } else if (this.phase === 'takeoff' || !l) {
        tg[0] = d.anchor[0]
        tg[1] = d.anchor[1]
        tg[2] = alt
      } else {
        this.slotTarget(d, slot++, alt)
      }
    }
  }

  /**
   * Virtual structure: slot k sits at the route reference plus the offset rotated by
   * the heading (slot 0, the leader's, is the reference itself). The slot velocity is
   * fed forward: structure translation plus rotation, v + ω × r.
   */
  private slotTarget(d: Drone, slot: number, alt: number): void {
    const tg = d.target
    const r = this.route
    slotWorld(this.tmp2, this.offsets, slot, r.x, r.y, this.heading)
    tg[0] = this.tmp2[0]
    tg[1] = this.tmp2[1]
    tg[2] = alt
    d.targetVel[0] = r.vx - this.headingRate * (tg[1] - r.y)
    d.targetVel[1] = r.vy + this.headingRate * (tg[0] - r.x)
  }

  /** Position loops -> preferred velocities -> ORCA + separation guard -> setpoints. */
  private velocitySetpoints(): void {
    const st = this.settings
    const lim = this.limits
    lim.maxVelXY = clamp(st.cruiseSpeed * 1.6 + 1, 2.5, 10)
    this.orca.maxSpeed = lim.maxVelXY + 0.5
    const n = this.drones.length
    for (const d of this.drones) this.preferredVelocity(d)
    if (st.avoid) {
      orcaVelocities(this.vout, this.pos, this.vel, this.pref, this.mask, n, this.orca)
      this.minSeparation = separationGuard(this.vout, this.pos, this.mask, n, GUARD_DIST, GUARD_GAIN)
    } else {
      this.vout.set(this.pref)
      this.minSeparation = this.computeMinDistance()
    }
    // the leader sets the route pace: like a mission cruise-speed limit on a real flight
    // controller it never exceeds it (followers keep the headroom to catch their slots)
    const leaderMax = st.cruiseSpeed * LEADER_SPEED_MARGIN
    for (const d of this.drones) {
      if (!d.armed) continue
      const i3 = 3 * d.id
      let vx = this.vout[i3]
      let vy = this.vout[i3 + 1]
      const h = Math.hypot(vx, vy)
      if (d.id === this.leaderId && !d.manual && this.phase === 'mission' && h > leaderMax) {
        vx *= leaderMax / h
        vy *= leaderMax / h
      }
      d.vSp[0] = vx
      d.vSp[1] = vy
      d.vSp[2] = clamp(this.vout[i3 + 2], -lim.maxVelDown, lim.maxVelUp)
    }
  }

  private preferredVelocity(d: Drone): void {
    const i3 = 3 * d.id
    const s = d.s
    for (let a = 0; a < 3; a++) {
      this.pos[i3 + a] = s[a]
      this.vel[i3 + a] = s[3 + a]
      this.pref[i3 + a] = 0
    }
    if (!d.armed) {
      this.mask[d.id] = d.contact ? AGENT_STATIC : AGENT_IGNORED
      return
    }
    this.mask[d.id] = AGENT_MOVING
    if (d.mode === 'landing') {
      const kp = this.settings.gains.posP
      let vx = kp * (d.anchor[0] - s[0])
      let vy = kp * (d.anchor[1] - s[1])
      const h = Math.hypot(vx, vy)
      if (h > 1) { vx /= h; vy /= h }
      this.pref[i3] = vx
      this.pref[i3 + 1] = vy
      this.pref[i3 + 2] = s[2] > 1.2 ? -DESCENT_FAST : -DESCENT_SLOW
      return
    }
    positionLoop(this.tmp3, s, d.target, d.targetVel, this.settings.gains, this.limits)
    this.pref[i3] = this.tmp3[0]
    this.pref[i3 + 1] = this.tmp3[1]
    this.pref[i3 + 2] = this.tmp3[2]
  }

  /** Airframes that touch props (with their real attitudes, see collision.ts) both go down. */
  private checkCollisions(): void {
    const ds = this.drones
    const p = this.params
    for (let i = 0; i < ds.length; i++) {
      for (let j = i + 1; j < ds.length; j++) {
        const a = ds[i], b = ds[j]
        if (a.mode === 'crashed' || b.mode === 'crashed' || (!a.airborne && !b.airborne)) continue
        if (!airframesTouch(a.s, b.s, p.armLength, p.propRadius)) continue
        a.crash(`collision with D${b.id + 1}`, this.params)
        b.crash(`collision with D${a.id + 1}`, this.params)
      }
    }
  }

  private updateWind(dt: number): void {
    const n = this.drones.length
    this.wind.step(dt, this.settings.wind, n)
    for (const d of this.drones) this.wind.sample(d.wind, d.id)
  }

  private updateMetrics(dt: number): void {
    let sum = 0
    let cnt = 0
    let armed = false
    for (const d of this.drones) {
      if (d.armed) armed = true
      if (d.mode !== 'flying') {
        d.trackErr = 0
        continue
      }
      const s = d.s, tg = d.target
      d.trackErr = Math.hypot(s[0] - tg[0], s[1] - tg[1], s[2] - tg[2])
      // every structure member counts, the leader's slot (the route reference) included
      if (!d.manual) {
        sum += d.trackErr * d.trackErr
        cnt++
      }
    }
    this.formationRms = cnt > 0 ? Math.sqrt(sum / cnt) : 0
    if (armed) this.flightTime += dt
  }

  computeMinDistance(): number {
    let m = Infinity
    const ds = this.drones
    for (let i = 0; i < ds.length; i++) {
      for (let j = i + 1; j < ds.length; j++) {
        const a = ds[i].s, b = ds[j].s
        m = Math.min(m, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))
      }
    }
    return m
  }
}

/** Landing pad of drone i out of n, sim-frame xy. */
export function padXY(i: number, n: number): [number, number] {
  return [(i - (n - 1) / 2) * PAD_SPACING, PAD_ROW_Y]
}
