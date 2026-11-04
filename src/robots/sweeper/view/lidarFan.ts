import * as THREE from 'three'
import { LIDAR_HEIGHT } from '../constants'
import type { Ld06 } from '../lidar'
import { onOverlayLayer } from './layers'

/*
 * The live LD06 fan at the real scan height: one thin ray and one orange hit point per
 * sample, from where the sensor was when the sample was taken (a moving robot smears
 * its scan, as the real one does). Fresh samples are brightest, so the turning head is
 * visible. Buffers are preallocated and rewritten in place every frame.
 */

const RAY_ALPHA = 0.3
const HIT_MIN_ALPHA = 0.3
// THREE.Color converts the sRGB theme hex to the linear values vertex colors expect
const RAY = new THREE.Color(0x0c8f9b)
const HIT = new THREE.Color(0xff5a1f)
const RAY_RGB = [RAY.r, RAY.g, RAY.b] as const
const HIT_RGB = [HIT.r, HIT.g, HIT.b] as const

export class LidarFan {
  readonly group = new THREE.Group()
  private readonly rayPos: Float32Array
  private readonly rayCol: Float32Array
  private readonly hitPos: Float32Array
  private readonly hitCol: Float32Array
  private readonly rays: THREE.LineSegments
  private readonly hits: THREE.Points

  constructor(samples: number) {
    this.rayPos = new Float32Array(samples * 6)
    this.rayCol = new Float32Array(samples * 8)
    this.hitPos = new Float32Array(samples * 3)
    this.hitCol = new Float32Array(samples * 4)
    const rg = new THREE.BufferGeometry()
    rg.setAttribute('position', new THREE.BufferAttribute(this.rayPos, 3).setUsage(THREE.DynamicDrawUsage))
    rg.setAttribute('color', new THREE.BufferAttribute(this.rayCol, 4).setUsage(THREE.DynamicDrawUsage))
    this.rays = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }))
    const hg = new THREE.BufferGeometry()
    hg.setAttribute('position', new THREE.BufferAttribute(this.hitPos, 3).setUsage(THREE.DynamicDrawUsage))
    hg.setAttribute('color', new THREE.BufferAttribute(this.hitCol, 4).setUsage(THREE.DynamicDrawUsage))
    this.hits = new THREE.Points(hg, new THREE.PointsMaterial({ size: 3.2, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false }))
    // the fan sweeps the whole room: never cull it on a stale bounding sphere
    this.rays.frustumCulled = false
    this.hits.frustumCulled = false
    this.rays.renderOrder = 6
    this.hits.renderOrder = 7
    this.group.add(this.rays, this.hits)
    onOverlayLayer(this.group)
  }

  set visible(v: boolean) {
    this.group.visible = v
  }

  /** Rewrite the buffers from the sensor's sample ring. */
  sync(lidar: Ld06): void {
    const n = lidar.samples
    const newest = (lidar.cursor - 1 + n) % n
    const rp = this.rayPos, rc = this.rayCol, hp = this.hitPos, hc = this.hitCol
    const y = LIDAR_HEIGHT
    for (let i = 0; i < n; i++) {
      const hit = lidar.ranges[i] > 0
      const fresh = 1 - ((newest - i + n) % n) / n
      const ox = lidar.ox[i], oz = -lidar.oy[i]
      const ex = hit ? lidar.ex[i] : ox, ez = hit ? -lidar.ey[i] : oz
      const k6 = i * 6, k8 = i * 8, k3 = i * 3, k4 = i * 4
      rp[k6] = ox; rp[k6 + 1] = y; rp[k6 + 2] = oz
      rp[k6 + 3] = ex; rp[k6 + 4] = y; rp[k6 + 5] = ez
      const ra = hit ? RAY_ALPHA * fresh * fresh : 0
      for (let v = 0; v < 2; v++) {
        rc[k8 + v * 4] = RAY_RGB[0]
        rc[k8 + v * 4 + 1] = RAY_RGB[1]
        rc[k8 + v * 4 + 2] = RAY_RGB[2]
        // the ray fades toward its far end
        rc[k8 + v * 4 + 3] = v === 0 ? ra : ra * 0.35
      }
      hp[k3] = ex; hp[k3 + 1] = y; hp[k3 + 2] = ez
      hc[k4] = HIT_RGB[0]
      hc[k4 + 1] = HIT_RGB[1]
      hc[k4 + 2] = HIT_RGB[2]
      hc[k4 + 3] = hit ? HIT_MIN_ALPHA + (1 - HIT_MIN_ALPHA) * fresh : 0
    }
    this.rays.geometry.attributes.position.needsUpdate = true
    this.rays.geometry.attributes.color.needsUpdate = true
    this.hits.geometry.attributes.position.needsUpdate = true
    this.hits.geometry.attributes.color.needsUpdate = true
  }

  dispose(): void {
    this.rays.geometry.dispose()
    ;(this.rays.material as THREE.Material).dispose()
    this.hits.geometry.dispose()
    ;(this.hits.material as THREE.Material).dispose()
  }
}
