import type { Collider, ColliderDesc, RevoluteImpulseJoint, RigidBody, TempContactManifold, World } from '@dimforge/rapier3d-compat'
import { FOOT_RADIUS, MAX_JOINTS, MAX_LEGS, type LegLayout } from '../geometry'
import { JOINT_MAX, JOINT_MIN } from '../kinematics'
import { PROP_BAND, type ActuatorParams } from '../actuator'
import type { MassModel } from '../simState'
import { GRAVITY } from '../simState'
import { quatToRotation, rotationToQuat } from '../pose'
import type { Rapier } from './loader'
import { addVec, axisQuat, quatMul, rotateByQuat, type Quat, type Vec3 } from './quat'

/* ============================================================
   DYNAMIC MODE — the walker as Rapier rigid bodies.
   World is Z-up like the sim (gravity −z). Body + coxa / femur /
   tibia links per leg, revolute impulse joints with position motors.
   Every link's local frame is the body frame at joint zero, so the
   Rapier joint angle equals our joint angle (verified in tests).
   Motor stiffness comes from the servo's stall torque over its
   proportional band (PROP_BAND, shared with the KINEMATIC compliance
   model), max force = stall torque. Fixed 1/240 s steps.
   ============================================================ */

const FIXED_DT = 1 / 240
const MAX_SUBSTEPS = 12
/** Effective link inertia used to pick near-critical motor damping, kg·m². */
const LINK_INERTIA = 5e-4
/**
 * Reflected rotor inertia of a geared hobby servo about its output axis, kg·m²
 * (rotor ~5e-8 kg·m² through a ~150:1 gearbox ≈ 1e-3). Added to each link about its
 * hinge; it sets a ~10 Hz servo response and keeps the stiff motor chains stable.
 */
const ARMATURE = 1e-3
/**
 * Inertia floor about a link's two other axes, kg·m². With only the armature, a link
 * was 2e-3 about its hinge but ~1e-5 about the others; at that 200:1 ratio the 8-pass
 * solver left phantom joint velocities that the motors damped against (frictionless
 * tripod: femurs saturated at 2× the static torque, the quad crawl flipped and launched).
 * With the floor the motor torques match Jᵀ·F statics within ~4 %. Cost: Rapier adds
 * link inertia to whole-body rotation too (it has no joint-space armature), so the
 * hexapod's roll / pitch inertia is ~1.5× the bare links' (yaw 1.3×) and a tip-over
 * runs ~20 % slower than on the real robot (hinge-only 2e-3 was 1.7× / 1.35×).
 */
const ROT_INERTIA_FLOOR = 3e-4
const SOLVER_ITERATIONS = 8
const PGS_ITERATIONS = 2
/** Robot-scale tolerances: Rapier scales its contact / sleep thresholds by this. */
const LENGTH_UNIT = 0.1
const IDEAL_STIFFNESS = 80
const IDEAL_MAX_TORQUE = 25
const LIMIT_MARGIN = 5 * (Math.PI / 180)
const ROBOT_GROUPS = (0x0001 << 16) | 0x0002
const GROUND_GROUPS = (0x0002 << 16) | 0x0001
const BODY_HALF_THICK = 0.018
const TIBIA_RADIUS = 0.007
/** Body up-vector z below this counts as tipped over. */
const TIPPED_UP_Z = 0.5
/** Spawn clearance so no foot starts inside the ground (small: a drop makes the feet slip). */
const SPAWN_LIFT = 0.0005

export interface SpawnPose {
  pos: Float64Array
  R: Float64Array
  q: Float64Array
}

/** What the physics writes back each frame (into the sim's EvalState arrays). */
export interface PhysicsOut {
  bodyPos: Float64Array
  bodyR: Float64Array
  q: Float64Array
  contact: Uint8Array
  load: Float64Array
  torque: Float64Array
}

export class RapierWalker {
  readonly targets = new Float64Array(MAX_JOINTS)
  /** Horizontal body speed from the last read, m/s. */
  speed = 0
  tipped = false

