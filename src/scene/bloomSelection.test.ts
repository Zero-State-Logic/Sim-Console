import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { SelectiveBloomEffect } from 'postprocessing'
import { BLOOM_OPTIONS, collectBloomTargets, createAccentBloom, emissiveLuminance, isBloomTarget, sameSelection } from './bloomSelection'

const box = new THREE.BoxGeometry(1, 1, 1)
const mesh = (mat: THREE.Material): THREE.Mesh => new THREE.Mesh(box, mat)

describe('bloom selection', () => {
  it('measures emissive luminance scaled by intensity', () => {
    const m = new THREE.MeshStandardMaterial({ emissive: 0xffffff, emissiveIntensity: 2 })
    expect(emissiveLuminance(m)).toBeCloseTo(2)
    expect(emissiveLuminance(new THREE.MeshBasicMaterial())).toBe(0)
  })

  it('selects meshes with a glowing emissive and skips plain white plastic', () => {
    // Arrange
    const glow = mesh(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xff5a1f, emissiveIntensity: 1 }))
    const white = mesh(new THREE.MeshPhysicalMaterial({ color: 0xffffff, clearcoat: 0.5 }))
    const dim = mesh(new THREE.MeshStandardMaterial({ emissive: 0xff5a1f, emissiveIntensity: 0.01 }))
    // Act + Assert
    expect(isBloomTarget(glow)).toBe(true)
    expect(isBloomTarget(white)).toBe(false)
    expect(isBloomTarget(dim)).toBe(false)
  })

  it('honours explicit userData.bloom opt-in and opt-out', () => {
    const basic = mesh(new THREE.MeshBasicMaterial({ color: 0xff5a1f }))
    basic.userData.bloom = true
    const glow = mesh(new THREE.MeshStandardMaterial({ emissive: 0xffffff }))
    glow.userData.bloom = false
    expect(isBloomTarget(basic)).toBe(true)
    expect(isBloomTarget(glow)).toBe(false)
    const group = new THREE.Group()
    group.userData.bloom = true
    expect(isBloomTarget(group)).toBe(false)
  })

  it('checks every material of a multi-material mesh', () => {
    const m = new THREE.Mesh(box, [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial({ emissive: 0xff5a1f })])
    expect(isBloomTarget(m)).toBe(true)
  })

  it('collects targets from a whole subtree into a reused array', () => {
    const root = new THREE.Group()
    const a = mesh(new THREE.MeshStandardMaterial({ emissive: 0xff5a1f }))
    const b = mesh(new THREE.MeshStandardMaterial())
    const nested = new THREE.Group()
    const c = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial())
    c.userData.bloom = true
    nested.add(c)
    root.add(a, b, nested)
    const out: THREE.Object3D[] = [b]
    expect(collectBloomTargets(root, out)).toEqual([a, c])
    expect(out).toEqual([a, c])
  })

  it('compares selections by identity and order', () => {
    const a = new THREE.Object3D()
    const b = new THREE.Object3D()
    expect(sameSelection([a, b], [a, b])).toBe(true)
    expect(sameSelection([a, b], [b, a])).toBe(false)
    expect(sameSelection([a], [a, b])).toBe(false)
  })
})

describe('accent bloom effect', () => {
  it('masks out background pixels so the white floor never feeds the bloom', () => {
    // Arrange + Act
    const bloom = createAccentBloom(new THREE.Scene(), new THREE.PerspectiveCamera())
    // Assert: postprocessing defaults to keeping max-depth (background) pixels
    expect(new SelectiveBloomEffect(new THREE.Scene(), new THREE.PerspectiveCamera()).ignoreBackground).toBe(false)
    expect(bloom.ignoreBackground).toBe(true)
    expect(bloom.inverted).toBe(false)
    bloom.dispose()
  })

  it('keeps the threshold above lit orange plastic so only emissive accents glow', () => {
    // linear luminance of #FF5A1F under a white key light of intensity ~1
    const orange = new THREE.Color(0xff5a1f)
    const lum = 0.2126 * orange.r + 0.7152 * orange.g + 0.0722 * orange.b
    expect(BLOOM_OPTIONS.luminanceThreshold).toBeGreaterThan(lum)
  })
})
