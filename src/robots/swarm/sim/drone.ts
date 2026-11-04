import { Battery } from './battery'
import { CascadeController } from './controller'
import type { Gains, Limits } from './controller'
import { STATE_LEN, Q, integrate, stepMotors, thrustToOmega } from './dynamics'
import type { Integrator } from './dynamics'
import type { MixerGeom } from './mixer'
import { unmix } from './mixer'
import type { QuadParams } from './params'
import { hoverOmega } from './params'
import { eulerToQuat, quatCosTilt, quatYaw } from './quat'

/*
 * One quadrotor: rigid-body state, motors, controller, battery and ground contact.
 * Ground model: the landing gear holds the airframe at gearHeight; while the lift
 * cannot carry the weight the gear pins it (no sinking, attitude levels out). A hard
 * touchdown or a big tilt at contact is a crash: motors cut, the airframe tips over.
 */

export type DroneMode = 'landed' | 'flying' | 'landing' | 'crashed'

/** Touchdown faster than this (m/s) is a crash. */
export const CRASH_SPEED = 3
/** Touchdown tilted more than this is a crash. */
const COS_CRASH_TILT = Math.cos((60 * Math.PI) / 180)
/** Seconds of continuous ground contact that count as "landed". */
export const TOUCHDOWN_HOLD = 0.4
/** Position magnitude beyond which the state is treated as diverged. */
const DIVERGED = 1000

export class Drone {
  readonly s = new Float64Array(STATE_LEN)
  readonly omega = new Float64Array(4)
  readonly omegaCmd = new Float64Array(4)
  /** Actual rotor thrusts, N. */
  readonly thrust = new Float64Array(4)
  /** Commanded rotor thrusts from the mixer, N. */
  readonly thrustCmd = new Float64Array(4)
  /** [T, τx, τy, τz] produced by the rotors this substep. */
  readonly wrench = new Float64Array(4)
  /** Air velocity at the drone, world frame, m/s. */
  readonly wind = new Float64Array(3)
  readonly ctrl = new CascadeController()
  readonly battery = new Battery()

  /* guidance (set at 100 Hz by the swarm) */
  readonly target = new Float64Array(3)
  readonly targetVel = new Float64Array(3)
  readonly vSp = new Float64Array(3)
  yawSp = 0
  /** CODE source: explicit target from setTarget(). */
  manual = false
  readonly manualTarget = new Float64Array(3)
  yawOverride: number | null = null
  /** Where the drone was parked (its landing pad), world xy. */
  readonly home = new Float64Array(2)
  /** xy for vertical take-off and for descending onto while landing. */
  readonly anchor = new Float64Array(2)
  /** Low-battery failsafe triggered this flight. */
  lowBattery = false

  mode: DroneMode = 'landed'
  contact = true
  contactTime = 0
  trackErr = 0
  /** Last airborne crash reason, for the status readout. */
  crashCause = ''
  /** HARDWARE mirror: sim time of the last telemetry sample (-1 = none yet). */
  mirrorT = -1
  private readonly safe = new Float64Array(2)

  constructor(readonly id: number) {}

  get armed(): boolean {
    return this.mode === 'flying' || this.mode === 'landing'
  }

  get airborne(): boolean {
    return this.armed && !this.contact
  }

  /** Park the drone on the ground at (x, y) facing yaw, disarmed. */
  placeOnGround(x: number, y: number, yaw: number, p: QuadParams): void {
    const s = this.s
    s.fill(0)
    s[0] = x
    s[1] = y
    s[2] = p.gearHeight
    eulerToQuat(s, Q, 0, 0, yaw)
    this.omega.fill(0)
    this.omegaCmd.fill(0)
    this.thrust.fill(0)
    this.thrustCmd.fill(0)
    this.wrench.fill(0)
    this.ctrl.reset()
    this.mode = 'landed'
    this.contact = true
    this.contactTime = 0
    this.crashCause = ''
    this.lowBattery = false
    this.manual = false
    this.yawOverride = null
    this.battery.reset()
    this.home[0] = x
    this.home[1] = y
    this.safe[0] = x
    this.safe[1] = y
    this.yawSp = yaw
  }

  arm(): void {
    if (this.mode === 'crashed') return
    if (this.mode === 'landed') {
      this.ctrl.reset()
      this.anchor[0] = this.s[0]
      this.anchor[1] = this.s[1]
      this.lowBattery = false
    }
    this.mode = 'flying'
  }

  beginLanding(): void {
    if (!this.armed) return
    this.mode = 'landing'
    this.anchor[0] = this.s[0]
    this.anchor[1] = this.s[1]
  }

  disarm(): void {
    if (this.mode === 'crashed') return
    this.mode = 'landed'
    this.ctrl.reset()
    this.omegaCmd.fill(0)
  }