  private readonly world: World
  private readonly ground: Collider
  private readonly body: RigidBody
  private readonly links: RigidBody[] = []
  private readonly joints: RevoluteImpulseJoint[] = []
  private readonly feet: Collider[] = []
  private readonly shins: Collider[] = []
  /** Joint axis per joint, in the parent link's local frame. */
  private readonly axes = new Float64Array(MAX_JOINTS * 3)
  private readonly impulse = new Float64Array(MAX_LEGS)
  private readonly n: number
  private accumulator = 0
  private stepped = 0
  private stiffness = IDEAL_STIFFNESS
  private damping = 1
  private maxTorque = IDEAL_MAX_TORQUE
  private legAcc = 0
  private readonly qa = new Float64Array(4)
  private readonly rm = new Float64Array(9)
  private readonly onManifold = (m: TempContactManifold): void => {
    for (let i = 0; i < m.numContacts(); i++) this.legAcc += m.contactImpulse(i)
  }

  constructor(private readonly R: Rapier, private readonly layout: LegLayout, private readonly mass: MassModel, spawn: SpawnPose, actuator: ActuatorParams) {
    this.n = layout.n
    this.world = new R.World({ x: 0, y: 0, z: -GRAVITY })
    this.world.timestep = FIXED_DT
    this.world.numSolverIterations = SOLVER_ITERATIONS
    this.world.numInternalPgsIterations = PGS_ITERATIONS
    this.world.lengthUnit = LENGTH_UNIT
    const g = this.world.createRigidBody(R.RigidBodyDesc.fixed())
    this.ground = this.world.createCollider(
      R.ColliderDesc.cuboid(25, 25, 0.5).setTranslation(0, 0, -0.5).setFriction(1).setCollisionGroups(GROUND_GROUPS),
      g,
    )
    this.body = this.createBody(spawn)
    for (let i = 0; i < this.n; i++) this.createLeg(i, spawn)
    this.configureMotors(actuator)
    this.setTargets(spawn.q)
  }

  configureMotors(p: ActuatorParams): void {
    const ideal = !Number.isFinite(p.stall)
    this.stiffness = ideal ? IDEAL_STIFFNESS : p.stall / PROP_BAND
    this.maxTorque = ideal ? IDEAL_MAX_TORQUE : p.stall
    this.damping = 2 * Math.sqrt(this.stiffness * (LINK_INERTIA + ARMATURE))
    for (const j of this.joints) {
      j.configureMotorModel(this.R.MotorModel.ForceBased)
      j.setMotorMaxForce(this.maxTorque)
    }
  }

  setTargets(q: Float64Array): void {
    for (let j = 0; j < this.n * 3; j++) {
      this.targets[j] = q[j]
      this.joints[j].configureMotorPosition(q[j], this.stiffness, this.damping)
    }
  }

  /** Advance by dt with fixed substeps; accumulates foot contact impulses for read(). */
  step(dt: number): number {
    this.accumulator = Math.min(this.accumulator + dt, MAX_SUBSTEPS * FIXED_DT)
    this.impulse.fill(0)
    this.stepped = 0
    let steps = 0
    while (this.accumulator >= FIXED_DT) {
      this.world.step()
      this.accumulator -= FIXED_DT
      this.stepped += FIXED_DT
      steps++
      for (let i = 0; i < this.n; i++) {
        this.legAcc = 0
        this.world.contactPair(this.feet[i], this.ground, this.onManifold)
        this.world.contactPair(this.shins[i], this.ground, this.onManifold)
        this.impulse[i] += this.legAcc
      }
    }
    return steps
  }

  /** Body pose, joint angles (measured from link rotations), loads and motor torques. */
  read(out: PhysicsOut): void {
    const t = this.body.translation()
    const r = this.body.rotation()
    out.bodyPos[0] = t.x
    out.bodyPos[1] = t.y
    out.bodyPos[2] = t.z
    quatToRotation(r.x, r.y, r.z, r.w, out.bodyR)
    const v = this.body.linvel()
    this.speed = Math.hypot(v.x, v.y)
    this.tipped = out.bodyR[8] < TIPPED_UP_Z
    for (let i = 0; i < this.n; i++) this.readLeg(i, out)
  }

