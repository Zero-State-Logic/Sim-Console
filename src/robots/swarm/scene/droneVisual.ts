import * as THREE from 'three'
import type { Drone } from '../sim/drone'
import { SPIN } from '../sim/mixer'
import { simQuatToThree, simToThree } from '../sim/frames'
import type { Kit } from './kit'
import { DANGER, castShadows } from './kit'

/*
 * One X-frame quad: faceted white shell, white arms, dark stators under orange
 * motor bells, two-blade props with a translucent blur disc that thickens with
 * rotor speed, a per-drone status LED and a soft blob shadow on the ground.
 * Three.js local axes: +X forward, +Y up, +Z right (sim FLU mapped to Y-up).
 */

const D = 0.12 / Math.SQRT2
/** Motor i in three.js local coords (sim (x, y) -> three (x, -y)). */
const MOTOR_XZ: readonly (readonly [number, number])[] = [[D, -D], [D, D], [-D, D], [-D, -D]]
/** Rotation about +Y that points local +X along each arm. */
const ARM_YAW: readonly number[] = [Math.PI / 4, -Math.PI / 4, (-3 * Math.PI) / 4, (3 * Math.PI) / 4]
/** Visual prop spin per rad/s of rotor speed (real speeds alias at 60 fps). */
const VIS_SPIN = 0.024
const LEG_R = 0.07
/** Parsed once: Color.set(string) runs a regex, too slow for a per-frame path. */
const DANGER_COLOR = new THREE.Color(DANGER)

export interface DroneVisualOpts {
  vscale: number
  /** Seconds, for LED blink phase. */
  time: number
  leader: boolean
}

export class DroneVisual {
  readonly group = new THREE.Group()
  readonly shadow: THREE.Mesh
  private readonly props: THREE.Group[] = []
  private readonly blades: THREE.Mesh[] = []
  private readonly bladeMat: THREE.MeshStandardMaterial
  private readonly discMat: THREE.MeshBasicMaterial
  private readonly ledMat: THREE.MeshBasicMaterial
  private readonly shadowMat: THREE.MeshBasicMaterial
  private readonly baseColor: THREE.Color
  private readonly spin = new Float64Array(4)
  private readonly own: { dispose(): void }[] = []

  constructor(kit: Kit, color: string) {
    this.baseColor = new THREE.Color(color)
    this.bladeMat = this.keep(new THREE.MeshStandardMaterial({ color: 0xeceef0, roughness: 0.5, transparent: true }))
    this.discMat = this.keep(new THREE.MeshBasicMaterial({ color: 0x9aa3aa, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }))
    this.ledMat = this.keep(new THREE.MeshBasicMaterial({ color: this.baseColor.clone() }))
    this.shadowMat = this.keep(new THREE.MeshBasicMaterial({
      color: kit.shadowTex ? 0xffffff : 0x14171a,
      map: kit.shadowTex,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    }))
    this.buildAirframe(kit)
    this.shadow = new THREE.Mesh(kit.geo.shadow, this.shadowMat)
    this.shadow.renderOrder = -1
  }

  private keep<T extends { dispose(): void }>(d: T): T {
    this.own.push(d)
    return d
  }

  private buildAirframe(kit: Kit): void {
    const g = kit.geo, m = kit.mat
    const body = new THREE.Group()
    body.add(new THREE.Mesh(g.body, m.shell), new THREE.Mesh(g.canopy, m.shell), new THREE.Mesh(g.plate, m.plate))
    const nose = new THREE.Mesh(g.nose, m.stator)
    nose.position.set(0.066, 0, 0)
    const led = new THREE.Mesh(g.led, this.ledMat)
    led.position.set(-0.058, 0.012, 0)
    body.add(nose, led)
    for (let i = 0; i < 4; i++) {
      const arm = new THREE.Mesh(g.arm, m.shell)
      arm.rotation.y = ARM_YAW[i]
      body.add(arm)
      body.add(this.buildMotor(kit, i))
      const ang = ARM_YAW[i]
      const leg = new THREE.Group()
      leg.position.set(LEG_R * Math.cos(ang), 0, -LEG_R * Math.sin(ang))
      leg.add(new THREE.Mesh(g.leg, m.shell), new THREE.Mesh(g.foot, m.rubber))
      body.add(leg)
    }
    castShadows(body)
    this.group.add(body)
  }

  private buildMotor(kit: Kit, i: number): THREE.Group {
    const g = kit.geo, m = kit.mat
    const motor = new THREE.Group()
    motor.position.set(MOTOR_XZ[i][0], 0.0055, MOTOR_XZ[i][1])
    motor.add(new THREE.Mesh(g.stator, m.stator), new THREE.Mesh(g.bell, m.accent))
    const prop = new THREE.Group()
    prop.position.y = 0.031
    const blade = new THREE.Mesh(g.blade, this.bladeMat)
    blade.castShadow = true
    const disc = new THREE.Mesh(g.disc, this.discMat)
    disc.renderOrder = 2
    prop.add(blade, disc)
    prop.rotation.y = i * 0.7
    motor.add(prop)
    this.props.push(prop)
    this.blades.push(blade)
    return motor
  }

  /** Pose, props, LED and shadow from the drone state. Allocation-free. */
  update(d: Drone, dt: number, o: DroneVisualOpts, lead = 0): void {
    const s = d.s
    // `lead`: frame time the physics has not stepped yet (see SwarmSim.renderLead)
    simToThree(this.group.position, s[0] + s[3] * lead, s[1] + s[4] * lead, s[2] + s[5] * lead)
    simQuatToThree(this.group.quaternion, s[6], s[7], s[8], s[9])
    this.group.scale.setScalar(o.vscale)
    // the CoM sits gearHeight above the feet; lift the scaled airframe so its feet stay on the ground
    this.group.position.y += 0.035 * (o.vscale - 1)
    this.updateProps(d, dt)
    this.updateLed(d, o)
    const alt = Math.max(0, s[2])
    this.shadow.position.set(this.group.position.x, 0.004, this.group.position.z)
    this.shadow.scale.setScalar(o.vscale * (1 + alt * 0.06))
    this.shadowMat.opacity = 0.34 * Math.max(0.15, 1 - alt / 14)
  }

  private updateProps(d: Drone, dt: number): void {
    let mean = 0
    for (let i = 0; i < 4; i++) {
      const w = d.omega[i]
      mean += w
      this.spin[i] = (this.spin[i] + SPIN[i] * w * VIS_SPIN * dt) % (Math.PI * 2)
      this.props[i].rotation.y = this.spin[i] + i * 0.7
    }
    const f = Math.min(1, mean / 4 / 1800)
    this.discMat.opacity = f * 0.26
    this.bladeMat.opacity = 1 - 0.82 * f
    for (const b of this.blades) b.visible = this.bladeMat.opacity > 0.12
  }

  private updateLed(d: Drone, o: DroneVisualOpts): void {
    const c = this.ledMat.color
    if (d.mode === 'crashed') {
      c.copy(DANGER_COLOR)
      c.multiplyScalar(Math.sin(o.time * 12) > 0 ? 1 : 0.25)
      return
    }
    c.copy(this.baseColor)
    if (d.lowBattery) c.multiplyScalar(Math.sin(o.time * 20) > 0 ? 1 : 0.2)
    else if (!d.armed) c.multiplyScalar(0.45)
    else if (o.leader) c.multiplyScalar(1.25 + 0.25 * Math.sin(o.time * 6))
  }

  dispose(): void {
    for (const r of this.own) r.dispose()
    this.group.removeFromParent()
    this.shadow.removeFromParent()
  }
}
