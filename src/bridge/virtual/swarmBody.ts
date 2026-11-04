import type { CmdMsg, DroneTel, TelMsg } from '../../core/protocol'
import type { HardwareSpec } from '../../core/types'
import { DEG, G, clamp, r1, r2, r3, type BodyHost, type DriveMode, type VirtualBody } from './common'
import type { Rng } from './random'

/* ============================================================
   VIRTUAL SWARM — each quadrotor as a thrust-vectored point mass:
   what a drone's own flight controller presents to a ground
   station. Frame = the wire frame: three.js Y-up, meters.
   Position loop (critically damped):  a = wn²(sp − p) − 2·wn·v.
   The rotors supply f = a + g·ŷ + c·v (drag feed-forward), with the
   vertical part kept ≥ 0.3 g and the thrust tilted at most 30°, and
   the attitude is the one that points the thrust along f, REP-103 ZYX:
       pitch = atan2(f_fwd, f_up)      roll = −asin(f_left / |f|)
   Battery: hover power ∝ T^1.5 (momentum theory), so the drain
   scales with (|f|/g)^1.5. On the wire each drone's bat is its 1S
   cell voltage through a typical LiPo discharge curve (the swarm
   module maps it back to percent). E-STOP cuts the motors: the
   drone falls. HOME holds position (firmware robotHomeStart sends
   kPktHold); the relax watchdog lands in place (kPktLand).
   ============================================================ */

const WN = 2.2
const TAN_MAX_TILT = Math.tan((30 * Math.PI) / 180)
const A_UP_MAX = 0.8 * G
/** Thrust only pushes up, so a commanded descent stays well short of free fall. */
const A_DOWN_MAX = 0.7 * G
const VMAX = 3
/** Linear aerodynamic drag per unit mass, 1/s. */
const DRAG = 0.35
const MAX_ALT = 30
const MAX_RANGE = 50
/** Watchdog relax (and a flat battery): descend in place at this rate, m/s. */
const LAND_SPEED = 0.4
const SPACING = 0.6
const YAW_TAU = 0.3
/** At or below this height, with the setpoint on the ground too, a drone is landed and disarmed. */
const GROUND_EPS = 0.03
/** Full to empty in about 8 minutes of hover. */
const HOVER_DRAIN_PCT_S = 100 / 480
const IDLE_DRAIN_PCT_S = 0.002
/** LiPo resting voltage per cell vs state of charge, [volts, percent] (typical curve). */
const CELL_CURVE: readonly (readonly [number, number])[] = [
  [3.3, 0], [3.5, 5], [3.68, 20], [3.74, 40], [3.8, 55], [3.87, 70], [3.95, 80], [4.05, 90], [4.2, 100],
]
/** Thrust below this (per unit mass) is "motors off": the attitude is not re-derived. */
const MIN_THRUST = 0.5

/** State of charge (percent) → resting cell voltage, piecewise linear on CELL_CURVE. */
export function cellVolts(pct: number): number {
  const p = clamp(pct, 0, 100)
  for (let i = 1; i < CELL_CURVE.length; i++) {
    const [v1, p1] = CELL_CURVE[i]
    if (p <= p1) {
      const [v0, p0] = CELL_CURVE[i - 1]
      return v0 + ((p - p0) / (p1 - p0)) * (v1 - v0)
    }
  }
  return CELL_CURVE[CELL_CURVE.length - 1][0]
}

export class SwarmBody implements VirtualBody {
  readonly caps = ['imu', 'multi-drone', 'thrust-vector']
  readonly estopNote = 'motors cut, drones fall'
  private readonly n: number
  private readonly p: Float64Array
  private readonly v: Float64Array
  /** Specific thrust (thrust / mass) per drone, m/s². */
  private readonly f: Float64Array
  private readonly sp: Float64Array
  private readonly yaw: Float64Array
  private readonly yawT: Float64Array
  private readonly roll: Float64Array
  private readonly pitch: Float64Array
  /** Battery, percent. */
  private readonly bat: Float64Array
  private readonly flat: Uint8Array
  private mode: DriveMode = 'hold'

