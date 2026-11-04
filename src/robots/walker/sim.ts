import {
  BELLY_HEIGHT,
  buildLayout,
  DEFAULT_DIMS,
  MAX_JOINTS,
  MAX_LEGS,
  standHeightFor,
  type LegCount,
  type LegLayout,
  type WalkerDims,
} from './geometry'
import { bodyToLeg, clampJoint, legIK } from './kinematics'
import { defaultGaitId, gaitsFor, type GaitDef, type GaitId } from './gaits'
import { GaitEngine, type GaitParams, type TwistCmd } from './gaitEngine'
import { ACTUATOR_PRESETS, ActuatorBank, type ActuatorParams } from './actuator'
import { rotationZYX, rpyFromRotation, worldToBody } from './pose'
import { FIT_NONE, fitRigid, levelOnPlane, lowestPoint, supportPlane } from './bodyFit'
import {
  EvalState,
  clearUnused,
  computeBodyFeet,
  computeCom,
  computeElectrical,
  computeFeet,
  computeLoads,
  computeSupport,
  computeTorques,
  feetToWorld,
  massModelFor,
  referenceMargin,
  totalMass,
  GRAVITY,
  type MassModel,
} from './simState'

/* ============================================================
   WALKER SIM CORE — gait → body pose → IK → actuators → statics.
   Pure TypeScript (no three.js, no DOM), so the whole pipeline is
   unit-testable in Node. The module wraps it with controls, the
   scene and the optional Rapier world.
   In KINEMATIC mode the legs follow the actuator outputs and the
   body is placed where those joint angles put it on the planted
   feet, so servo lag and compliance show as body motion.
   ============================================================ */

export interface BodyPose {
  /** Coxa mount plane above the ground, meters. */
  height: number
  roll: number
  pitch: number
  yaw: number
  shiftX: number
  shiftY: number
}

export type PoseSource = 'sim' | 'measured' | 'physics'

/** Hardware telemetry older than this (seconds) is ignored and the sim takes over. */
export const MEASURED_TIMEOUT = 0.5
/** A foot tip below this height counts as touching the ground when contact is inferred. */
const CONTACT_Z = 0.004
/** Fraction of an even load share below which a measured foot is "in the air". */
const CONTACT_LOAD_FRACTION = 0.08

export class WalkerSim {
  layout: LegLayout
  gaits: GaitDef[]
  gait: GaitDef
  readonly params: GaitParams = { freq: 1.2, stride: 0.06, stepHeight: 0.035, duty: 0.5, treadmill: false }
  readonly pose: BodyPose
  actuator: ActuatorParams = { ...ACTUATOR_PRESETS.ideal }
  readonly mass: MassModel = massModelFor()
  readonly engine: GaitEngine
  readonly actuators = new ActuatorBank(MAX_JOINTS)
  /** IK targets after overrides and joint limits: what the servos are told. */
  readonly qTarget = new Float64Array(MAX_JOINTS)
  /** IK status bits per leg (see kinematics IK_*). */
  readonly ikStatus = new Uint8Array(MAX_LEGS)
  /** Sandbox overrides; NaN = none. */
  readonly jointOverride = new Float64Array(MAX_JOINTS).fill(NaN)
  readonly legOverride = new Float64Array(MAX_LEGS * 3).fill(NaN)
  readonly state = new EvalState()
  /** Planned (commanded) body pose. */
  readonly planPos = new Float64Array(3)
  readonly planR = new Float64Array(9)
  marginRef = 1
  poseSource: PoseSource = 'sim'

  readonly measQ = new Float64Array(MAX_JOINTS)
  measQAt = -Infinity
  readonly measLoad = new Float64Array(MAX_LEGS)
  measLoadAt = -Infinity
  /** Measured [roll, pitch, yaw], radians. */
  readonly measImu = new Float64Array(3)
  measImuAt = -Infinity

  private readonly leg = new Float64Array(6)
  private readonly fitMask = new Uint8Array(MAX_LEGS)
  private readonly projQ = new Float64Array(3)
  private readonly plane = new Float64Array(4)
  private readonly rpy = new Float64Array(3)
  /** Latest clock time seen, seconds (for telemetry freshness). */
  private lastNow = 0

