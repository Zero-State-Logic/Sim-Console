import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { SweeperSim } from '../sim'
import { OVERLAY_LAYER } from './layers'
import { makePalette, sourceColor } from './materials'
import { PlanLayer, writeRibbon } from './planLayer'
import { RobotModel, SHELL_TOP, sideBrushOffset } from './robotModel'
import { SweeperView } from './SweeperView'

const FLAGS = { map: true, coverage: true, rays: true, plan: true }

/*
 * Exact (per-vertex) bounds of the robot's rigid parts. Instanced rollers are left out:
 * their AABB is conservative, and their true envelope is the wheel circle, which the
 * roller-layout tests pin down. Passing the bristle material also drops the soft tufts.
 */
function solidBox(r: RobotModel, bristle: THREE.Material | null): THREE.Box3 {
  const box = new THREE.Box3()
  r.group.updateWorldMatrix(true, true)
  r.group.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || (o as THREE.InstancedMesh).isInstancedMesh) return
    if (bristle && m.material === bristle && m.geometry.type === 'BoxGeometry') return
    box.union(new THREE.Box3().setFromObject(m, true))
  })
  return box
}

describe('path ribbon', () => {
  it('writes one quad per segment, half-width off the centerline, in three.js axes', () => {
    // Arrange: an L path in plan coordinates
    const pts = new Float64Array([0, 0, 1, 0, 1, 1])
    const out = new Float32Array(64)
    // Act
    const segs = writeRibbon(pts, 3, 0.01, 0.004, out)
    // Assert: first quad spans x -0.01..1.01 at plan y = +-0.01 (three z = -+0.01)
    expect(segs).toBe(2)
    expect(out[0]).toBeCloseTo(-0.01)
    expect(out[2]).toBeCloseTo(-0.01)
    expect(out[5]).toBeCloseTo(0.01)
    expect(out[6]).toBeCloseTo(1.01)
    expect(out[1]).toBeCloseTo(0.004)
  })

  it('keeps the goal marker visible when PATH + LANES is switched off', () => {
    // Arrange
    const sim = new SweeperSim(6, [])
    const layer = new PlanLayer()
    layer.setGoal(1, 1, true)
    // Act
    layer.sync(sim.nav, 0.1, false)
    // Assert: every ring (goal + pulse) is visible all the way up its ancestor chain
    const rings: THREE.Object3D[] = []
    layer.group.traverse((o) => {
      if ((o as THREE.Mesh).geometry?.type === 'RingGeometry') rings.push(o)
    })
    expect(rings.length).toBe(2)
    for (let o: THREE.Object3D | null = rings[0]; o; o = o.parent) expect(o.visible).toBe(true)
    layer.dispose()
  })

  it('skips zero-length segments and stops at the buffer end', () => {
    expect(writeRibbon(new Float64Array([0, 0, 0, 0, 1, 0]), 3, 0.01, 0, new Float32Array(64))).toBe(1)
    expect(writeRibbon(new Float64Array([0, 0, 1, 0, 2, 0]), 3, 0.01, 0, new Float32Array(12))).toBe(1)
  })
})

describe('robot model', () => {
  it('sits on the floor under the LD06 and follows the plan pose (x, y, heading)', () => {
    const r = new RobotModel(makePalette())
    r.update({ x: 1, y: 2, th: 0.5 }, [0, 0, 0, 0], 0, 0, false, false)
    expect(r.group.position.toArray()).toEqual([1, 0, -2])
    expect(r.group.rotation.y).toBe(0.5)
    expect(SHELL_TOP).toBeLessThan(0.142)
    expect(solidBox(r, null).min.y).toBeGreaterThanOrEqual(-1e-6)
    r.dispose()
  })

  it('spins every wheel forward by speed x dt and lights the bumper on a hit', () => {
    const pal = makePalette()
    const r = new RobotModel(pal)
    r.update({ x: 0, y: 0, th: 0 }, [10, -10, 5, 0], 0.1, 0, true, true)
    expect(r.wheelSpin(0)).toBeCloseTo(1)
    expect(r.wheelSpin(1)).toBeCloseTo(-1)
    expect(r.wheelSpin(2)).toBeCloseTo(0.5)
    expect(pal.live.emissiveIntensity).toBeGreaterThan(0)
    r.update({ x: 0, y: 0, th: 0 }, [0, 0, 0, 0], 0.1, 0, true, false)
    expect(pal.live.emissiveIntensity).toBe(0)
    r.dispose()
  })

  it('stays inside the 0.30 x 0.25 m collision footprint apart from the soft side-brush bristles', () => {
    const pal = makePalette()
    const r = new RobotModel(pal)
    r.setBrushWidth(0.12)
    r.update({ x: 0, y: 0, th: 0 }, [0, 0, 0, 0], 0, 0, false, false)
    const box = solidBox(r, pal.bristle)
    expect(box.max.x).toBeLessThanOrEqual(0.15 + 1e-6)
    expect(box.min.x).toBeGreaterThanOrEqual(-0.15 - 1e-6)
    expect(Math.max(box.max.z, -box.min.z)).toBeLessThanOrEqual(0.125 + 1e-6)
    r.dispose()
  })

  it('places the side brushes so their tips reach half the brush width', () => {
    expect(sideBrushOffset(0.3) + 0.044).toBeCloseTo(0.15)
    expect(sideBrushOffset(0.05)).toBe(0.05)
  })
})

describe('sweeper view', () => {
  it('keeps flat overlays off the contact-shadow layer and solid parts on it', () => {
    const sim = new SweeperSim()
    const v = new SweeperView(sim)
    sim.step(0.3)
    v.sync(sim, 0.3, FLAGS)
    let overlays = 0
    let solids = 0
    v.root.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh && !(o as THREE.Points).isPoints && !(o as THREE.Line).isLine) return
      if (o.layers.isEnabled(OVERLAY_LAYER)) overlays++
      else if (o.layers.isEnabled(0)) solids++
    })
    expect(overlays).toBeGreaterThan(5)
    expect(solids).toBeGreaterThan(30)
    v.dispose()
  })

  it('picks an obstacle under the pointer ray and reports the hit in plan coordinates', () => {
    const sim = new SweeperSim(6, [{ kind: 'box', id: 7, x: 1, y: 1, w: 0.5, h: 0.5, a: 0, hgt: 0.4 }])
    const v = new SweeperView(sim)
    const hit = v.pick(new THREE.Raycaster(new THREE.Vector3(1.1, 3, -1.05), new THREE.Vector3(0, -1, 0)))
    expect(hit?.id).toBe(7)
    expect(hit?.x).toBeCloseTo(1.1)
    expect(hit?.y).toBeCloseTo(1.05)
    expect(hit?.h).toBeCloseTo(0.4)
    expect(v.pick(new THREE.Raycaster(new THREE.Vector3(-1, 3, 1), new THREE.Vector3(0, -1, 0)))).toBeNull()
    v.dispose()
  })

  it('follows the robot and colors the status LED by drive source', () => {
    const sim = new SweeperSim()
    const v = new SweeperView(sim)
    expect(v.followTarget(sim).x).toBeCloseTo(sim.pose.x)
    expect(v.followTarget(sim).z).toBeCloseTo(-sim.pose.y)
    expect(sourceColor('hardware')).toBe(0x1f9d57)
    expect(sourceColor('code')).toBe(0x6c4cf0)
    expect(sourceColor('sim')).toBe(0x0c8f9b)
    v.dispose()
  })
})
