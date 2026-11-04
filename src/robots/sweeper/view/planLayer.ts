import * as THREE from 'three'
import type { Lane } from '../coverage'
import type { Navigator } from '../navigator'
import { MAX_PATH_POINTS } from '../planningMap'
import { onOverlayLayer } from './layers'
import { ORANGE } from './materials'

/*
 * Planner overlays: the A* path as a flat orange ribbon (opaque, so the joints never
 * double up), the pure-pursuit lookahead dot, the boustrophedon lane preview (swept
 * lanes faint, the active lane orange, upcoming lanes teal) and the GOTO goal marker
 * with a pulse ring. Every buffer is preallocated; geometry is rewritten only when the
 * navigator's path or lane versions change.
 */

const PATH_Y = 0.004
const LANE_Y = 0.003
const PATH_HALF_W = 0.011
export const MAX_LANES = 640
const PULSE_PERIOD = 1.4

const TEAL = new THREE.Color(0x0c8f9b)
const HOT = new THREE.Color(ORANGE)
const INK = new THREE.Color(0x828a90)

export class PlanLayer {
  readonly group = new THREE.Group()
  /** Path, lookahead and lanes: what the PATH + LANES toggle hides (the goal stays). */
  private readonly planned = new THREE.Group()
  private readonly pathPos = new Float32Array(MAX_PATH_POINTS * 4 * 3)
  private readonly path: THREE.Mesh
  private readonly lanePos = new Float32Array(MAX_LANES * 6)
  private readonly laneCol = new Float32Array(MAX_LANES * 8)
  private readonly lanes: THREE.LineSegments
  private readonly look: THREE.Mesh
  private readonly goal = new THREE.Group()
  private readonly pulse: THREE.Mesh
  private readonly mats: THREE.Material[] = []
  private readonly geos: THREE.BufferGeometry[] = []
  private nav: Navigator | null = null
  private pathVersion = -1
  /** What the lane buffers currently show; compared field by field (no per-frame strings). */
  private readonly laneKey = { show: false, version: -1, current: -2, done: false }
  private clock = 0

  constructor() {
    const pg = this.keepGeo(new THREE.BufferGeometry())
    pg.setAttribute('position', new THREE.BufferAttribute(this.pathPos, 3).setUsage(THREE.DynamicDrawUsage))
    pg.setIndex(ribbonIndex(MAX_PATH_POINTS))
    pg.setDrawRange(0, 0)
    this.path = new THREE.Mesh(pg, this.keepMat(new THREE.MeshBasicMaterial({ color: ORANGE, side: THREE.DoubleSide })))
    this.path.frustumCulled = false
    this.path.renderOrder = 5

    const lg = this.keepGeo(new THREE.BufferGeometry())
    lg.setAttribute('position', new THREE.BufferAttribute(this.lanePos, 3).setUsage(THREE.DynamicDrawUsage))
    lg.setAttribute('color', new THREE.BufferAttribute(this.laneCol, 4).setUsage(THREE.DynamicDrawUsage))
    lg.setDrawRange(0, 0)
    this.lanes = new THREE.LineSegments(lg, this.keepMat(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false })))
    this.lanes.frustumCulled = false
    this.lanes.renderOrder = 4

    const dot = this.keepGeo(new THREE.CircleGeometry(0.018, 20).rotateX(-Math.PI / 2))
    this.look = new THREE.Mesh(dot, this.keepMat(new THREE.MeshBasicMaterial({ color: ORANGE })))
    this.look.renderOrder = 5
    this.pulse = this.buildGoal()
    this.planned.add(this.lanes, this.path, this.look)
    this.group.add(this.planned, this.goal)
    onOverlayLayer(this.group)
  }

  private keepGeo<T extends THREE.BufferGeometry>(g: T): T {
    this.geos.push(g)
    return g
  }

  private keepMat<T extends THREE.Material>(m: T): T {
    this.mats.push(m)
    return m
  }

  private buildGoal(): THREE.Mesh {
    const solid = this.keepMat(new THREE.MeshBasicMaterial({ color: ORANGE, side: THREE.DoubleSide }))
    const ring = new THREE.Mesh(this.keepGeo(new THREE.RingGeometry(0.085, 0.105, 48).rotateX(-Math.PI / 2)), solid)
    ring.position.y = 0.005
    const center = new THREE.Mesh(this.keepGeo(new THREE.CircleGeometry(0.022, 24).rotateX(-Math.PI / 2)), solid)
    center.position.y = 0.005
    const pole = new THREE.Mesh(this.keepGeo(new THREE.CylinderGeometry(0.0035, 0.0035, 0.3, 10)), solid)
    pole.position.y = 0.15
    const flagShape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.09, -0.03), new THREE.Vector2(0, -0.06)])
    const flag = new THREE.Mesh(this.keepGeo(new THREE.ShapeGeometry(flagShape)), solid)
    flag.position.set(0, 0.3, 0)
    const pulseMat = this.keepMat(new THREE.MeshBasicMaterial({ color: ORANGE, transparent: true, depthWrite: false, side: THREE.DoubleSide }))
    const pulse = new THREE.Mesh(this.keepGeo(new THREE.RingGeometry(0.1, 0.112, 48).rotateX(-Math.PI / 2)), pulseMat)
    pulse.position.y = 0.006
    this.goal.add(ring, center, pole, flag, pulse)
    this.goal.visible = false
    return pulse
  }

  /** Show the goal marker at plan (x, y), or hide it. */
  setGoal(x: number, y: number, visible: boolean): void {
    this.goal.visible = visible
    if (visible) this.goal.position.set(x, 0, -y)
  }

  sync(nav: Navigator, dt: number, show: boolean): void {
    if (nav !== this.nav) {
      // a new arena brings a new navigator whose version counters restart
      this.nav = nav
      this.pathVersion = -1
      this.laneKey.version = -1
    }
    this.planned.visible = show
    this.clock = (this.clock + dt) % PULSE_PERIOD
    if (this.goal.visible) {
      const k = this.clock / PULSE_PERIOD
      this.pulse.scale.setScalar(1 + 1.6 * k)
      ;(this.pulse.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k)
    }
    if (!show) return
    const p = nav.pursuit
    if (p.version !== this.pathVersion) {
      this.pathVersion = p.version
      const segs = writeRibbon(p.pts, p.n, PATH_HALF_W, PATH_Y, this.pathPos)
      this.path.geometry.setDrawRange(0, segs * 6)
      this.path.geometry.attributes.position.needsUpdate = true
    }
    this.look.visible = p.n > 0 && !nav.tgt.done
    if (this.look.visible) this.look.position.set(nav.tgt.x, PATH_Y + 0.0005, -nav.tgt.y)
    this.syncLanes(nav)
  }

  private syncLanes(nav: Navigator): void {
    const showLanes = nav.mode === 'coverage'
    const current = showLanes ? nav.currentLaneIndex() : -1
    const done = nav.phase === 'done'
    const k = this.laneKey
    if (k.show === showLanes && k.version === nav.lanesVersion && k.current === current && k.done === done) return
    k.show = showLanes
    k.version = nav.lanesVersion
    k.current = current
    k.done = done
    const n = showLanes ? writeLanes(nav.lanes, current, done, this.lanePos, this.laneCol) : 0
    this.lanes.geometry.setDrawRange(0, n * 2)
    this.lanes.geometry.attributes.position.needsUpdate = true
    this.lanes.geometry.attributes.color.needsUpdate = true
  }

  dispose(): void {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}