  private readLeg(i: number, out: PhysicsOut): void {
    const share = (this.totalMass() * GRAVITY) / this.n
    if (this.stepped > 0) {
      out.load[i] = this.impulse[i] / this.stepped
      out.contact[i] = out.load[i] > 0.05 * share ? 1 : 0
    }
    let parent: RigidBody = this.body
    for (let k = 0; k < 3; k++) {
      const j = i * 3 + k
      const child = this.links[j]
      const pr = parent.rotation()
      const cr = child.rotation()
      const ax = this.axes[j * 3]
      const ay = this.axes[j * 3 + 1]
      const az = this.axes[j * 3 + 2]
      // relative rotation q_rel = conj(q_parent) · q_child, projected on the hinge axis
      const rw = pr.w * cr.w + pr.x * cr.x + pr.y * cr.y + pr.z * cr.z
      const rx = pr.w * cr.x - pr.x * cr.w - pr.y * cr.z + pr.z * cr.y
      const ry = pr.w * cr.y + pr.x * cr.z - pr.y * cr.w - pr.z * cr.x
      const rz = pr.w * cr.z - pr.x * cr.y + pr.y * cr.x - pr.z * cr.w
      const angle = 2 * Math.atan2(rx * ax + ry * ay + rz * az, rw)
      out.q[j] = angle > Math.PI ? angle - 2 * Math.PI : angle < -Math.PI ? angle + 2 * Math.PI : angle
      // hinge rate: relative angular velocity on the world axis
      quatToRotation(pr.x, pr.y, pr.z, pr.w, this.rm)
      const wx = this.rm[0] * ax + this.rm[1] * ay + this.rm[2] * az
      const wy = this.rm[3] * ax + this.rm[4] * ay + this.rm[5] * az
      const wz = this.rm[6] * ax + this.rm[7] * ay + this.rm[8] * az
      const cw = child.angvel()
      const pw = parent.angvel()
      const rate = (cw.x - pw.x) * wx + (cw.y - pw.y) * wy + (cw.z - pw.z) * wz
      const tau = this.stiffness * (this.targets[j] - out.q[j]) - this.damping * rate
      out.torque[j] = Math.max(-this.maxTorque, Math.min(this.maxTorque, tau))
      parent = child
    }
  }

  totalMass(): number {
    return this.mass.body + this.n * (this.mass.coxa + this.mass.femur + this.mass.tibia)
  }

  dispose(): void {
    this.world.free()
  }

  private createBody(spawn: SpawnPose): RigidBody {
    const R = this.R
    const L = this.layout
    rotationToQuat(spawn.R, this.qa)
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(spawn.pos[0], spawn.pos[1], spawn.pos[2] + SPAWN_LIFT)
      .setRotation({ x: this.qa[0], y: this.qa[1], z: this.qa[2], w: this.qa[3] })
      .setCanSleep(false)
    const body = this.world.createRigidBody(desc)
    const pts = new Float32Array(L.n * 6)
    for (let i = 0; i < L.n; i++) {
      const k = 1 + 0.012 / L.dims.bodyRadius
      for (let s = 0; s < 2; s++) {
        pts[i * 6 + s * 3] = L.mountX[i] * k
        pts[i * 6 + s * 3 + 1] = L.mountY[i] * k
        pts[i * 6 + s * 3 + 2] = s === 0 ? -BODY_HALF_THICK : BODY_HALF_THICK
      }
    }
    const hull = R.ColliderDesc.convexHull(pts) ?? R.ColliderDesc.cuboid(L.dims.bodyRadius, L.dims.bodyRadius * 0.7, BODY_HALF_THICK)
    this.world.createCollider(hull.setMass(this.mass.body).setFriction(0.6).setCollisionGroups(ROBOT_GROUPS), body)
    return body
  }

  /** Spawn one leg's three links at the joint angles in spawn.q. */
  private createLeg(i: number, spawn: SpawnPose): void {
    const L = this.layout
    const d = L.dims
    const R = this.R
    const yaw = L.mountYaw[i]
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    const hinge: Vec3 = [s, -c, 0]
    rotationToQuat(spawn.R, this.qa)
    const qBody: Quat = [this.qa[0], this.qa[1], this.qa[2], this.qa[3]]
    const qCoxa = quatMul(qBody, axisQuat([0, 0, 1], spawn.q[i * 3]))
    const qFemur = quatMul(qCoxa, axisQuat(hinge, spawn.q[i * 3 + 1]))
    const qTibia = quatMul(qFemur, axisQuat(hinge, spawn.q[i * 3 + 2]))
    const base: Vec3 = [spawn.pos[0], spawn.pos[1], spawn.pos[2] + SPAWN_LIFT]
    const pCoxa = addVec(base, rotateByQuat(qBody, [L.mountX[i], L.mountY[i], 0]))
    const pFemur = addVec(pCoxa, rotateByQuat(qCoxa, [d.coxa * c, d.coxa * s, 0]))
    const pTibia = addVec(pFemur, rotateByQuat(qFemur, [d.femur * c, d.femur * s, 0]))
    const yawRot = { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) }

