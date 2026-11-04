import * as THREE from 'three'
import type { CoverageMap } from '../coverage'
import type { GridGeom, OccupancyGrid } from '../occupancy'
import { onOverlayLayer } from './layers'
import { paintCoverage, paintOccupancy } from './mapColors'

/*
 * Occupancy and coverage overlays: two DataTextures on floor planes, one texel per grid
 * cell, nearest filtering so the cells read as a real grid. Uploads are throttled to
 * 10 Hz and skipped when the map version did not change.
 */

const UPLOAD_PERIOD = 0.1
const MAP_Y = 0.0012
const COVER_Y = 0.0018

class Overlay {
  readonly mesh: THREE.Mesh
  readonly tex: THREE.DataTexture
  readonly data: Uint8Array
  version = -1

  constructor(g: GridGeom, y: number, order: number) {
    this.data = new Uint8Array(g.w * g.h * 4)
    this.tex = new THREE.DataTexture(this.data, g.w, g.h, THREE.RGBAFormat, THREE.UnsignedByteType)
    this.tex.magFilter = THREE.NearestFilter
    this.tex.minFilter = THREE.NearestFilter
    this.tex.colorSpace = THREE.SRGBColorSpace
    this.tex.needsUpdate = true
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false })
    // PlaneGeometry uv v runs along +plane y, which rotateX(-pi/2) turns into -z = +plan y
    const geo = new THREE.PlaneGeometry(g.w * g.cell, g.h * g.cell).rotateX(-Math.PI / 2)
    this.mesh = new THREE.Mesh(geo, mat)
    this.mesh.position.set(g.x0 + (g.w * g.cell) / 2, y, -(g.y0 + (g.h * g.cell) / 2))
    this.mesh.renderOrder = order
    onOverlayLayer(this.mesh)
  }

  dispose(): void {
    this.tex.dispose()
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}

export class MapLayer {
  readonly group = new THREE.Group()
  private occ: Overlay | null = null
  private cov: Overlay | null = null
  private timer = 0

  /** New textures for a new grid size (arena resize). */
  rebuild(g: GridGeom): void {
    this.disposeOverlays()
    this.occ = new Overlay(g, MAP_Y, 2)
    this.cov = new Overlay(g, COVER_Y, 3)
    this.group.add(this.occ.mesh, this.cov.mesh)
    this.timer = 0
  }

  /** `force` uploads now (paused edits, RESET MAP), otherwise at most every 0.1 s. */
  sync(grid: OccupancyGrid, coverage: CoverageMap, dt: number, showMap: boolean, showCoverage: boolean, force: boolean): void {
    const occ = this.occ, cov = this.cov
    if (!occ || !cov) return
    occ.mesh.visible = showMap
    cov.mesh.visible = showCoverage
    this.timer -= dt
    if (!force && this.timer > 0) return
    this.timer = UPLOAD_PERIOD
    if (showMap && occ.version !== grid.version) {
      paintOccupancy(grid.lo, grid.contact, occ.data)
      occ.tex.needsUpdate = true
      occ.version = grid.version
    }
    if (showCoverage && cov.version !== coverage.version) {
      paintCoverage(coverage.covered, cov.data)
      cov.tex.needsUpdate = true
      cov.version = coverage.version
    }
  }

  private disposeOverlays(): void {
    for (const o of [this.occ, this.cov]) {
      if (!o) continue
      o.mesh.removeFromParent()
      o.dispose()
    }
    this.occ = null
    this.cov = null
  }

  dispose(): void {
    this.disposeOverlays()
  }
}
