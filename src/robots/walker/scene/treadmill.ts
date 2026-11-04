import * as THREE from 'three'

/* ============================================================
   TREADMILL BELT — a faded dot lattice on the ground that moves
   with the planted feet while the treadmill keeps the body centred,
   so stance feet read as planted on a moving belt, not skating over
   the grid. Built in the walker's Z-up frame. The lattice is
   periodic, so the belt offset is wrapped by one period and a
   finite disc of dots looks endless.
   ============================================================ */

const PERIOD = 0.05
const RADIUS = 0.55
const DOT = 0.0045
const LIFT = 0.0006
const INK = 0x9aa2a9
const PAPER = 0xfdfdfe

/** Belt offset (x, y) wrapped to the lattice cell nearest the origin, in world axes. Pure, for tests. */
export function wrapBeltOffset(x: number, y: number, angle: number, period: number, out: [number, number]): [number, number] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  let bx = c * x + s * y
  let by = -s * x + c * y
  bx -= period * Math.round(bx / period)
  by -= period * Math.round(by / period)
  out[0] = c * bx - s * by
  out[1] = s * bx + c * by
  return out
}

export class TreadmillBelt {
  readonly object: THREE.Points
  private readonly geometry = new THREE.BufferGeometry()
  private readonly material = new THREE.PointsMaterial({ size: DOT, sizeAttenuation: true, vertexColors: true, depthWrite: false })
  private readonly wrapped: [number, number] = [0, 0]

  constructor() {
    const pos: number[] = []
    const col: number[] = []
    const ink = new THREE.Color(INK)
    const paper = new THREE.Color(PAPER)
    const c = new THREE.Color()
    const k = Math.ceil(RADIUS / PERIOD)
    for (let i = -k; i <= k; i++) {
      for (let j = -k; j <= k; j++) {
        const x = i * PERIOD
        const y = j * PERIOD
        const r = Math.hypot(x, y) / RADIUS
        if (r > 1) continue
        // smooth fade to the paper colour at the rim
        const fade = 1 - r * r * (3 - 2 * r)
        c.copy(paper).lerp(ink, fade)
        pos.push(x, y, 0)
        col.push(c.r, c.g, c.b)
      }
    }
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    this.object = new THREE.Points(this.geometry, this.material)
    this.object.visible = false
    this.object.renderOrder = 1
    this.object.frustumCulled = false
    this.object.userData.bloom = false
  }

  /** Belt pose from the gait engine: a belt point p sits at R(angle)·p + (x, y). */
  update(visible: boolean, x: number, y: number, angle: number): void {
    this.object.visible = visible
    if (!visible) return
    const w = wrapBeltOffset(x, y, angle, PERIOD, this.wrapped)
    this.object.position.set(w[0], w[1], LIFT)
    this.object.rotation.z = angle
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}
