import { FOOT_RADIUS, MAX_JOINTS, MAX_LEGS, type LegLayout, type WalkerDims } from './geometry'
import { addHoldingTorque, addLinkGravityTorque, legFK, legJacobian, legToBody } from './kinematics'
import { bodyToWorld } from './pose'
import { convexHull, distributeLoad, stabilityMargin } from './statics'
import { isOverloaded, servoCurrent, type ActuatorParams } from './actuator'

/* ============================================================
   EVALUATED STATE — everything the instruments and the scene read,
   computed from a body pose + joint angles + contacts, whatever
   produced them (kinematic sim, measured telemetry, or Rapier).
   ============================================================ */

export const GRAVITY = 9.81

export interface MassModel {
  body: number
  coxa: number
  femur: number
  tibia: number
}

/** About 1.8 kg for a hexapod: a 0.9 kg body plus 0.15 kg per leg (3 servos + brackets). */
export function massModelFor(): MassModel {
  return { body: 0.9, coxa: 0.06, femur: 0.06, tibia: 0.03 }
}

export function totalMass(m: MassModel, n: number): number {
  return m.body + n * (m.coxa + m.femur + m.tibia)
}

export class EvalState {
  readonly bodyPos = new Float64Array(3)
  /** Body rotation, row-major 3×3 (world ← body). */
  readonly bodyR = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
  /** Joint angles being shown / analysed, radians, leg-major. */
  readonly q = new Float64Array(MAX_JOINTS)
  /** Foot tips in the body frame (FK of q). */
  readonly footB = new Float64Array(MAX_LEGS * 3)
  /** Foot tips in the world. */
  readonly feet = new Float64Array(MAX_LEGS * 3)
  readonly contact = new Uint8Array(MAX_LEGS)
  /** Vertical foot load, newtons. */
  readonly load = new Float64Array(MAX_LEGS)
  /** Holding torque per joint, N·m (sign: what the servo must push). */
  readonly torque = new Float64Array(MAX_JOINTS)
  readonly current = new Float64Array(MAX_JOINTS)
  readonly hull = new Int32Array(MAX_LEGS)
  hullCount = 0
  readonly com = new Float64Array(3)
  /** Signed support margin, meters. */
  margin = 0
  balanced = true
  totalCurrent = 0
  power = 0
  maxTorque = 0
  maxTorqueJoint = 0
  /** Joint index over stall torque, or −1. */
  overload = -1
  /** No foot reaches the ground: the robot lies on its belly plate. */
  belly = false

  /** Scratch: support points (foot x, y) and one leg Jacobian. */
  readonly px = new Float64Array(MAX_LEGS)
  readonly py = new Float64Array(MAX_LEGS)
  readonly jac = new Float64Array(9)
}

const scratch = new Float64Array(6)

/** Foot tips in the body frame for the joint angles in s.q. */
export function computeBodyFeet(s: EvalState, L: LegLayout): void {
  for (let i = 0; i < L.n; i++) {
    legFK(L.dims, s.q, i * 3, scratch, 0)
    legToBody(L.mountX[i], L.mountY[i], L.mountYaw[i], scratch[0], scratch[1], scratch[2], s.footB, i * 3)
  }
}

/** Body-frame feet → world, at the body pose in s. */
export function feetToWorld(s: EvalState, L: LegLayout): void {
  const b = s.footB
  for (let i = 0; i < L.n; i++) bodyToWorld(s.bodyPos, s.bodyR, b[i * 3], b[i * 3 + 1], b[i * 3 + 2], s.feet, i * 3)
}

/** Foot tips (world) for the joint angles in s.q at the body pose in s. */
export function computeFeet(s: EvalState, L: LegLayout): void {
  computeBodyFeet(s, L)
  feetToWorld(s, L)
}

/** Accumulate m·p for a link mass at radius rho / height z in its leg plane. */
function addLinkMass(s: EvalState, L: LegLayout, i: number, rho: number, z: number, m: number, acc: Float64Array): void {
  const g = s.q[i * 3]
  legToBody(L.mountX[i], L.mountY[i], L.mountYaw[i], rho * Math.cos(g), rho * Math.sin(g), z, scratch, 0)
  bodyToWorld(s.bodyPos, s.bodyR, scratch[0], scratch[1], scratch[2], scratch, 3)
  acc[0] += m * scratch[3]
  acc[1] += m * scratch[4]
  acc[2] += m * scratch[5]
}