    const coxa = this.linkBody(pCoxa, qCoxa, null)
    this.attach(coxa, R.ColliderDesc.cuboid(d.coxa / 2, 0.013, 0.016)
      .setTranslation((d.coxa / 2) * c, (d.coxa / 2) * s, 0).setRotation(yawRot).setMass(this.mass.coxa), 0.6)
    const femur = this.linkBody(pFemur, qFemur, yaw)
    this.attach(femur, R.ColliderDesc.cuboid(d.femur / 2, 0.012, 0.011)
      .setTranslation((d.femur / 2) * c, (d.femur / 2) * s, 0).setRotation(yawRot).setMass(this.mass.femur), 0.6)
    const tibia = this.linkBody(pTibia, qTibia, yaw)
    const shinLen = Math.max(0.01, d.tibia - 2 * FOOT_RADIUS)
    const half = Math.max(0.002, shinLen / 2 - TIBIA_RADIUS)
    // capsules run along local Y: turn them 90° about X to hang down Z
    this.shins.push(this.attach(tibia, R.ColliderDesc.capsule(half, TIBIA_RADIUS)
      .setTranslation(0, 0, -shinLen / 2).setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }).setMass(this.mass.tibia * 0.8), 0.6))
    // foot ball: its bottom is the tibia tip when the tibia is vertical
    this.feet.push(this.attach(tibia, R.ColliderDesc.ball(FOOT_RADIUS)
      .setTranslation(0, 0, -(d.tibia - FOOT_RADIUS)).setMass(this.mass.tibia * 0.2), 1.1))

    this.joint(i * 3, this.body, coxa, [L.mountX[i], L.mountY[i], 0], [0, 0, 1], 0)
    this.joint(i * 3 + 1, coxa, femur, [d.coxa * c, d.coxa * s, 0], hinge, 1)
    this.joint(i * 3 + 2, femur, tibia, [d.femur * c, d.femur * s, 0], hinge, 2)
  }

  /**
   * One leg link. The armature is a principal inertia about the link's hinge: local z
   * for the coxa (hingeYaw null), else the tangential axis (sin yaw, −cos yaw, 0), which
   * is local x turned by yaw − 90° about z. The other two axes get the floor.
   */
  private linkBody(p: Vec3, q: Quat, hingeYaw: number | null): RigidBody {
    const zero = { x: 0, y: 0, z: 0 }
    const f = ROT_INERTIA_FLOOR
    const inertia = hingeYaw === null ? { x: f, y: f, z: ARMATURE } : { x: ARMATURE, y: f, z: f }
    const half = hingeYaw === null ? 0 : (hingeYaw - Math.PI / 2) / 2
    const frame = { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) }
    const rb = this.world.createRigidBody(
      this.R.RigidBodyDesc.dynamic()
        .setTranslation(p[0], p[1], p[2])
        .setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] })
        .setAdditionalMassProperties(0, zero, inertia, frame)
        .setCanSleep(false),
    )
    this.links.push(rb)
    return rb
  }

  private attach(rb: RigidBody, desc: ColliderDesc, friction: number): Collider {
    return this.world.createCollider(desc.setFriction(friction).setCollisionGroups(ROBOT_GROUPS), rb)
  }

  private joint(j: number, parent: RigidBody, child: RigidBody, anchor: Vec3, axis: Vec3, k: number): void {
    const data = this.R.JointData.revolute({ x: anchor[0], y: anchor[1], z: anchor[2] }, { x: 0, y: 0, z: 0 }, { x: axis[0], y: axis[1], z: axis[2] })
    data.limitsEnabled = true
    data.limits = [JOINT_MIN[k] - LIMIT_MARGIN, JOINT_MAX[k] + LIMIT_MARGIN]
    const jt = this.world.createImpulseJoint(data, parent, child, true) as RevoluteImpulseJoint
    jt.setContactsEnabled(false)
    this.joints.push(jt)
    this.axes[j * 3] = axis[0]
    this.axes[j * 3 + 1] = axis[1]
    this.axes[j * 3 + 2] = axis[2]
  }
}
