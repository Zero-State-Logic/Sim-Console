import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { HALF_LENGTH, HALF_WIDTH, LIDAR_HEIGHT, LIDAR_OFFSET_X, WHEEL_RADIUS } from '../constants'
import { BRUSH_OFFSET_X } from '../sim'
import type { Pose2 } from '../mecanum'
import { buildWheel, disposeWheelGeometries, makeWheelGeometries, type WheelGeometries } from './mecanumWheel'
import type { Palette } from './materials'
import { ROLLER_SIGN } from './rollerLayout'

/*
 * The romi_nav twin: a lower deck between four mecanum wheels, a faceted white shell on
 * aluminium standoffs, graphite bumpers with an orange stripe that lights on a hit, the
 * LD06 puck with its spinning head at the real scan height, a roller brush under the
 * nose and two side brushes whose reach follows BRUSH WIDTH. Built in the body frame
 * (x forward, y left, z up) through bp(), which maps to three.js (x, z, -y).
 */

const SHELL_HX = 0.144
const SHELL_HY = 0.119
const SHELL_BEVEL = 0.004
const SHELL_BOTTOM = 0.09
const SHELL_DEPTH = 0.018
export const SHELL_TOP = SHELL_BOTTOM + SHELL_DEPTH + 2 * SHELL_BEVEL
const SIDE_BRUSH_REACH = 0.044
/** Just ahead of the front wheels' tread (x <= 0.135) and inside the 0.15 m nose. */
const SIDE_BRUSH_X = 0.141
const ROLLER_BRUSH_SPIN = 28
const SIDE_BRUSH_SPIN = 9
const BUMP_GLOW = 1.8

/** Wheel centers, order FL, FR, RL, RR. */
const WHEELS: readonly [number, number][] = [
  [HALF_LENGTH, HALF_WIDTH],
  [HALF_LENGTH, -HALF_WIDTH],
  [-HALF_LENGTH, HALF_WIDTH],
  [-HALF_LENGTH, -HALF_WIDTH],
]

function bp<T extends THREE.Object3D>(o: T, x: number, y: number, z: number): T {
  o.position.set(x, z, -y)
  return o
}

/** Chamfered shell outline in body (x, y): sharper chamfers at the nose, softer at the tail. */
function shellOutline(hx: number, hy: number, front: number, rear: number): THREE.Vector2[] {
  return [
    [-hx + rear, -hy], [hx - front, -hy], [hx, -hy + front], [hx, hy - front],
    [hx - front, hy], [-hx + rear, hy], [-hx, hy - rear], [-hx, -hy + rear],
  ].map(([x, y]) => new THREE.Vector2(x, y))
}

/** Side-brush hub lateral offset for a swept width: the bristle tips reach width / 2. */
export function sideBrushOffset(brushWidth: number): number {
  return Math.max(0.05, Math.min(0.13, brushWidth / 2 - SIDE_BRUSH_REACH))
}

export class RobotModel {
  readonly group = new THREE.Group()
  private readonly geos: THREE.BufferGeometry[] = []
  private readonly wheelGeo: WheelGeometries
  private readonly wheels: THREE.Group[] = []
  private readonly wheelAngle = new Float64Array(4)
  private readonly head = new THREE.Group()
  private readonly roller = new THREE.Group()
  private readonly sideBrushes: THREE.Group[] = []
  private readonly sideMounts: THREE.Group[] = []