/** Whole-robot centre of mass: body at its origin, each link at its midpoint. */
export function computeCom(s: EvalState, L: LegLayout, m: MassModel): void {
  const d = L.dims
  const acc = s.com
  acc[0] = m.body * s.bodyPos[0]
  acc[1] = m.body * s.bodyPos[1]
  acc[2] = m.body * s.bodyPos[2]
  for (let i = 0; i < L.n; i++) {
    const a = s.q[i * 3 + 1]
    const ab = a + s.q[i * 3 + 2]
    const kneeR = d.coxa + d.femur * Math.cos(a)
    const kneeZ = d.femur * Math.sin(a)
    addLinkMass(s, L, i, d.coxa / 2, 0, m.coxa, acc)
    addLinkMass(s, L, i, d.coxa + (d.femur / 2) * Math.cos(a), (d.femur / 2) * Math.sin(a), m.femur, acc)
    addLinkMass(s, L, i, kneeR + (d.tibia / 2) * Math.sin(ab), kneeZ - (d.tibia / 2) * Math.cos(ab), m.tibia, acc)
  }
  const M = totalMass(m, L.n)
  acc[0] /= M
  acc[1] /= M
  acc[2] /= M
}

/** Support polygon + signed margin of the CoM projection. */
export function computeSupport(s: EvalState, L: LegLayout): void {
  const px = s.px
  const py = s.py
  for (let i = 0; i < L.n; i++) {
    px[i] = s.feet[i * 3]
    py[i] = s.feet[i * 3 + 1]
  }
  s.hullCount = convexHull(px, py, s.contact, L.n, s.hull)
  s.margin = stabilityMargin(px, py, s.hull, s.hullCount, s.com[0], s.com[1])
}

/** Static-equilibrium foot loads (minimum-norm, non-negative). */
export function computeLoads(s: EvalState, L: LegLayout, m: MassModel): void {
  const r = distributeLoad(s.px, s.py, s.contact, L.n, s.com[0], s.com[1], totalMass(m, L.n) * GRAVITY, s.load)
  s.balanced = r.balanced
}

/** Leg dimensions with the tibia ending at the foot-ball centre (scratch, reused). */
const ballDims: WalkerDims = { coxa: 0, femur: 0, tibia: 0, bodyRadius: 0 }

/**
 * Joint holding torques: −Jᵀ·F for the foot load plus the leg's own link weight. The
 * foot is a ball: the ground's normal force acts along a line through its centre, so
 * the lever arms are those of the ball centre (FOOT_RADIUS short of the tip), as in
 * DYNAMIC mode and on a robot with rubber ball feet.
 */
export function computeTorques(s: EvalState, L: LegLayout, m: MassModel): void {
  const R = s.bodyR
  const jac = s.jac
  ballDims.coxa = L.dims.coxa
  ballDims.femur = L.dims.femur
  ballDims.tibia = L.dims.tibia - FOOT_RADIUS
  ballDims.bodyRadius = L.dims.bodyRadius
  for (let i = 0; i < L.n; i++) {
    const o = i * 3
    s.torque[o] = 0
    s.torque[o + 1] = 0
    s.torque[o + 2] = 0
    const f = s.load[i]
    const c = Math.cos(L.mountYaw[i])
    const sn = Math.sin(L.mountYaw[i])
    if (f > 0) {
      // world up (0,0,f) in the body frame is f·(third row of R)
      const bx = f * R[6]
      const by = f * R[7]
      legJacobian(ballDims, s.q, o, jac)
      addHoldingTorque(jac, c * bx + sn * by, -sn * bx + c * by, f * R[8], s.torque, o)
    }
    addLinkGravityTorque(L.dims, s.q, o, m.femur, m.tibia, R[8], s.torque, o)
  }
}

/** Servo current, electrical power and the overload check. */
export function computeElectrical(s: EvalState, n: number, p: ActuatorParams): void {
  let total = 0
  let max = 0
  let maxJ = 0
  for (let j = 0; j < n * 3; j++) {
    const t = Math.abs(s.torque[j])
    s.current[j] = servoCurrent(t, p)
    total += s.current[j]
    if (t > max) { max = t; maxJ = j }
  }
  s.totalCurrent = total
  s.power = total * p.volts
  s.maxTorque = max
  s.maxTorqueJoint = maxJ
  s.overload = isOverloaded(max, p) ? maxJ : -1
}

/** Margin of the all-feet neutral stance with the CoM at the centre: the 100 % reference. */
export function referenceMargin(L: LegLayout): number {
  const s = new EvalState()
  for (let i = 0; i < L.n; i++) {
    s.feet[i * 3] = L.neutralX[i]
    s.feet[i * 3 + 1] = L.neutralY[i]
    s.contact[i] = 1
  }
  computeSupport(s, L)
  return Math.max(s.margin, 1e-3)
}

/** Clear the per-leg arrays past the active leg count (after a leg-count change). */
export function clearUnused(s: EvalState, n: number): void {
  for (let i = n; i < MAX_LEGS; i++) {
    s.contact[i] = 0
    s.load[i] = 0
    for (let k = 0; k < 3; k++) {
      s.feet[i * 3 + k] = 0
      s.footB[i * 3 + k] = 0
    }
  }
  for (let j = n * 3; j < MAX_JOINTS; j++) {
    s.torque[j] = 0
    s.current[j] = 0
    s.q[j] = 0
  }
}