  constructor(n: LegCount = 6, dims: WalkerDims = DEFAULT_DIMS) {
    this.layout = buildLayout(n, dims)
    this.gaits = gaitsFor(this.layout)
    this.gait = this.gaits[0]
    this.params.duty = this.gait.duty
    this.params.freq = this.gait.freq
    this.pose = { height: standHeightFor(dims), roll: 0, pitch: 0, yaw: 0, shiftX: 0, shiftY: 0 }
    this.engine = new GaitEngine(this.layout, this.gait)
    this.marginRef = referenceMargin(this.layout)
    this.settle()
  }

  get n(): LegCount {
    return this.layout.n
  }

  get weight(): number {
    return totalMass(this.mass, this.layout.n) * GRAVITY
  }

  /** Rebuild for a new leg count or new dimensions. Keeps the gait if still valid. */
  configure(n: LegCount, dims: WalkerDims): void {
    const keep = this.gait.id
    this.layout = buildLayout(n, dims)
    this.gaits = gaitsFor(this.layout)
    this.gait = this.gaits.find((g) => g.id === keep) ?? this.gaits.find((g) => g.id === defaultGaitId(n)) ?? this.gaits[0]
    if (this.gait.id !== keep) {
      this.params.duty = this.gait.duty
      this.params.freq = this.gait.freq
    }
    this.engine.setLayout(this.layout, this.gait)
    this.marginRef = referenceMargin(this.layout)
    for (let j = n * 3; j < MAX_JOINTS; j++) this.jointOverride[j] = NaN
    for (let k = n * 3; k < MAX_LEGS * 3; k++) this.legOverride[k] = NaN
    clearUnused(this.state, n)
    this.settle()
  }

  setGait(id: GaitId): boolean {
    const g = this.gaits.find((x) => x.id === id)
    if (!g) return false
    this.gait = g
    this.params.duty = g.duty
    this.params.freq = g.freq
    this.engine.setGait(g)
    return true
  }

  /** Back to (x, y, heading), standing on neutral feet, servos at the standing pose. */
  reset(x = 0, y = 0, heading = 0): void {
    this.engine.reset(x, y, heading)
    this.settle()
  }

  /**
   * Continue the plan from the body's current world pose (after DYNAMIC mode): the
   * gait frame moves under the body and the robot stands up there on neutral feet.
   */
  adoptBodyPose(): void {
    const s = this.state
    rpyFromRotation(s.bodyR, this.rpy)
    const heading = this.rpy[2] - this.pose.yaw
    const c = Math.cos(heading)
    const sn = Math.sin(heading)
    const x = s.bodyPos[0] - (c * this.pose.shiftX - sn * this.pose.shiftY)
    const y = s.bodyPos[1] - (sn * this.pose.shiftX + c * this.pose.shiftY)
    this.reset(x, y, heading)
  }

  /** Snap the actuators to the IK of the current feet and re-evaluate (no time passes). */
  settle(now = this.lastNow): void {
    this.computePlanPose()
    this.solveIK()
    this.actuators.reset(this.qTarget, this.n * 3)
    this.evaluateKinematic(now)
  }

  clearOverrides(): void {
    this.jointOverride.fill(NaN)
    this.legOverride.fill(NaN)
  }

  /** Gait + IK + actuators. loadModel = apply the torque-speed / stall / compliance model (kinematic mode). */
  plan(dt: number, cmd: TwistCmd, loadModel: boolean): void {
    this.engine.step(dt, cmd, this.params)
    this.computePlanPose()
    this.solveIK()
    this.actuators.step(dt, this.qTarget, loadModel ? this.state.torque : null, this.actuator, this.n * 3)
  }

  /** One kinematic-mode frame. `now` (seconds) decides whether hardware telemetry is fresh. */
  stepKinematic(dt: number, cmd: TwistCmd, now: number): void {
    this.plan(dt, cmd, true)
    this.evaluateKinematic(now)
  }