  constructor(private readonly pal: Palette) {
    this.wheelGeo = makeWheelGeometries()
    this.group.name = 'sweeper'
    this.buildChassis()
    this.buildWheels()
    this.buildLidar()
    this.buildBrushes()
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true
    })
  }

  private geo<T extends THREE.BufferGeometry>(g: T): T {
    this.geos.push(g)
    return g
  }

  private mesh(g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.group): THREE.Mesh {
    const mesh = bp(new THREE.Mesh(g, m), x, y, z)
    parent.add(mesh)
    return mesh
  }

  private buildChassis(): void {
    const p = this.pal
    this.mesh(this.geo(new RoundedBoxGeometry(0.27, 0.03, 0.15, 2, 0.006)), p.plastic, -0.005, 0, 0.045).receiveShadow = true
    this.mesh(this.geo(new RoundedBoxGeometry(0.1, 0.022, 0.07, 2, 0.004)), p.graphite, -0.025, 0, 0.071)
    const post = this.geo(new THREE.CylinderGeometry(0.004, 0.004, SHELL_BOTTOM - 0.06, 10))
    for (const [x, y] of [[0.115, 0.055], [0.115, -0.055], [-0.115, 0.055], [-0.115, -0.055]]) this.mesh(post, p.aluminium, x, y, (SHELL_BOTTOM + 0.06) / 2)

    const outline = shellOutline(SHELL_HX, SHELL_HY, 0.045, 0.028)
    const shell = new THREE.ExtrudeGeometry(new THREE.Shape(outline), {
      depth: SHELL_DEPTH, bevelEnabled: true, bevelThickness: SHELL_BEVEL, bevelSize: SHELL_BEVEL, bevelSegments: 1,
    })
    shell.rotateX(-Math.PI / 2)
    this.mesh(this.geo(shell), p.plastic, 0, 0, SHELL_BOTTOM + SHELL_BEVEL).receiveShadow = true
    // blueprint panel line on the top cover
    const inset = shellOutline(SHELL_HX - 0.026, SHELL_HY - 0.024, 0.032, 0.018).map((v) => new THREE.Vector3(v.x, 0, -v.y))
    const panel = new THREE.LineLoop(this.geo(new THREE.BufferGeometry().setFromPoints(inset)), p.hairline)
    this.group.add(bp(panel, 0, 0, SHELL_TOP + 0.0004))
    this.mesh(this.geo(new RoundedBoxGeometry(0.05, 0.004, 0.009, 2, 0.0015)), p.led, -0.118, 0, SHELL_TOP + 0.001)
    this.buildBumpers()
  }

  private buildBumpers(): void {
    const p = this.pal
    const face = this.geo(new RoundedBoxGeometry(0.012, 0.026, 0.152, 2, 0.004))
    this.mesh(face, p.graphite, SHELL_HX - 0.002, 0, 0.075)
    this.mesh(face, p.graphite, -SHELL_HX + 0.002, 0, 0.075)
    // the stripe stays in the bloom selection so a hit glows on the very next frame
    this.mesh(this.geo(new THREE.BoxGeometry(0.003, 0.005, 0.14)), p.live, SHELL_HX + 0.0045, 0, 0.078).userData.bloom = true
  }

  private buildWheels(): void {
    const p = this.pal
    const can = this.geo(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 18).rotateX(Math.PI / 2))
    const bell = this.geo(new THREE.CylinderGeometry(0.0135, 0.0135, 0.004, 18).rotateX(Math.PI / 2))
    WHEELS.forEach(([x, y], i) => {
      const s = Math.sign(y)
      const w = buildWheel(this.wheelGeo, p, ROLLER_SIGN[i], -s)
      this.group.add(bp(w, x, y, WHEEL_RADIUS))
      this.wheels.push(w)
      this.mesh(can, p.aluminium, x, s * 0.062, WHEEL_RADIUS)
      this.mesh(bell, p.orange, x, s * 0.079, WHEEL_RADIUS)
    })
  }

  private buildLidar(): void {
    const p = this.pal
    this.mesh(this.geo(new RoundedBoxGeometry(0.038, 0.017, 0.038, 2, 0.003)), p.graphite, LIDAR_OFFSET_X, 0, SHELL_TOP + 0.0085)
    const base = SHELL_TOP + 0.017
    bp(this.head, LIDAR_OFFSET_X, 0, base)
    this.group.add(this.head)
    const h = LIDAR_HEIGHT - base
    this.mesh(this.geo(new THREE.CylinderGeometry(0.0185, 0.0185, 2 * h, 28)), p.graphite, 0, 0, h, this.head)
    this.mesh(this.geo(new THREE.BoxGeometry(0.004, 0.008, 0.015)), p.lens, 0.0172, 0, h, this.head)
    this.mesh(this.geo(new THREE.CylinderGeometry(0.012, 0.012, 0.002, 24)), p.aluminium, 0, 0, 2 * h + 0.001, this.head)
    const ring = this.mesh(this.geo(new THREE.TorusGeometry(0.0187, 0.0011, 6, 36)), p.orange, 0, 0, 0.001, this.head)
    ring.rotation.x = Math.PI / 2
  }

  private buildBrushes(): void {
    const p = this.pal
    bp(this.roller, BRUSH_OFFSET_X, 0, 0.017)
    this.group.add(this.roller)
    this.mesh(this.geo(new THREE.CylinderGeometry(0.0145, 0.0145, 0.15, 16).rotateX(Math.PI / 2)), p.bristle, 0, 0, 0, this.roller)
    const flap = this.geo(new THREE.BoxGeometry(0.0035, 0.0035, 0.15))
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2
      this.mesh(flap, p.roller, 0.015 * Math.cos(a), 0, 0.015 * Math.sin(a), this.roller)
    }
    const bearing = this.geo(new THREE.CylinderGeometry(0.0105, 0.0105, 0.005, 16).rotateX(Math.PI / 2))
    for (const s of [1, -1]) this.mesh(bearing, p.orange, BRUSH_OFFSET_X, s * 0.078, 0.017)
    this.mesh(this.geo(new RoundedBoxGeometry(0.05, 0.012, 0.17, 2, 0.004)), p.plastic, BRUSH_OFFSET_X, 0, 0.037)

    const hub = this.geo(new THREE.CylinderGeometry(0.008, 0.009, 0.007, 16))
    const tuft = this.geo(new THREE.BoxGeometry(SIDE_BRUSH_REACH - 0.006, 0.0022, 0.004).translate((SIDE_BRUSH_REACH + 0.006) / 2, 0, 0))
    const stalk = this.geo(new THREE.CylinderGeometry(0.0055, 0.0055, 0.05, 12))
    const arm = this.geo(new RoundedBoxGeometry(0.018, 0.01, 0.06, 2, 0.003))
    for (const s of [1, -1]) {
      const mount = new THREE.Group()
      this.group.add(mount)
      this.mesh(stalk, p.graphite, 0, 0, 0.034, mount)
      this.mesh(arm, p.graphite, 0, s * -0.03, 0.06, mount)
      const brush = new THREE.Group()
      this.mesh(hub, p.orange, 0, 0, 0.0035, brush)
      for (let k = 0; k < 3; k++) {
        const t = this.mesh(tuft, p.bristle, 0, 0, 0.002, brush)
        t.rotation.set(0, (k * 2 * Math.PI) / 3, -0.08)
      }
      mount.add(brush)
      this.sideBrushes.push(brush)
      this.sideMounts.push(mount)
    }
    this.setBrushWidth(0.3)
  }

  /** Move the side brushes so their bristle tips sweep `width` meters. */
  setBrushWidth(width: number): void {
    const y = sideBrushOffset(width)
    this.sideMounts.forEach((m, i) => bp(m, SIDE_BRUSH_X, i === 0 ? y : -y, 0.006))
  }

  setSourceColor(hex: number): void {
    this.pal.led.color.setHex(hex)
    this.pal.led.emissive.setHex(hex)
  }

  /**
   * Pose the model. `wheels` are actual wheel speeds (rad/s), `head` the LD06 head angle
   * (rad, body frame), `brushing` spins the brushes, `bump` lights the bumper stripe.
   */
  update(pose: Pose2, wheels: ArrayLike<number>, dt: number, head: number, brushing: boolean, bump: boolean): void {
    this.group.position.set(pose.x, 0, -pose.y)
    this.group.rotation.y = pose.th
    for (let i = 0; i < 4; i++) {
      // wrap so the angle never grows into float noise over a long run
      this.wheelAngle[i] = (this.wheelAngle[i] + wheels[i] * dt) % (2 * Math.PI)
      this.wheels[i].rotation.z = -this.wheelAngle[i]
    }
    this.head.rotation.y = head
    if (brushing && dt > 0) {
      this.roller.rotation.z = (this.roller.rotation.z + ROLLER_BRUSH_SPIN * dt) % (2 * Math.PI)
      this.sideBrushes[0].rotation.y = (this.sideBrushes[0].rotation.y - SIDE_BRUSH_SPIN * dt) % (2 * Math.PI)
      this.sideBrushes[1].rotation.y = (this.sideBrushes[1].rotation.y + SIDE_BRUSH_SPIN * dt) % (2 * Math.PI)
    }
    this.pal.live.emissiveIntensity = bump ? BUMP_GLOW : 0
  }

  /** Wheel spin angle (rad), for tests. */
  wheelSpin(i: number): number {
    return this.wheelAngle[i]
  }

  dispose(): void {
    for (const g of this.geos) g.dispose()
    disposeWheelGeometries(this.wheelGeo)
  }
}
