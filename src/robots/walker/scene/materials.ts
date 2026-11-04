import * as THREE from 'three'

/* Shared materials for the walker. Created once per module, disposed with it. */

/** Per-leg categorical colors, matching the frozen --l1..--l8 tokens. */
export const LEG_COLORS = [0xff5a1f, 0x0c8f9b, 0x6c4cf0, 0x1f9d57, 0xe8a200, 0x2d7dd2, 0xd6337c, 0x5a6570]
export const SIM_TEAL = 0x0c8f9b
export const DANGER = 0xd11f2d

export interface WalkerMaterials {
  /** White injection-moulded plastic with a light clearcoat. */
  shell: THREE.MeshPhysicalMaterial
  /** Slightly brighter, glossier cover panels. */
  cover: THREE.MeshPhysicalMaterial
  /** Dark servo cases and chassis plate. */
  servo: THREE.MeshStandardMaterial
  /** Orange servo horns, foot caps: the accent. */
  accent: THREE.MeshStandardMaterial
  /** Brushed aluminium screws / spacers. */
  metal: THREE.MeshStandardMaterial
  /** Glowing status LED. */
  led: THREE.MeshStandardMaterial
  lens: THREE.MeshPhysicalMaterial
  legBands: THREE.MeshStandardMaterial[]
  panelLine: THREE.LineBasicMaterial
  contact: THREE.MeshBasicMaterial
  support: THREE.LineBasicMaterial
  com: THREE.MeshBasicMaterial
}

export function createMaterials(): WalkerMaterials {
  return {
    shell: new THREE.MeshPhysicalMaterial({ color: 0xf2f3f5, roughness: 0.44, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.4 }),
    cover: new THREE.MeshPhysicalMaterial({ color: 0xfbfbfc, roughness: 0.36, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.25 }),
    servo: new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.58, metalness: 0.08 }),
    accent: new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.38, metalness: 0.05 }),
    metal: new THREE.MeshStandardMaterial({ color: 0xc9ced3, roughness: 0.3, metalness: 0.85 }),
    led: new THREE.MeshStandardMaterial({ color: 0xff5a1f, emissive: 0xff5a1f, emissiveIntensity: 2.4, roughness: 0.3 }),
    lens: new THREE.MeshPhysicalMaterial({ color: 0x15181b, roughness: 0.08, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 }),
    legBands: LEG_COLORS.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45 })),
    panelLine: new THREE.LineBasicMaterial({ color: 0xb8bec4 }),
    contact: new THREE.MeshBasicMaterial({ color: 0xff5a1f, transparent: true, opacity: 0.9, depthWrite: false }),
    support: new THREE.LineBasicMaterial({ color: SIM_TEAL, transparent: true, opacity: 0.95, depthWrite: false }),
    com: new THREE.MeshBasicMaterial({ color: 0x14171a, depthWrite: false }),
  }
}

export function materialList(m: WalkerMaterials): THREE.Material[] {
  return [m.shell, m.cover, m.servo, m.accent, m.metal, m.led, m.lens, ...m.legBands, m.panelLine, m.contact, m.support, m.com]
}