/** Index buffer for `segs` independent quads of 4 vertices. */
function ribbonIndex(segs: number): THREE.BufferAttribute {
  const idx = new Uint32Array(segs * 6)
  for (let s = 0; s < segs; s++) {
    const v = s * 4, k = s * 6
    idx[k] = v; idx[k + 1] = v + 1; idx[k + 2] = v + 2
    idx[k + 3] = v + 2; idx[k + 4] = v + 1; idx[k + 5] = v + 3
  }
  return new THREE.BufferAttribute(idx, 1)
}

/**
 * Packed plan points -> one quad per segment, each stretched by the half width at both
 * ends so consecutive quads overlap at the joints. Returns the segment count.
 */
export function writeRibbon(pts: Float64Array, n: number, hw: number, y: number, out: Float32Array): number {
  let segs = 0
  for (let i = 0; i + 1 < n && segs * 12 + 12 <= out.length; i++) {
    const ax = pts[2 * i], ay = pts[2 * i + 1]
    const bx = pts[2 * i + 2], by = pts[2 * i + 3]
    const len = Math.hypot(bx - ax, by - ay)
    if (len < 1e-6) continue
    const ux = (bx - ax) / len, uy = (by - ay) / len
    const nx = -uy * hw, ny = ux * hw
    const sx = ax - ux * hw, sy = ay - uy * hw
    const ex = bx + ux * hw, ey = by + uy * hw
    const k = segs * 12
    // plan (x, y) -> three (x, y_up, -y)
    out[k] = sx + nx; out[k + 1] = y; out[k + 2] = -(sy + ny)
    out[k + 3] = sx - nx; out[k + 4] = y; out[k + 5] = -(sy - ny)
    out[k + 6] = ex + nx; out[k + 7] = y; out[k + 8] = -(ey + ny)
    out[k + 9] = ex - nx; out[k + 10] = y; out[k + 11] = -(ey - ny)
    segs++
  }
  return segs
}

/** Lane segments with per-vertex RGBA: swept faint, active orange, upcoming teal. */
function writeLanes(lanes: readonly Lane[], current: number, allDone: boolean, pos: Float32Array, col: Float32Array): number {
  const n = Math.min(lanes.length, MAX_LANES)
  for (let i = 0; i < n; i++) {
    const l = lanes[i]
    const k = i * 6
    pos[k] = l.xs; pos[k + 1] = LANE_Y; pos[k + 2] = -l.y
    pos[k + 3] = l.xe; pos[k + 4] = LANE_Y; pos[k + 5] = -l.y
    const done = allDone || (current >= 0 && i < current)
    const c = i === current ? HOT : done ? INK : TEAL
    const a = i === current ? 0.95 : done ? 0.22 : 0.6
    for (let v = 0; v < 2; v++) {
      const j = i * 8 + v * 4
      col[j] = c.r; col[j + 1] = c.g; col[j + 2] = c.b; col[j + 3] = a
    }
  }
  return n
}
