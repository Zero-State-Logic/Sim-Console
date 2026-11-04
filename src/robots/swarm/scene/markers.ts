import * as THREE from 'three'
import { simToThree } from '../sim/frames'
import type { Kit } from './kit'
import { ACCENT } from './kit'
import { numberTexture } from './labels'

/*
 * World furniture: waypoint markers (orange ring at cruise altitude, hairline stem,
 * ground ring, numbered badge), the dashed route polyline, ghost formation slots
 * shaped like a quad's outline, error tethers, landing pads and the flight-volume
 * registration corners (the theme's .reg motif, laid on the ground).
 */

const v = new THREE.Vector3()

class WaypointMarker {
  readonly group = new THREE.Group()
  readonly ring: THREE.Mesh
  readonly stem: THREE.Mesh
  label: THREE.Sprite | null = null

  constructor(kit: Kit, readonly index: number) {
    this.ring = new THREE.Mesh(kit.geo.wpRing, kit.mat.wpRing)
    this.ring.castShadow = true
    this.stem = new THREE.Mesh(kit.geo.wpStem, kit.mat.wpStem)
    const dot = new THREE.Mesh(kit.geo.wpDot, kit.mat.wpDot)
    dot.position.y = 0.003
    this.group.add(this.ring, this.stem, dot)
    this.group.visible = false
  }
}

export class WaypointLayer {
  readonly group = new THREE.Group()
  private readonly markers: WaypointMarker[] = []
  private readonly route: THREE.Line
  private readonly routePos: Float32Array
  private readonly labelMats: THREE.SpriteMaterial[] = []
  private readonly textures: THREE.Texture[] = []
  private readonly routeGeo = new THREE.BufferGeometry()

  constructor(private readonly kit: Kit, private readonly capacity: number) {
    this.routePos = new Float32Array((capacity + 1) * 3)
    this.routeGeo.setAttribute('position', new THREE.BufferAttribute(this.routePos, 3))
    this.route = new THREE.Line(this.routeGeo, kit.mat.route)
    this.route.frustumCulled = false
    this.group.add(this.route)
  }

  private marker(i: number): WaypointMarker {
    let m = this.markers[i]
    if (m) return m
    m = new WaypointMarker(this.kit, i)
    const tex = numberTexture(i + 1, ACCENT, '#14171A')
    if (tex) {
      this.textures.push(tex)
      const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false })
      this.labelMats.push(mat)
      m.label = new THREE.Sprite(mat)
      m.label.scale.setScalar(0.5)
      m.group.add(m.label)
    }
    this.markers[i] = m
    this.group.add(m.group)
    return m
  }

  /** Rebuild marker placement from sim-frame waypoints (x, y pairs) at altitude. */
  layout(wps: Float64Array, n: number, alt: number, closed: boolean): void {
    for (let i = 0; i < Math.max(n, this.markers.length); i++) {
      if (i >= n) {
        if (this.markers[i]) this.markers[i].group.visible = false
        continue
      }
      const m = this.marker(i)
      simToThree(v, wps[2 * i], wps[2 * i + 1], 0)
      m.group.position.copy(v)
      m.group.visible = true
      m.ring.position.y = alt
      m.stem.scale.y = alt
      if (m.label) m.label.position.y = alt + 0.55
    }
    let k = 0
    for (let i = 0; i < n; i++) k = this.routePoint(k, wps, i, alt)
    if (closed && n > 2) k = this.routePoint(k, wps, 0, alt)
    this.routeGeo.setDrawRange(0, k)
    ;(this.routeGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true
    this.route.computeLineDistances()
    this.route.visible = n > 1
  }

  private routePoint(k: number, wps: Float64Array, i: number, alt: number): number {
    simToThree(v, wps[2 * i], wps[2 * i + 1], alt)
    this.routePos[3 * k] = v.x
    this.routePos[3 * k + 1] = v.y
    this.routePos[3 * k + 2] = v.z
    return k + 1
  }

  /** Highlight the waypoint being flown to and the one under the pointer (-1 = none). */
  highlight(active: number, n: number, time: number, hover: number): void {
    for (let i = 0; i < n; i++) {
      const m = this.markers[i]
      if (!m) continue
      const on = i === active
      m.ring.material = on || i === hover ? this.kit.mat.wpRingActive : this.kit.mat.wpRing
      const pulse = on ? 1 + 0.12 * Math.sin(time * 5) : 1
      m.ring.scale.setScalar(i === hover ? pulse * 1.25 : pulse)
    }
  }

  dispose(): void {
    this.routeGeo.dispose()
    for (const m of this.labelMats) m.dispose()
    for (const t of this.textures) t.dispose()
  }
}

