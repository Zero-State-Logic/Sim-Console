import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { WALL_HEIGHT, WALL_THICKNESS } from '../constants'
import type { Obstacle } from '../geom2d'
import { onOverlayLayer } from './layers'
import type { Palette } from './materials'

/*
 * The room: white walls with hairline top edges, a faint floor tint over the blueprint
 * grid with ruler ticks every 0.5 m outside the walls, registration corners, and one
 * mesh per obstacle (rounded furniture boxes, cylinders) with hairline edges. Obstacle
 * meshes carry userData.obstacleId for picking. Flat floor marks live on the overlay
 * layer (see layers.ts) so the contact-shadow camera never sees them.
 */

const FLOOR_Y = 0.0003
const TICK = 0.5
const TICK_LEN = 0.05
const TICK_MAJOR = 0.1
const CORNER = 0.22

interface ObstacleMesh {
  mesh: THREE.Mesh
  edges: THREE.LineSegments
  geos: THREE.BufferGeometry[]
}

export interface PickHit {
  id: number
  /** Hit point in plan coordinates and its height. */
  x: number
  y: number
  h: number
}

export class ArenaView {
  readonly group = new THREE.Group()
  private readonly room = new THREE.Group()
  private readonly obstacleGroup = new THREE.Group()
  private readonly items = new Map<number, ObstacleMesh>()
  private roomGeos: THREE.BufferGeometry[] = []
  private readonly floorMat = new THREE.MeshBasicMaterial({ color: 0xf7f8f9, transparent: true, opacity: 0.55, depthWrite: false })
  private readonly tickMat = new THREE.LineBasicMaterial({ color: 0x828a90, transparent: true, opacity: 0.8, depthWrite: false })
  private readonly cornerMat = new THREE.LineBasicMaterial({ color: 0x4a5157, depthWrite: false })
  private selected: number | null = null
  private readonly hits: THREE.Intersection[] = []

  constructor(private readonly pal: Palette) {
    this.group.name = 'arena'
    this.group.add(this.room, this.obstacleGroup)
  }