  /** Disarmed, motors stopped, crash and failsafe state cleared (HARDWARE hand-over). */
  standDown(): void {
    this.mode = 'landed'
    this.manual = false
    this.yawOverride = null
    this.lowBattery = false
    this.crashCause = ''
    this.ctrl.reset()
    this.omega.fill(0)
    this.omegaCmd.fill(0)
    this.thrust.fill(0)
    this.thrustCmd.fill(0)
    this.wrench.fill(0)
  }

  /** Spin the rotors to hover speed (used when a mirrored drone hands back to the sim). */
  primeHover(p: QuadParams): void {
    const w = hoverOmega(p)
    this.omega.fill(w)
    this.omegaCmd.fill(w)
    this.ctrl.reset()
  }

  /** Inner loops (velocity -> attitude -> rate -> mixer) for one substep. */
  controlStep(h: number, p: QuadParams, g: Gains, lim: Limits, geom: MixerGeom): void {
    if (!this.armed) {
      this.omegaCmd.fill(0)
      this.thrustCmd.fill(0)
      return
    }
    this.ctrl.grounded = this.contact
    this.ctrl.step(h, this.s, this.vSp, this.yawSp, p, g, lim, geom, this.thrustCmd)
    for (let i = 0; i < 4; i++) this.omegaCmd[i] = thrustToOmega(this.thrustCmd[i], p)
  }

  /** Motors, rigid body, ground contact and battery for one substep. */
  physicsStep(h: number, p: QuadParams, kind: Integrator, geom: MixerGeom): void {
    // a crashed airframe lies still until RESET
    if (this.mode === 'crashed') return
    stepMotors(this.omega, this.omegaCmd, this.thrust, h, p)
    unmix(this.wrench, this.thrust, geom)
    integrate(kind, this.s, h, this.wrench, this.wind, p)
    if (!this.isFinite()) this.crash('diverged', p)
    this.groundContact(h, p)
    this.battery.drain(h, this.thrust, this.armed)
    this.safe[0] = this.s[0]
    this.safe[1] = this.s[1]
  }

  private isFinite(): boolean {
    const s = this.s
    let acc = 0
    for (let i = 0; i < STATE_LEN; i++) acc += s[i]
    return Number.isFinite(acc) && Math.abs(s[0]) + Math.abs(s[1]) + Math.abs(s[2]) < DIVERGED
  }

  private groundContact(h: number, p: QuadParams): void {
    const s = this.s
    if (s[2] > p.gearHeight) {
      this.contact = false
      this.contactTime = 0
      return
    }
    const cosTilt = quatCosTilt(s, Q)
    if (!this.contact && this.mode !== 'crashed') {
      if (-s[5] > CRASH_SPEED) this.crash(`impact ${(-s[5]).toFixed(1)} m/s`, p)
      else if (cosTilt < COS_CRASH_TILT) this.crash('tip-over', p)
    }
    this.contact = true
    this.contactTime += h
    if (this.mode === 'crashed') return
    s[2] = p.gearHeight
    if (s[5] < 0) s[5] = 0
    if (this.wrench[0] * cosTilt < p.mass * p.g) {
      // the gear carries the weight: pinned, level, no sliding
      s[3] = 0
      s[4] = 0
      s[5] = 0
      s[10] = 0
      s[11] = 0
      s[12] = 0
      const yaw = quatYaw(s, Q)
      eulerToQuat(s, Q, 0, 0, yaw)
    } else {
      const f = Math.exp(-h * 8)
      s[3] *= f
      s[4] *= f
    }
  }

  /** Motors cut, airframe tipped onto one arm at the last sane xy. */
  crash(cause: string, p: QuadParams): void {
    const s = this.s
    const x = Number.isFinite(s[0]) && Math.abs(s[0]) < DIVERGED ? s[0] : this.safe[0]
    const y = Number.isFinite(s[1]) && Math.abs(s[1]) < DIVERGED ? s[1] : this.safe[1]
    const yaw = Number.isFinite(s[6] + s[9]) ? quatYaw(s, Q) : 0
    s.fill(0)
    s[0] = x
    s[1] = y
    s[2] = p.gearHeight * 0.8
    eulerToQuat(s, Q, 0.4, 0, yaw)
    this.omega.fill(0)
    this.omegaCmd.fill(0)
    this.thrust.fill(0)
    this.thrustCmd.fill(0)
    this.wrench.fill(0)
    this.ctrl.reset()
    this.mode = 'crashed'
    this.contact = true
    this.crashCause = cause
  }

  get speed(): number {
    const s = this.s
    return Math.hypot(s[3], s[4], s[5])
  }

  /** Sum of actual rotor thrusts, N. */
  get totalThrust(): number {
    return this.thrust[0] + this.thrust[1] + this.thrust[2] + this.thrust[3]
  }
}