  /** Advance the freshness clock without evaluating (DYNAMIC mode, where physics evaluates). */
  observe(now: number): void {
    this.lastNow = Math.max(this.lastNow, now)
  }

  /** Is the hardware telemetry stamped at `at` still fresh at the latest clock time? */
  isFresh(at: number): boolean {
    return at <= this.lastNow && this.lastNow - at < MEASURED_TIMEOUT
  }

  /** The standing (home) pose: IK of the neutral feet under a level body at the set height, radians. */
  homePose(out: Float64Array): void {
    const L = this.layout
    for (let i = 0; i < L.n; i++) {
      bodyToLeg(L.mountX[i], L.mountY[i], L.mountYaw[i], L.neutralX[i], L.neutralY[i], -this.pose.height, this.leg, 3)
      legIK(L.dims, this.leg[3], this.leg[4], this.leg[5], out, i * 3)
    }
  }

  legOverridden(i: number): boolean {
    const o = i * 3
    if (!Number.isNaN(this.legOverride[o])) return true
    return !Number.isNaN(this.jointOverride[o]) || !Number.isNaN(this.jointOverride[o + 1]) || !Number.isNaN(this.jointOverride[o + 2])
  }

  private computePlanPose(): void {
    const e = this.engine
    const c = Math.cos(e.frame[2])
    const s = Math.sin(e.frame[2])
    const ox = this.pose.shiftX + e.sway[0]
    const oy = this.pose.shiftY + e.sway[1]
    this.planPos[0] = e.frame[0] + c * ox - s * oy
    this.planPos[1] = e.frame[1] + s * ox + c * oy
    this.planPos[2] = this.pose.height
    rotationZYX(e.frame[2] + this.pose.yaw, this.pose.pitch, this.pose.roll, this.planR)
  }

  private solveIK(): void {
    const L = this.layout
    const b = this.leg
    for (let i = 0; i < L.n; i++) {
      const o = i * 3
      if (Number.isNaN(this.legOverride[o])) {
        worldToBody(this.planPos, this.planR, this.engine.feet[o], this.engine.feet[o + 1], this.engine.feet[o + 2], b, 0)
      } else {
        b[0] = this.legOverride[o]
        b[1] = this.legOverride[o + 1]
        b[2] = this.legOverride[o + 2]
      }
      bodyToLeg(L.mountX[i], L.mountY[i], L.mountYaw[i], b[0], b[1], b[2], b, 3)
      this.ikStatus[i] = legIK(L.dims, b[3], b[4], b[5], this.qTarget, o)
    }
    for (let j = 0; j < L.n * 3; j++) {
      if (!Number.isNaN(this.jointOverride[j])) this.qTarget[j] = clampJoint(j, this.jointOverride[j])
    }
  }

  /** Evaluate the kinematic frame: actuator output (or fresh measured angles), body placed on the feet. */
  private evaluateKinematic(now: number): void {
    const s = this.state
    const L = this.layout
    this.lastNow = Math.max(this.lastNow, now)
    const angFresh = this.isFresh(this.measQAt)
    const loadFresh = this.isFresh(this.measLoadAt)
    const imuFresh = this.isFresh(this.measImuAt)
    const src = angFresh ? this.measQ : this.actuators.out
    for (let j = 0; j < L.n * 3; j++) s.q[j] = src[j]
    this.poseSource = angFresh || imuFresh || loadFresh ? 'measured' : 'sim'
    computeBodyFeet(s, L)
    this.placeBody(angFresh, imuFresh)
    feetToWorld(s, L)
    this.inferContacts(angFresh, loadFresh)
    computeCom(s, L, this.mass)
    computeSupport(s, L)
    if (loadFresh) {
      for (let i = 0; i < L.n; i++) s.load[i] = this.measLoad[i]
      s.balanced = s.margin > 0
    } else {
      computeLoads(s, L, this.mass)
    }
    computeTorques(s, L, this.mass)
    computeElectrical(s, L.n, this.actuator)
  }

