import * as THREE from 'three'
import { FOOT_RADIUS, MAX_LEGS, type LegLayout } from '../geometry'
import type { EvalState } from '../simState'
import { BODY_TOP, HORN, SERVO, buildParts, partList, type PartSet } from './parts'
import { DANGER, SIM_TEAL, type WalkerMaterials } from './materials'
import { TreadmillBelt } from './treadmill'

/* ============================================================
   WALKER RIG — three.js scene graph, look of the reference: white
   faceted body, white servo-bracket legs, dark servo cases, orange
   horns on the real joint axes, orange feet. Everything lives in a
   Z-up group (x forward) so it uses the sim's frame directly; the
   group's −90° X rotation maps it into three's Y-up world.
   Per frame: one body transform + three rotations per leg.
   ============================================================ */

interface LegRig {
  mount: THREE.Group
  coxa: THREE.Group
  femur: THREE.Group
  tibia: THREE.Group
}

export class WalkerVisual {
  /** Z-up container, child of the module root. */
  readonly frame = new THREE.Group()
  private readonly body = new THREE.Group()
  private readonly overlays = new THREE.Group()
  private readonly legs: LegRig[] = []
  private readonly rings: THREE.Mesh[] = []
  private readonly com = new THREE.Group()
  private readonly support: THREE.LineLoop
  private readonly supportPos = new Float32Array((MAX_LEGS + 1) * 3)
  private readonly belt = new TreadmillBelt()
  private parts: PartSet | null = null
  private readonly m4 = new THREE.Matrix4()