  constructor(spec: HardwareSpec, private readonly rng: Rng, private readonly host: BodyHost) {
    const n = spec.drones ?? spec.joints
    this.n = n
    this.p = new Float64Array(3 * n)
    this.v = new Float64Array(3 * n)
    this.f = new Float64Array(3 * n)
    this.sp = new Float64Array(3 * n)
    this.yaw = new Float64Array(n)
    this.yawT = new Float64Array(n)
    this.roll = new Float64Array(n)
    this.pitch = new Float64Array(n)
    this.bat = new Float64Array(n).fill(100)
    this.flat = new Uint8Array(n)
    // parked in a row on the ground, like drones on their pads
    for (let i = 0; i < n; i++) this.p[3 * i] = (i - (n - 1) / 2) * SPACING
    this.sp.set(this.p)
  }

  command(cmd: CmdMsg): void {
    if (!cmd.sp) {
      if (cmd.q || cmd.v || cmd.w) this.host.warn('nosp', 'swarm firmware expects drone setpoints (sp)')
      return
    }
    for (const d of cmd.sp) {
      if (!Number.isInteger(d.id) || d.id < 0 || d.id >= this.n) {
        this.host.warn('spid', `setpoint for unknown drone id ${d.id}`)
        continue
      }
      const [x, y, z] = d.p
      const cx = clamp(x, -MAX_RANGE, MAX_RANGE)
      const cy = clamp(y, 0, MAX_ALT)
      const cz = clamp(z, -MAX_RANGE, MAX_RANGE)
      if (cx !== x || cy !== y || cz !== z) this.host.warn(`spclamp${d.id}`, `drone ${d.id} setpoint clamped to the flight volume`)
      if (this.flat[d.id] && cy > GROUND_EPS) {
        this.host.warn(`flat${d.id}`, `drone ${d.id + 1} battery empty: setpoint ignored, landing`)
        continue
      }
      const k = 3 * d.id
      this.sp[k] = cx
      this.sp[k + 1] = cy
      this.sp[k + 2] = cz
      if (d.yaw !== undefined && Number.isFinite(d.yaw)) this.yawT[d.id] = d.yaw / DEG
    }
  }

  /** HOME = the generated firmware's robotHomeStart (setSafe(kPktHold)): every drone holds where it is. */
  beginHome(): void {
    this.sp.set(this.p)
  }

  homeProgress(): void {}

  setMode(mode: DriveMode): void {
    this.mode = mode
    if (mode === 'hold') this.sp.set(this.p)
  }

  step(dt: number): void {
    if (dt <= 0) return
    const descend = this.mode === 'relax'
    for (let i = 0; i < this.n; i++) {
      const k = 3 * i
      if (descend || this.flat[i]) this.sp[k + 1] = Math.max(0, this.sp[k + 1] - LAND_SPEED * dt)
      if (this.mode === 'frozen') this.fall(k, dt)
      else if (this.p[k + 1] <= GROUND_EPS && this.sp[k + 1] <= GROUND_EPS) this.park(k)
      else this.fly(k, dt)
      this.attitude(i, k)
      const dy = Math.atan2(Math.sin(this.yawT[i] - this.yaw[i]), Math.cos(this.yawT[i] - this.yaw[i]))
      this.yaw[i] += dy * (1 - Math.exp(-dt / YAW_TAU))
      this.drain(i, k, dt)
    }
  }

  telemetry(tel: TelMsg): void {
    const drones = new Array<DroneTel>(this.n)
    let vsum = 0
    for (let i = 0; i < this.n; i++) {
      const k = 3 * i
      const cell = cellVolts(this.bat[i])
      drones[i] = {
        id: i,
        p: [r3(this.p[k]), r3(this.p[k + 1]), r3(this.p[k + 2])],
        att: [r1(this.roll[i] * DEG), r1(this.pitch[i] * DEG), r1(wrapDeg(this.yaw[i] * DEG))],
        bat: r3(cell),
      }
      vsum += cell
    }
    tel.drones = drones
    tel.imu = [r2(this.rng.gauss(0.1)), r2(this.rng.gauss(0.1)), 0]
    tel.vbat = r2(this.n > 0 ? vsum / this.n : 0)
  }

  /** Test hook: position of drone i, world y-up. */
  position(i: number): [number, number, number] {
    return [this.p[3 * i], this.p[3 * i + 1], this.p[3 * i + 2]]
  }

  /** Test hook: [roll, pitch] of drone i, radians, REP-103. */
  attitudeOf(i: number): [number, number] {
    return [this.roll[i], this.pitch[i]]
  }

