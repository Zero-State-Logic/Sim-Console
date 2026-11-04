import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { wrapBeltOffset, TreadmillBelt } from './treadmill'
import { WalkerVisual } from './WalkerVisual'
import { createMaterials, materialList } from './materials'
import { buildParts, partList } from './parts'
import { buildLayout, DEFAULT_DIMS, LEG_COUNTS } from '../geometry'
import { WalkerSim } from '../sim'

describe('wrapBeltOffset', () => {
  it('moves the belt by whole lattice periods only, so the dot pattern is unchanged', () => {
    const out: [number, number] = [0, 0]
    for (const [x, y, a] of [[0.13, -0.07, 0], [1.234, 5.6, 0.7], [-3.3, 0.02, -2.5]]) {
      wrapBeltOffset(x, y, a, 0.05, out)
      // the difference, in belt axes, is a lattice vector
      const dx = x - out[0]
      const dy = y - out[1]
      const bx = Math.cos(a) * dx + Math.sin(a) * dy
      const by = -Math.sin(a) * dx + Math.cos(a) * dy
      expect(Math.abs(bx / 0.05 - Math.round(bx / 0.05))).toBeLessThan(1e-9)
      expect(Math.abs(by / 0.05 - Math.round(by / 0.05))).toBeLessThan(1e-9)
      expect(Math.hypot(out[0], out[1])).toBeLessThanOrEqual(0.05 * Math.SQRT1_2 + 1e-12)
    }
  })

  it('shows the belt only while the treadmill runs', () => {
    const belt = new TreadmillBelt()
    belt.update(false, 1, 1, 0)
    expect(belt.object.visible).toBe(false)
    belt.update(true, 0.01, 0, 0.3)
    expect(belt.object.visible).toBe(true)
    expect(belt.object.rotation.z).toBe(0.3)
    belt.dispose()
  })
})

describe('WalkerVisual', () => {
  it('builds a rig per leg count with orange servo horns and feet, and poses it from the state', () => {
    const mats = createMaterials()
    const v = new WalkerVisual(mats)
    for (const n of LEG_COUNTS) {
      const sim = new WalkerSim(n)
      v.build(sim.layout)
      v.apply(sim.state, n, true)
      let accent = 0
      let shadowCasters = 0
      v.frame.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        if (m.material === mats.accent) accent++
        if (m.castShadow) shadowCasters++
      })
      // per leg: coxa horn, 2 femur horns, 2 knee horns, foot cap, foot ring
      expect(accent).toBe(n * 7)
      expect(shadowCasters).toBeGreaterThan(n * 10)
    }
    const f = v.followPoint(new WalkerSim(6).state, new THREE.Vector3())
    expect(f.y).toBeCloseTo(0.085, 9)
    v.dispose()
    for (const m of materialList(mats)) m.dispose()
  })

  it('makes fresh part geometry for every layout so dimensions change the meshes', () => {
    const a = buildParts(buildLayout(6, DEFAULT_DIMS))
    const b = buildParts(buildLayout(6, { ...DEFAULT_DIMS, femur: 0.1 }))
    a.femurPlate.computeBoundingBox()
    b.femurPlate.computeBoundingBox()
    const len = (g: THREE.BufferGeometry): number => (g.boundingBox as THREE.Box3).max.x - (g.boundingBox as THREE.Box3).min.x
    expect(len(b.femurPlate) - len(a.femurPlate)).toBeCloseTo(0.025, 6)
    for (const g of [...partList(a), ...partList(b)]) g.dispose()
  })
})