  constructor(private readonly mat: WalkerMaterials) {
    this.frame.rotation.x = -Math.PI / 2
    this.frame.add(this.body, this.overlays)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.supportPos, 3))
    this.support = new THREE.LineLoop(g, mat.support)
    this.support.renderOrder = 2
    this.support.frustumCulled = false
    this.overlays.add(this.belt.object, this.support, this.com)
  }

  /** (Re)build every mesh for a layout. Old per-build geometry is disposed. */
  build(L: LegLayout): void {
    this.clearBuild()
    const p = buildParts(L)
    this.parts = p
    this.buildBody(p)
    for (let i = 0; i < L.n; i++) this.legs.push(this.buildLeg(L, p, i))
    for (let i = 0; i < L.n; i++) {
      const ring = new THREE.Mesh(p.contactRing, this.mat.contact)
      ring.renderOrder = 1
      ring.visible = false
      this.rings.push(ring)
      this.overlays.add(ring)
    }
    const barA = new THREE.Mesh(p.comBar, this.mat.com)
    const barB = new THREE.Mesh(p.comBar, this.mat.com)
    barA.rotation.z = Math.PI / 4
    barB.rotation.z = -Math.PI / 4
    this.com.add(barA, barB, new THREE.Mesh(p.comRing, this.mat.com))
  }

  /** Pose the rig from an evaluated state (body pose, joint angles, contacts, support, CoM). */
  apply(s: EvalState, n: number, marginOk: boolean): void {
    this.body.position.set(s.bodyPos[0], s.bodyPos[1], s.bodyPos[2])
    const R = s.bodyR
    this.m4.set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1)
    this.body.quaternion.setFromRotationMatrix(this.m4)
    for (let i = 0; i < n && i < this.legs.length; i++) {
      const leg = this.legs[i]
      leg.coxa.rotation.z = s.q[i * 3]
      // femur / tibia axes are −y in the leg frame
      leg.femur.rotation.y = -s.q[i * 3 + 1]
      leg.tibia.rotation.y = -s.q[i * 3 + 2]
      const ring = this.rings[i]
      ring.visible = s.contact[i] === 1
      ring.position.set(s.feet[i * 3], s.feet[i * 3 + 1], 0.0007)
    }
    this.applySupport(s, marginOk)
  }

  /** Treadmill belt pose (see GaitEngine.ground); hidden when the treadmill is off. */
  applyBelt(visible: boolean, x: number, y: number, angle: number): void {
    this.belt.update(visible, x, y, angle)
  }

  private applySupport(s: EvalState, ok: boolean): void {
    const h = s.hullCount
    for (let k = 0; k < h; k++) {
      const i = s.hull[k]
      this.supportPos[k * 3] = s.feet[i * 3]
      this.supportPos[k * 3 + 1] = s.feet[i * 3 + 1]
      this.supportPos[k * 3 + 2] = 0.0009
    }
    const g = this.support.geometry
    g.setDrawRange(0, h >= 2 ? h : 0)
    ;(g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    this.mat.support.color.setHex(ok ? SIM_TEAL : DANGER)
    this.mat.com.color.setHex(ok ? 0x14171a : DANGER)
    this.com.position.set(s.com[0], s.com[1], 0.0011)
  }

  /** World-space (three Y-up) point the follow camera should track. */
  followPoint(s: EvalState, out: THREE.Vector3): THREE.Vector3 {
    return out.set(s.bodyPos[0], s.bodyPos[2], -s.bodyPos[1])
  }

  dispose(): void {
    this.clearBuild()
    this.support.geometry.dispose()
    this.belt.dispose()
  }

  private clearBuild(): void {
    if (this.parts) for (const g of partList(this.parts)) g.dispose()
    this.parts = null
    this.body.clear()
    this.com.clear()
    for (const r of this.rings) this.overlays.remove(r)
    this.rings.length = 0
    this.legs.length = 0
  }

  private mesh(g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Mesh {
    const mesh = new THREE.Mesh(g, m)
    mesh.position.set(x, y, z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    parent.add(mesh)
    return mesh
  }

  private buildBody(p: PartSet): void {
    const m = this.mat
    this.mesh(p.bodyShell, m.shell, this.body)
    this.mesh(p.bodyCover, m.cover, this.body, 0, 0, BODY_TOP + 0.002)
    this.mesh(p.bodyPlate, m.servo, this.body, 0, 0, -BODY_TOP - 0.003)
    const line = new THREE.LineLoop(p.panelLine, m.panelLine)
    this.body.add(line)
    // sensor head with two lenses, status LED behind it
    const fx = p.frontX
    this.mesh(p.sensor, m.servo, this.body, fx - 0.002, 0, 0)
    this.mesh(p.lens, m.lens, this.body, fx + 0.005, 0.009, 0.001)
    this.mesh(p.lens, m.lens, this.body, fx + 0.005, -0.009, 0.001)
    this.mesh(p.led, m.led, this.body, fx * 0.55, 0, BODY_TOP + 0.0055).castShadow = false
  }

  private buildLeg(L: LegLayout, p: PartSet, i: number): LegRig {
    const m = this.mat
    const d = L.dims
    const mount = new THREE.Group()
    mount.position.set(L.mountX[i], L.mountY[i], 0)
    mount.rotation.z = L.mountYaw[i]
    this.body.add(mount)
    // coxa servo sits in the body, shaft vertical at the mount
    this.mesh(p.servoCase, m.servo, mount, -0.008, 0, -0.002)
    const coxa = new THREE.Group()
    mount.add(coxa)
    this.mesh(p.hornZ, m.accent, coxa, 0, 0, BODY_TOP + 0.0025)
    this.mesh(p.screw, m.metal, coxa, 0, 0, BODY_TOP + 0.003).rotation.x = Math.PI / 2
    const plateZ = SERVO.width / 2 + 0.0035
    this.mesh(p.coxaPlate, m.shell, coxa, d.coxa / 2, 0, plateZ)
    this.mesh(p.coxaPlate, m.shell, coxa, d.coxa / 2, 0, -plateZ)
    // femur servo at the end of the coxa bracket, shaft along y (tangential)
    const fs = this.mesh(p.servoCase, m.servo, coxa, d.coxa - 0.007, 0, 0)
    fs.rotation.x = Math.PI / 2
    const femur = new THREE.Group()
    femur.position.set(d.coxa, 0, 0)
    coxa.add(femur)
    this.buildFemur(L, p, femur)
    const tibia = new THREE.Group()
    tibia.position.set(d.femur, 0, 0)
    femur.add(tibia)
    this.buildTibia(L, p, tibia, i)
    return { mount, coxa, femur, tibia }
  }

  private buildFemur(L: LegLayout, p: PartSet, femur: THREE.Group): void {
    const m = this.mat
    const d = L.dims
    const side = SERVO.height / 2 + HORN.thick / 2 + 0.0004
    this.mesh(p.hornY, m.accent, femur, 0, side, 0)
    this.mesh(p.hornY, m.accent, femur, 0, -side, 0)
    const plateY = side + HORN.thick / 2 + 0.0016
    this.mesh(p.femurPlate, m.shell, femur, d.femur / 2, plateY, 0)
    this.mesh(p.femurPlate, m.shell, femur, d.femur / 2, -plateY, 0)
    this.mesh(p.femurWeb, m.shell, femur, d.femur / 2, 0, 0.004)
  }

  private buildTibia(L: LegLayout, p: PartSet, tibia: THREE.Group, i: number): void {
    const m = this.mat
    const d = L.dims
    const side = SERVO.height / 2 + HORN.thick / 2 + 0.0004
    // knee servo rides on the tibia: case length down the tibia, shaft (case height) along the hinge (y)
    const ks = this.mesh(p.servoCase, m.servo, tibia, 0, 0, -(SERVO.len / 2 - 0.007))
    ks.rotation.set(-Math.PI / 2, 0, Math.PI / 2)
    this.mesh(p.hornY, m.accent, tibia, 0, side, 0)
    this.mesh(p.hornY, m.accent, tibia, 0, -side, 0)
    this.mesh(p.tibia, m.shell, tibia, 0, 0, -0.012)
    this.mesh(p.band, m.legBands[i % m.legBands.length], tibia, 0, 0, -0.032)
    const footZ = -(d.tibia - FOOT_RADIUS)
    this.mesh(p.foot, m.accent, tibia, 0, 0, footZ)
    this.mesh(p.footRing, m.accent, tibia, 0, 0, footZ + FOOT_RADIUS * 0.75)
  }
}