  /** Test hook: battery percent of drone i. */
  battery(i: number): number {
    return this.bat[i]
  }

  /* ---------------- dynamics ---------------- */

  private fly(k: number, dt: number): void {
    const { p, v, sp, f } = this
    const ay = clamp(WN * WN * (sp[k + 1] - p[k + 1]) - 2 * WN * v[k + 1], -A_DOWN_MAX, A_UP_MAX)
    // thrust = command + gravity + drag feed-forward; the tilt cap applies to the thrust itself
    const fUp = ay + G + DRAG * v[k + 1]
    let fx = WN * WN * (sp[k] - p[k]) - 2 * WN * v[k] + DRAG * v[k]
    let fz = WN * WN * (sp[k + 2] - p[k + 2]) - 2 * WN * v[k + 2] + DRAG * v[k + 2]
    const fh = Math.hypot(fx, fz)
    const fhMax = fUp * TAN_MAX_TILT
    if (fh > fhMax) {
      fx *= fhMax / fh
      fz *= fhMax / fh
    }
    f[k] = fx
    f[k + 1] = fUp
    f[k + 2] = fz
    v[k] += (fx - DRAG * v[k]) * dt
    v[k + 1] += ay * dt
    v[k + 2] += (fz - DRAG * v[k + 2]) * dt
    const speed = Math.hypot(v[k], v[k + 1], v[k + 2])
    if (speed > VMAX) {
      const s = VMAX / speed
      v[k] *= s
      v[k + 1] *= s
      v[k + 2] *= s
    }
    this.integrate(k, dt)
  }

  /** Motors off: gravity and drag only, until the ground stops it. */
  private fall(k: number, dt: number): void {
    const { v, f } = this
    v[k] -= DRAG * v[k] * dt
    v[k + 1] -= (G + DRAG * v[k + 1]) * dt
    v[k + 2] -= DRAG * v[k + 2] * dt
    f[k] = 0
    f[k + 1] = 0
    f[k + 2] = 0
    this.integrate(k, dt)
  }

  /** Landed and disarmed: sits still on the ground. */
  private park(k: number): void {
    this.p[k + 1] = 0
    this.v[k] = 0
    this.v[k + 1] = 0
    this.v[k + 2] = 0
    this.f[k] = 0
    this.f[k + 1] = 0
    this.f[k + 2] = 0
  }

  private integrate(k: number, dt: number): void {
    const { p, v } = this
    p[k] += v[k] * dt
    p[k + 1] += v[k + 1] * dt
    p[k + 2] += v[k + 2] * dt
    if (p[k + 1] < 0) {
      // ground contact: no penetration, friction stops the slide
      p[k + 1] = 0
      v[k] = 0
      v[k + 1] = Math.max(0, v[k + 1])
      v[k + 2] = 0
    }
  }

  private attitude(i: number, k: number): void {
    const fx = this.f[k]
    const fy = this.f[k + 1]
    const fz = this.f[k + 2]
    const fm = Math.hypot(fx, fy, fz)
    if (fm < MIN_THRUST) {
      if (this.p[k + 1] <= 0) {
        this.roll[i] = 0
        this.pitch[i] = 0
      }
      return
    }
    const c = Math.cos(this.yaw[i])
    const s = Math.sin(this.yaw[i])
    // heading frame in Y-up world: forward (cos ψ, 0, −sin ψ), left (−sin ψ, 0, −cos ψ)
    const fFwd = fx * c - fz * s
    const fLeft = -fx * s - fz * c
    this.pitch[i] = Math.atan2(fFwd, fy)
    this.roll[i] = -Math.asin(clamp(fLeft / fm, -1, 1))
  }

  private drain(i: number, k: number, dt: number): void {
    const t = Math.hypot(this.f[k], this.f[k + 1], this.f[k + 2]) / G
    const rate = t > 0 ? HOVER_DRAIN_PCT_S * t ** 1.5 : IDLE_DRAIN_PCT_S
    const before = this.bat[i]
    this.bat[i] = Math.max(0, before - rate * dt)
    if (before > 0 && this.bat[i] === 0) {
      this.flat[i] = 1
      this.host.warn(`flat${i}`, `drone ${i + 1} battery empty: forced landing`)
    }
  }
}

function wrapDeg(a: number): number {
  const w = ((a + 180) % 360 + 360) % 360 - 180
  return w === -180 ? 180 : w
}