/** Quad-outline ghost geometry: an X plus four prop circles, as line segments. */
function ghostGeometry(): THREE.BufferGeometry {
  const d = 0.12 / Math.SQRT2
  const pts: number[] = [-d, 0, -d, d, 0, d, -d, 0, d, d, 0, -d]
  const seg = 20
  const r = 0.066
  for (const [cx, cz] of [[d, d], [d, -d], [-d, d], [-d, -d]]) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2
      pts.push(cx + r * Math.cos(a0), 0, cz + r * Math.sin(a0), cx + r * Math.cos(a1), 0, cz + r * Math.sin(a1))
    }
  }
  // heading tick
  pts.push(0.03, 0, 0, 0.1, 0, 0)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return g
}

export class SlotLayer {
  readonly group = new THREE.Group()
  readonly ghosts: THREE.LineSegments[] = []
  private readonly geo = ghostGeometry()
  private readonly mats: THREE.LineBasicMaterial[] = []
  private readonly tetherPos: Float32Array
  private readonly tetherGeo = new THREE.BufferGeometry()
  readonly tether: THREE.LineSegments

  constructor(kit: Kit, colors: readonly string[], max: number) {
    for (let i = 0; i < max; i++) {
      const mat = new THREE.LineBasicMaterial({ color: colors[i % colors.length], transparent: true, opacity: 0.6, depthWrite: false })
      this.mats.push(mat)
      const g = new THREE.LineSegments(this.geo, mat)
      g.visible = false
      this.ghosts.push(g)
      this.group.add(g)
    }
    this.tetherPos = new Float32Array(max * 6)
    this.tetherGeo.setAttribute('position', new THREE.BufferAttribute(this.tetherPos, 3))
    this.tether = new THREE.LineSegments(this.tetherGeo, kit.mat.tether)
    this.tether.frustumCulled = false
    this.group.add(this.tether)
  }

  /** Place ghost i at a three.js point with a heading; tether it to the drone. */
  place(i: number, target: THREE.Vector3, yaw: number, scale: number, from: THREE.Vector3 | null): void {
    const g = this.ghosts[i]
    g.visible = true
    g.position.copy(target)
    g.rotation.set(0, yaw, 0)
    g.scale.setScalar(scale)
    const o = 6 * i
    const a = from ?? target
    this.tetherPos[o] = a.x
    this.tetherPos[o + 1] = a.y
    this.tetherPos[o + 2] = a.z
    this.tetherPos[o + 3] = target.x
    this.tetherPos[o + 4] = target.y
    this.tetherPos[o + 5] = target.z
  }

  hide(i: number): void {
    this.ghosts[i].visible = false
    this.tetherPos.fill(0, 6 * i, 6 * i + 6)
  }

  commit(): void {
    ;(this.tetherGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  dispose(): void {
    this.geo.dispose()
    this.tetherGeo.dispose()
    for (const m of this.mats) m.dispose()
  }
}

/** Landing pads: a light disc, a coloured rim and an H in hairlines. */
export function buildPad(kit: Kit, color: string, own: { dispose(): void }[]): THREE.Group {
  const g = new THREE.Group()
  const disc = new THREE.Mesh(kit.geo.pad, kit.mat.pad)
  disc.receiveShadow = true
  disc.position.y = 0.001
  const rimMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false })
  own.push(rimMat)
  const rim = new THREE.Mesh(kit.geo.padRing, rimMat)
  rim.position.y = 0.002
  const a = new THREE.Mesh(kit.geo.padBar, kit.mat.padBar)
  a.position.set(0, 0.003, 0)
  const b = a.clone()
  b.rotation.y = Math.PI / 2
  b.scale.set(0.55, 1, 1)
  b.position.set(0.13, 0.003, 0)
  const c = b.clone()
  c.position.x = -0.13
  g.add(disc, rim, a, b, c)
  return g
}

/** Registration-corner brackets on the ground plus faint corner verticals. */
export function buildVolumeFrame(kit: Kit, half: number, height: number): { obj: THREE.LineSegments; geo: THREE.BufferGeometry } {
  const L = 1.2
  const pts: number[] = []
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * half, z = sz * half
      pts.push(x, 0.005, z, x - sx * L, 0.005, z, x, 0.005, z, x, 0.005, z - sz * L)
      pts.push(x, 0, z, x, height, z)
      pts.push(x, height, z, x - sx * L * 0.6, height, z, x, height, z, x, height, z - sz * L * 0.6)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return { obj: new THREE.LineSegments(geo, kit.mat.frame), geo }
}