  /** Rebuild walls and floor marks for a room of side `size`. */
  buildRoom(size: number): void {
    for (const g of this.roomGeos) g.dispose()
    this.roomGeos = []
    this.room.clear()
    const half = size / 2
    const t = WALL_THICKNESS
    const ns = this.keep(new THREE.BoxGeometry(size + 2 * t, WALL_HEIGHT, t))
    const ew = this.keep(new THREE.BoxGeometry(t, WALL_HEIGHT, size))
    const nsEdge = this.keep(new THREE.EdgesGeometry(ns))
    const ewEdge = this.keep(new THREE.EdgesGeometry(ew))
    const walls: [THREE.BufferGeometry, THREE.BufferGeometry, number, number][] = [
      [ns, nsEdge, 0, -(half + t / 2)],
      [ns, nsEdge, 0, half + t / 2],
      [ew, ewEdge, half + t / 2, 0],
      [ew, ewEdge, -(half + t / 2), 0],
    ]
    for (const [g, e, x, z] of walls) {
      const wall = new THREE.Mesh(g, this.pal.wall)
      wall.position.set(x, WALL_HEIGHT / 2, z)
      wall.castShadow = true
      wall.receiveShadow = true
      wall.add(new THREE.LineSegments(e, this.pal.hairline))
      this.room.add(wall)
    }
    const floor = new THREE.Mesh(this.keep(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2)), this.floorMat)
    floor.position.y = FLOOR_Y
    floor.renderOrder = 1
    this.room.add(onOverlayLayer(floor))
    this.room.add(onOverlayLayer(new THREE.LineSegments(this.keep(rulerGeometry(half + t + 0.03)), this.tickMat)))
    this.room.add(onOverlayLayer(new THREE.LineSegments(this.keep(cornerGeometry(half + t + 0.08)), this.cornerMat)))
  }

  private keep<T extends THREE.BufferGeometry>(g: T): T {
    this.roomGeos.push(g)
    return g
  }

  /** Replace every obstacle mesh. */
  setObstacles(obstacles: readonly Obstacle[], selected: number | null): void {
    for (const it of this.items.values()) disposeItem(it)
    this.items.clear()
    this.obstacleGroup.clear()
    this.selected = selected
    for (const o of obstacles) {
      const it = this.makeItem(o)
      this.items.set(o.id, it)
      this.obstacleGroup.add(it.mesh)
      this.place(it, o)
    }
    this.applySelection()
  }

  private makeItem(o: Obstacle): ObstacleMesh {
    const body = o.kind === 'box'
      ? new RoundedBoxGeometry(o.w, o.hgt, o.h, 2, Math.min(0.025, o.w / 4, o.h / 4, o.hgt / 4))
      : new THREE.CylinderGeometry(o.r, o.r, o.hgt, 40)
    const outline = o.kind === 'box'
      ? new THREE.EdgesGeometry(new THREE.BoxGeometry(o.w, o.hgt, o.h))
      : new THREE.EdgesGeometry(new THREE.CylinderGeometry(o.r, o.r, o.hgt, 40), 20)
    const mesh = new THREE.Mesh(body, this.pal.furniture)
    mesh.castShadow = true
    mesh.receiveShadow = true
    // white furniture must never enter the selective bloom, even when selected
    mesh.userData.bloom = false
    mesh.userData.obstacleId = o.id
    const edges = new THREE.LineSegments(outline, this.pal.hairline)
    edges.userData.bloom = false
    mesh.add(edges)
    return { mesh, edges, geos: [body, outline] }
  }

  private place(it: ObstacleMesh, o: Obstacle): void {
    it.mesh.position.set(o.x, o.hgt / 2, -o.y)
    it.mesh.rotation.y = o.kind === 'box' ? o.a : 0
  }

  /** Move one obstacle mesh (drag). Unknown ids are ignored. */
  moveObstacle(o: Obstacle): void {
    const it = this.items.get(o.id)
    if (it) this.place(it, o)
  }

  setSelected(id: number | null): void {
    this.selected = id
    this.applySelection()
  }

  private applySelection(): void {
    for (const [id, it] of this.items) {
      const on = id === this.selected
      it.mesh.material = on ? this.pal.furnitureSel : this.pal.furniture
      it.edges.material = on ? this.pal.hairlineSel : this.pal.hairline
    }
  }

  /** First obstacle under the pointer ray, or null. */
  pick(raycaster: THREE.Raycaster): PickHit | null {
    this.hits.length = 0
    // an obstacle added or moved since the last render still has its old world matrix
    this.obstacleGroup.updateWorldMatrix(true, true)
    raycaster.intersectObjects(this.obstacleGroup.children, false, this.hits)
    const h = this.hits.find((x) => typeof x.object.userData.obstacleId === 'number')
    if (!h) return null
    return { id: h.object.userData.obstacleId as number, x: h.point.x, y: -h.point.z, h: h.point.y }
  }

  dispose(): void {
    for (const it of this.items.values()) disposeItem(it)
    this.items.clear()
    for (const g of this.roomGeos) g.dispose()
    this.roomGeos = []
    this.floorMat.dispose()
    this.tickMat.dispose()
    this.cornerMat.dispose()
  }
}

function disposeItem(it: ObstacleMesh): void {
  for (const g of it.geos) g.dispose()
}

/** Ruler ticks on the floor just outside the walls: every 0.5 m, longer every meter. */
function rulerGeometry(r: number): THREE.BufferGeometry {
  const pts: number[] = []
  const n = Math.floor(r / TICK + 1e-6)
  for (let i = -n; i <= n; i++) {
    const s = i * TICK
    const len = i % 2 === 0 ? TICK_MAJOR : TICK_LEN
    for (const side of [-1, 1]) {
      pts.push(s, FLOOR_Y, side * r, s, FLOOR_Y, side * (r + len))
      pts.push(side * r, FLOOR_Y, s, side * (r + len), FLOOR_Y, s)
    }
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
}

/** Registration corners (the signature L marks) outside the four room corners. */
function cornerGeometry(r: number): THREE.BufferGeometry {
  const pts: number[] = []
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * r, z = sz * r
      pts.push(x, FLOOR_Y, z, x - sx * CORNER, FLOOR_Y, z)
      pts.push(x, FLOOR_Y, z, x, FLOOR_Y, z - sz * CORNER)
    }
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
}
