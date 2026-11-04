import * as THREE from 'three'

/*
 * Shared geometries and materials for the swarm scene. Built once per module and
 * disposed with it. Real 250-class dimensions (meters); the drone group is scaled
 * up visually by the DRONE SCALE control only.
 */

export const DRONE_COLORS: readonly string[] = ['#FF5A1F', '#0C8F9B', '#6C4CF0', '#1F9D57', '#E8A200', '#2D7DD2']
export const INK_2 = '#828A90'
export const LINE_STRONG = '#B8BEC4'
export const ACCENT = '#FF5A1F'
export const DANGER = '#D11F2D'

export interface Kit {
  geo: {
    body: THREE.BufferGeometry
    canopy: THREE.BufferGeometry
    plate: THREE.BufferGeometry
    arm: THREE.BufferGeometry
    stator: THREE.BufferGeometry
    bell: THREE.BufferGeometry
    blade: THREE.BufferGeometry
    disc: THREE.BufferGeometry
    leg: THREE.BufferGeometry
    foot: THREE.BufferGeometry
    led: THREE.BufferGeometry
    nose: THREE.BufferGeometry
    shadow: THREE.BufferGeometry
    wpRing: THREE.BufferGeometry
    wpStem: THREE.BufferGeometry
    wpDot: THREE.BufferGeometry
    pad: THREE.BufferGeometry
    padRing: THREE.BufferGeometry
    padBar: THREE.BufferGeometry
  }
  mat: {
    shell: THREE.MeshPhysicalMaterial
    plate: THREE.MeshStandardMaterial
    accent: THREE.MeshStandardMaterial
    stator: THREE.MeshStandardMaterial
    rubber: THREE.MeshStandardMaterial
    wpRing: THREE.MeshStandardMaterial
    wpRingActive: THREE.MeshStandardMaterial
    wpStem: THREE.MeshBasicMaterial
    wpDot: THREE.MeshBasicMaterial
    pad: THREE.MeshStandardMaterial
    padBar: THREE.MeshBasicMaterial
    route: THREE.LineDashedMaterial
    frame: THREE.LineBasicMaterial
    tether: THREE.LineBasicMaterial
  }
  /** Radial falloff texture for blob shadows (null outside a browser). */
  shadowTex: THREE.Texture | null
}

function flat(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.rotateX(-Math.PI / 2)
  return g
}

function buildGeometries(): Kit['geo'] {
  const body = new THREE.CylinderGeometry(0.042, 0.05, 0.026, 8)
  body.rotateY(Math.PI / 8)
  body.scale(1.35, 1, 1)
  const canopy = new THREE.CylinderGeometry(0.024, 0.036, 0.018, 8)
  canopy.rotateY(Math.PI / 8)
  canopy.scale(1.3, 1, 1)
  canopy.translate(0, 0.022, 0)
  const plate = new THREE.BoxGeometry(0.115, 0.005, 0.075)
  plate.translate(0, -0.016, 0)
  const arm = new THREE.BoxGeometry(0.12, 0.011, 0.016)
  arm.translate(0.06, 0, 0)
  return {
    body,
    canopy,
    plate,
    arm,
    stator: new THREE.CylinderGeometry(0.0125, 0.014, 0.009, 18).translate(0, 0.01, 0),
    bell: new THREE.CylinderGeometry(0.0145, 0.0145, 0.013, 24).translate(0, 0.021, 0),
    blade: new THREE.BoxGeometry(0.127, 0.0016, 0.011),
    disc: flat(new THREE.CircleGeometry(0.066, 40)),
    leg: new THREE.CylinderGeometry(0.0028, 0.0028, 0.026, 6).translate(0, -0.022, 0),
    foot: new THREE.SphereGeometry(0.0045, 8, 6).translate(0, -0.0345, 0),
    led: new THREE.SphereGeometry(0.0065, 12, 8),
    nose: new THREE.BoxGeometry(0.014, 0.012, 0.022),
    shadow: flat(new THREE.CircleGeometry(0.22, 32)),
    wpRing: new THREE.TorusGeometry(0.32, 0.022, 10, 48).rotateX(Math.PI / 2),
    wpStem: new THREE.CylinderGeometry(0.008, 0.008, 1, 6).translate(0, 0.5, 0),
    wpDot: flat(new THREE.RingGeometry(0.1, 0.15, 32)),
    pad: flat(new THREE.CircleGeometry(0.46, 48)),
    padRing: flat(new THREE.RingGeometry(0.4, 0.46, 48)),
    padBar: new THREE.BoxGeometry(0.42, 0.002, 0.03),
  }
}

function buildMaterials(): Kit['mat'] {
  return {
    shell: new THREE.MeshPhysicalMaterial({ color: 0xf4f5f6, roughness: 0.38, metalness: 0, clearcoat: 0.45, clearcoatRoughness: 0.25, flatShading: true }),
    plate: new THREE.MeshStandardMaterial({ color: 0xd6dadd, roughness: 0.6, metalness: 0.15 }),
    accent: new THREE.MeshStandardMaterial({ color: ACCENT, roughness: 0.35, metalness: 0.2 }),
    stator: new THREE.MeshStandardMaterial({ color: 0x2b3034, roughness: 0.45, metalness: 0.6 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x3a4045, roughness: 0.9 }),
    wpRing: new THREE.MeshStandardMaterial({ color: ACCENT, roughness: 0.4, emissive: ACCENT, emissiveIntensity: 0.15 }),
    wpRingActive: new THREE.MeshStandardMaterial({ color: ACCENT, roughness: 0.3, emissive: ACCENT, emissiveIntensity: 0.75 }),
    wpStem: new THREE.MeshBasicMaterial({ color: INK_2, transparent: true, opacity: 0.55 }),
    wpDot: new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }),
    pad: new THREE.MeshStandardMaterial({ color: 0xe6e9ec, roughness: 0.85 }),
    padBar: new THREE.MeshBasicMaterial({ color: LINE_STRONG }),
    route: new THREE.LineDashedMaterial({ color: INK_2, dashSize: 0.35, gapSize: 0.22, transparent: true, opacity: 0.85 }),
    frame: new THREE.LineBasicMaterial({ color: LINE_STRONG, transparent: true, opacity: 0.9 }),
    tether: new THREE.LineBasicMaterial({ color: INK_2, transparent: true, opacity: 0.45 }),
  }
}

/** Soft radial falloff drawn on a canvas; null when there is no DOM (tests). */
function buildShadowTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const g = c.getContext('2d')
  if (!g) return null
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(20,23,26,0.55)')
  grad.addColorStop(0.55, 'rgba(20,23,26,0.22)')
  grad.addColorStop(1, 'rgba(20,23,26,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export function createKit(): Kit {
  return { geo: buildGeometries(), mat: buildMaterials(), shadowTex: buildShadowTexture() }
}

export function disposeKit(k: Kit): void {
  for (const g of Object.values(k.geo)) g.dispose()
  for (const m of Object.values(k.mat)) m.dispose()
  k.shadowTex?.dispose()
}

/** Mark every mesh under obj as a shadow caster (and receiver when asked). */
export function castShadows(obj: THREE.Object3D, receive = false): void {
  obj.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true
      o.receiveShadow = receive
    }
  })
}
