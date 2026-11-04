import * as THREE from 'three'

/*
 * Flight trail: a fixed-size line whose newest point is always the last vertex.
 * New samples shift the position buffer left (copyWithin, no allocation); the
 * per-vertex alpha ramp is static, so old points fade out for free.
 */

export const TRAIL_POINTS = 240
/** Samples per second (240 points = 20 s of history). */
export const TRAIL_HZ = 12

export class Trail {
  readonly line: THREE.Line
  private readonly pos: Float32Array
  private readonly attr: THREE.BufferAttribute
  private readonly geo: THREE.BufferGeometry
  private readonly mat: THREE.LineBasicMaterial
  private count = 0

  constructor(color: string) {
    this.pos = new Float32Array(TRAIL_POINTS * 3)
    const col = new Float32Array(TRAIL_POINTS * 4)
    const c = new THREE.Color(color)
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const f = i / (TRAIL_POINTS - 1)
      col[4 * i] = c.r
      col[4 * i + 1] = c.g
      col[4 * i + 2] = c.b
      col[4 * i + 3] = 0.75 * f * f
    }
    this.geo = new THREE.BufferGeometry()
    this.attr = new THREE.BufferAttribute(this.pos, 3)
    this.attr.setUsage(THREE.DynamicDrawUsage)
    this.geo.setAttribute('position', this.attr)
    this.geo.setAttribute('color', new THREE.BufferAttribute(col, 4))
    this.geo.setDrawRange(TRAIL_POINTS, 0)
    this.mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false })
    this.line = new THREE.Line(this.geo, this.mat)
    this.line.frustumCulled = false
  }

  push(x: number, y: number, z: number): void {
    const p = this.pos
    p.copyWithin(0, 3)
    const o = (TRAIL_POINTS - 1) * 3
    p[o] = x
    p[o + 1] = y
    p[o + 2] = z
    if (this.count < TRAIL_POINTS) this.count++
    this.geo.setDrawRange(TRAIL_POINTS - this.count, this.count)
    this.attr.needsUpdate = true
  }

  clear(): void {
    this.count = 0
    this.geo.setDrawRange(TRAIL_POINTS, 0)
  }

  dispose(): void {
    this.geo.dispose()
    this.mat.dispose()
    this.line.removeFromParent()
  }
}