  /**
   * Simulated angles: the rigid body pose that best puts the stance feet back on their
   * planted points (exactly the plan with ideal servos), then the stance legs closed
   * onto their planted feet. Otherwise (measured angles, or CODE overriding every leg)
   * the body rests on its feet: the IMU tilt on the lowest foot when the IMU is fresh,
   * else the support plane under the body. Never below the belly.
   */
  private placeBody(angFresh: boolean, imuFresh: boolean): void {
    const s = this.state
    const L = this.layout
    const e = this.engine
    s.belly = false
    if (!angFresh && !imuFresh) {
      for (let i = 0; i < L.n; i++) this.fitMask[i] = e.contact[i] && !this.legOverridden(i) ? 1 : 0
      if (fitRigid(s.footB, e.feet, this.fitMask, L.n, this.planR, s.bodyPos, s.bodyR) !== FIT_NONE) {
        this.closeStanceLegs()
        return
      }
    }
    const yaw = e.frame[2] + this.pose.yaw
    let h: number
    if (imuFresh) {
      rotationZYX(yaw, this.measImu[1], this.measImu[0], s.bodyR)
      h = -lowestPoint(s.footB, L.n, s.bodyR)
    } else if (supportPlane(s.footB, L.n, this.plane)) {
      levelOnPlane(this.plane[0], this.plane[1], this.plane[2], yaw, s.bodyR)
      h = -this.plane[3]
    } else {
      s.bodyR.set(this.planR)
      h = -lowestPoint(s.footB, L.n, s.bodyR)
    }
    s.belly = h < BELLY_HEIGHT
    s.bodyPos[0] = this.planPos[0]
    s.bodyPos[1] = this.planPos[1]
    s.bodyPos[2] = Math.max(h, BELLY_HEIGHT)
  }

  /*
   * A planted foot cannot move, so a stance leg's real joint angles are the IK of that
   * foot under the fitted body. The small difference from the free actuator output
   * (servo compliance spreads the feet a few mm) is taken up by friction between the
   * feet, which the vertical-load statics does not model; projecting keeps stance feet
   * exactly planted with every servo model.
   */
  private closeStanceLegs(): void {
    const s = this.state
    const L = this.layout
    const b = this.leg
    const q = this.projQ
    for (let i = 0; i < L.n; i++) {
      if (!this.fitMask[i]) continue
      const o = i * 3
      worldToBody(s.bodyPos, s.bodyR, this.engine.feet[o], this.engine.feet[o + 1], this.engine.feet[o + 2], b, 0)
      bodyToLeg(L.mountX[i], L.mountY[i], L.mountYaw[i], b[0], b[1], b[2], b, 3)
      legIK(L.dims, b[3], b[4], b[5], q, 0)
      s.q[o] = q[0]
      s.q[o + 1] = q[1]
      s.q[o + 2] = q[2]
    }
    computeBodyFeet(s, L)
  }

  private inferContacts(angFresh: boolean, loadFresh: boolean): void {
    const s = this.state
    const n = this.layout.n
    for (let i = 0; i < n; i++) {
      s.contact[i] = angFresh || this.legOverridden(i) ? (s.feet[i * 3 + 2] < CONTACT_Z ? 1 : 0) : this.engine.contact[i]
    }
    if (!loadFresh) return
    const share = this.weight / n
    for (let i = 0; i < n; i++) s.contact[i] = this.measLoad[i] > CONTACT_LOAD_FRACTION * share ? 1 : 0
  }

  /**
   * Evaluate a frame whose body pose, joint angles, contacts, loads and torques were
   * written into `state` by the physics engine.
   */
  evaluatePhysics(): void {
    const s = this.state
    const L = this.layout
    this.poseSource = 'physics'
    s.belly = false
    computeFeet(s, L)
    computeCom(s, L, this.mass)
    computeSupport(s, L)
    computeElectrical(s, L.n, this.actuator)
  }

  /** Re-evaluate the statics for state as it stands (after restore / replay). */
  evaluateRestored(): void {
    const s = this.state
    const L = this.layout
    computeFeet(s, L)
    computeCom(s, L, this.mass)
    computeSupport(s, L)
    computeLoads(s, L, this.mass)
    computeTorques(s, L, this.mass)
    computeElectrical(s, L.n, this.actuator)
  }
}
