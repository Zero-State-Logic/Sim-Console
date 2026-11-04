import * as THREE from 'three'

/*
 * SWEEPER palette (frozen theme): white clear-coated plastic, brushed aluminium,
 * graphite rubber, and orange strictly for motor bells / live accents. The status LED
 * takes the drive-source color (SIM teal, HARDWARE green, CODE violet).
 */

export interface Palette {
  plastic: THREE.MeshPhysicalMaterial
  aluminium: THREE.MeshStandardMaterial
  orange: THREE.MeshStandardMaterial
  /** Orange accents that glow while active (bumper stripe on a hit). */
  live: THREE.MeshStandardMaterial
  graphite: THREE.MeshStandardMaterial
  roller: THREE.MeshStandardMaterial
  bristle: THREE.MeshStandardMaterial
  lens: THREE.MeshPhysicalMaterial
  /** Drive-source status LED. */
  led: THREE.MeshStandardMaterial
  furniture: THREE.MeshPhysicalMaterial
  furnitureSel: THREE.MeshPhysicalMaterial
  wall: THREE.MeshStandardMaterial
  hairline: THREE.LineBasicMaterial
  hairlineSel: THREE.LineBasicMaterial
}

export const ORANGE = 0xff5a1f
export const TEAL = 0x0c8f9b
export const GREEN = 0x1f9d57
export const VIOLET = 0x6c4cf0
export const INK = 0x14171a

export function makePalette(): Palette {
  return {
    plastic: new THREE.MeshPhysicalMaterial({ color: 0xf5f6f8, roughness: 0.42, metalness: 0, clearcoat: 0.45, clearcoatRoughness: 0.35 }),
    aluminium: new THREE.MeshStandardMaterial({ color: 0xc9ced3, roughness: 0.32, metalness: 0.75 }),
    orange: new THREE.MeshStandardMaterial({ color: ORANGE, roughness: 0.45, metalness: 0.05 }),
    live: new THREE.MeshStandardMaterial({ color: ORANGE, roughness: 0.4, emissive: ORANGE, emissiveIntensity: 0 }),
    graphite: new THREE.MeshStandardMaterial({ color: 0x2b3036, roughness: 0.55, metalness: 0.15 }),
    roller: new THREE.MeshStandardMaterial({ color: 0x9aa2aa, roughness: 0.78, metalness: 0 }),
    bristle: new THREE.MeshStandardMaterial({ color: 0x3a4047, roughness: 0.9 }),
    lens: new THREE.MeshPhysicalMaterial({ color: 0x1a2a2e, roughness: 0.12, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05 }),
    led: new THREE.MeshStandardMaterial({ color: TEAL, roughness: 0.3, emissive: TEAL, emissiveIntensity: 0.9 }),
    furniture: new THREE.MeshPhysicalMaterial({ color: 0xeef0f2, roughness: 0.6, clearcoat: 0.15, clearcoatRoughness: 0.6 }),
    furnitureSel: new THREE.MeshPhysicalMaterial({ color: 0xfff1ea, roughness: 0.55, emissive: ORANGE, emissiveIntensity: 0.06, clearcoat: 0.2 }),
    wall: new THREE.MeshStandardMaterial({ color: 0xf2f3f5, roughness: 0.85 }),
    hairline: new THREE.LineBasicMaterial({ color: 0xb8bec4 }),
    hairlineSel: new THREE.LineBasicMaterial({ color: ORANGE }),
  }
}

export function disposePalette(p: Palette): void {
  for (const m of Object.values(p)) m.dispose()
}

/** Status LED color for a drive source. */
export function sourceColor(source: 'sim' | 'hardware' | 'code'): number {
  return source === 'hardware' ? GREEN : source === 'code' ? VIOLET : TEAL
}
