import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { FOOT_RADIUS, type LegLayout } from '../geometry'

/* ============================================================
   PART GEOMETRY — built in the walker's Z-up frame (x forward).
   One set per build (leg count / dimensions); every leg shares it.
   Sizes are hobby-hexapod scale, meters.
   ============================================================ */

export const SERVO = { len: 0.03, width: 0.016, height: 0.026 }
export const HORN = { radius: 0.0088, thick: 0.003 }
const PLATE = 0.003
const BODY_DEPTH = 0.022
const BODY_BEVEL = 0.006
/** Top of the body shell above the mount plane. */
export const BODY_TOP = BODY_DEPTH / 2 + BODY_BEVEL

export interface PartSet {
  bodyShell: THREE.BufferGeometry
  bodyCover: THREE.BufferGeometry
  bodyPlate: THREE.BufferGeometry
  panelLine: THREE.BufferGeometry
  sensor: THREE.BufferGeometry
  lens: THREE.BufferGeometry
  led: THREE.BufferGeometry
  servoCase: THREE.BufferGeometry
  hornZ: THREE.BufferGeometry
  hornY: THREE.BufferGeometry
  screw: THREE.BufferGeometry
  coxaPlate: THREE.BufferGeometry
  femurPlate: THREE.BufferGeometry
  femurWeb: THREE.BufferGeometry
  tibia: THREE.BufferGeometry
  band: THREE.BufferGeometry
  foot: THREE.BufferGeometry
  footRing: THREE.BufferGeometry
  contactRing: THREE.BufferGeometry
  comBar: THREE.BufferGeometry
  comRing: THREE.BufferGeometry
  /** Front-most x of the body outline (for the sensor head). */
  frontX: number
}

/** Body outline: the mount points pushed out so the coxa servos sit under the shell. */
export function bodyOutline(L: LegLayout, scale = 1): THREE.Vector2[] {
  const k = ((L.dims.bodyRadius + 0.016) / L.dims.bodyRadius) * scale
  const pts: { a: number; p: THREE.Vector2 }[] = []
  for (let i = 0; i < L.n; i++) pts.push({ a: Math.atan2(L.mountY[i], L.mountX[i]), p: new THREE.Vector2(L.mountX[i] * k, L.mountY[i] * k) })
  pts.sort((x, y) => x.a - y.a)
  return pts.map((x) => x.p)
}

function extruded(outline: THREE.Vector2[], depth: number, bevel: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(outline), {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 1,
  })
  g.translate(0, 0, -depth / 2)
  g.computeVertexNormals()
  return g
}

function panelLoop(outline: THREE.Vector2[], z: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(outline.flatMap((p) => [p.x, p.y, z]), 3))
  return g
}

/** Tapered blade from the knee (z = 0) down to the foot cap, thickness along y. */
function tibiaBlade(length: number): THREE.BufferGeometry {
  const top = 0.012
  const bottom = 0.0055
  const s = new THREE.Shape()
  s.moveTo(-top, 0)
  s.lineTo(top, 0)
  s.lineTo(bottom, -length)
  s.lineTo(-bottom, -length)
  s.closePath()
  const depth = 0.008
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.0018, bevelSize: 0.0018, bevelSegments: 1, curveSegments: 1 })
  g.translate(0, 0, -depth / 2)
  // shape plane XY → tibia plane XZ (shape y becomes z)
  g.rotateX(Math.PI / 2)
  g.computeVertexNormals()
  return g
}

function rounded(x: number, y: number, z: number, r: number): THREE.BufferGeometry {
  return new RoundedBoxGeometry(x, y, z, 2, r)
}

export function buildParts(L: LegLayout): PartSet {
  const d = L.dims
  const outline = bodyOutline(L)
  const hornY = new THREE.CylinderGeometry(HORN.radius, HORN.radius, HORN.thick, 28)
  const hornZ = hornY.clone().rotateX(Math.PI / 2)
  const tibiaLen = Math.max(0.02, d.tibia - 2 * FOOT_RADIUS)
  let frontX = 0
  for (const p of outline) if (Math.abs(p.y) < d.bodyRadius) frontX = Math.max(frontX, p.x)
  return {
    bodyShell: extruded(outline, BODY_DEPTH, BODY_BEVEL),
    bodyCover: extruded(bodyOutline(L, 0.62), 0.004, 0.0018),
    bodyPlate: extruded(bodyOutline(L, 0.9), 0.004, 0),
    panelLine: panelLoop(bodyOutline(L, 0.74), BODY_TOP + 0.0004),
    sensor: rounded(0.014, 0.042, 0.016, 0.004),
    lens: new THREE.SphereGeometry(0.0052, 18, 12),
    led: new THREE.CylinderGeometry(0.0038, 0.0038, 0.003, 18).rotateX(Math.PI / 2),
    servoCase: rounded(SERVO.len, SERVO.width, SERVO.height, 0.0022),
    hornZ,
    hornY,
    screw: new THREE.CylinderGeometry(0.0022, 0.0022, HORN.thick + 0.0012, 10),
    coxaPlate: rounded(d.coxa + 0.012, 0.021, PLATE, 0.0012),
    femurPlate: rounded(d.femur + 0.014, PLATE, 0.019, 0.0012),
    femurWeb: rounded(0.007, 0.03, 0.012, 0.0015),
    tibia: tibiaBlade(tibiaLen),
    band: rounded(0.026, 0.0115, 0.0045, 0.001),
    foot: new THREE.SphereGeometry(FOOT_RADIUS, 22, 14),
    footRing: new THREE.TorusGeometry(FOOT_RADIUS * 0.92, 0.0022, 8, 28),
    contactRing: new THREE.RingGeometry(0.0145, 0.0195, 40),
    comBar: new THREE.PlaneGeometry(0.034, 0.0022),
    comRing: new THREE.RingGeometry(0.0055, 0.0072, 28),
    frontX,
  }
}

export function partList(p: PartSet): THREE.BufferGeometry[] {
  return Object.values(p).filter((v): v is THREE.BufferGeometry => v instanceof THREE.BufferGeometry)
}
