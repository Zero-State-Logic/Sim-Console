import * as THREE from 'three'
import { SelectiveBloomEffect } from 'postprocessing'

/*
 * Which objects the selective bloom catches: anything whose material glows (a non-black
 * emissive), plus explicit opt-ins. Modules control it per object with
 * `object.userData.bloom = true | false`. White clearcoat glints never bloom, because
 * the bloom only sees selected objects.
 */

/** Emissive luminance (linear, × intensity) below which a material is not "glowing". */
export const EMISSIVE_MIN = 0.02

/** Threshold sits above lit orange plastic (~0.26 luminance) so only emissive adds glow. */
export const BLOOM_OPTIONS = { luminanceThreshold: 0.3, luminanceSmoothing: 0.25, intensity: 0.75, radius: 0.55, mipmapBlur: true } as const

/**
 * The accent bloom. postprocessing keeps background (max-depth) pixels in the selective
 * bloom input by default; on this near-white stage that is most of the frame (the grid
 * discards its empty fragments and the shadow catcher writes no depth), so the floor
 * would bloom and wash out edges and grid lines. Masking the background leaves only the
 * selected objects.
 */
export function createAccentBloom(scene: THREE.Scene, camera: THREE.Camera): SelectiveBloomEffect {
  const bloom = new SelectiveBloomEffect(scene, camera, { ...BLOOM_OPTIONS })
  bloom.ignoreBackground = true
  bloom.inverted = false
  return bloom
}

type Renderable = THREE.Mesh | THREE.Points | THREE.Line | THREE.Sprite

function isRenderable(o: THREE.Object3D): o is Renderable {
  return (o as THREE.Mesh).isMesh === true || (o as THREE.Points).isPoints === true || (o as THREE.Line).isLine === true || (o as THREE.Sprite).isSprite === true
}

export function emissiveLuminance(m: THREE.Material): number {
  const mat = m as THREE.Material & { emissive?: THREE.Color; emissiveIntensity?: number }
  if (!mat.emissive || !(mat.emissive instanceof THREE.Color)) return 0
  const c = mat.emissive
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * (mat.emissiveIntensity ?? 1)
}

export function isBloomTarget(o: THREE.Object3D): boolean {
  const flag = o.userData?.bloom
  if (flag === false) return false
  if (!isRenderable(o)) return false
  if (flag === true) return true
  const mats = Array.isArray(o.material) ? o.material : [o.material]
  return mats.some((m) => m && emissiveLuminance(m) > EMISSIVE_MIN)
}

export function collectBloomTargets(root: THREE.Object3D, out: THREE.Object3D[] = []): THREE.Object3D[] {
  out.length = 0
  root.traverse((o) => {
    if (isBloomTarget(o)) out.push(o)
  })
  return out
}

export function sameSelection(a: readonly THREE.Object3D[], b: readonly THREE.Object3D[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
