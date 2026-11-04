import * as THREE from 'three'
import { WHEEL_RADIUS } from '../constants'
import type { Palette } from './materials'
import { rollerLayout } from './rollerLayout'

/*
 * One mecanum wheel: aluminium hub, two white side plates, an orange hub cap on the
 * outer face and nine barrel rollers at 45 degrees (one InstancedMesh per wheel; the
 * instance matrices are fixed, the whole wheel spins). Built in three.js axes with the
 * axle along local z (three z = -body y), so rolling forward is rotation.z = -angle.
 */

export const ROLLERS = 9
export const WHEEL_WIDTH = 0.034
const ROLLER_MAX_R = 0.0105
const ROLLER_LEN = 0.036
const ROLLER_CENTER_R = WHEEL_RADIUS - ROLLER_MAX_R
const PLATE_R = 0.024

export interface WheelGeometries {
  roller: THREE.BufferGeometry
  hub: THREE.BufferGeometry
  plate: THREE.BufferGeometry
  cap: THREE.BufferGeometry
}

/** Barrel roller along +y: fattest in the middle, so the wheel stays round where it rolls. */
function rollerGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, -ROLLER_LEN / 2)]
  const steps = 8
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 - 1
    pts.push(new THREE.Vector2(ROLLER_MAX_R * (1 - 0.42 * t * t), (t * ROLLER_LEN) / 2))
  }
  pts.push(new THREE.Vector2(0, ROLLER_LEN / 2))
  return new THREE.LatheGeometry(pts, 14)
}

/** Cylinder with its axis along three z (the axle direction). */
function axleCylinder(r: number, len: number, seg: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2)
}

export function makeWheelGeometries(): WheelGeometries {
  return {
    roller: rollerGeometry(),
    hub: axleCylinder(0.012, WHEEL_WIDTH * 0.92, 20),
    plate: axleCylinder(PLATE_R, 0.0035, 28),
    cap: axleCylinder(0.0105, 0.004, 20),
  }
}

export function disposeWheelGeometries(g: WheelGeometries): void {
  g.roller.dispose()
  g.hub.dispose()
  g.plate.dispose()
  g.cap.dispose()
}

/**
 * Build wheel `index` (FL, FR, RL, RR). `sign` is the contact-roller lateral sign and
 * `outer` is +1 when the wheel's outer face points along three +z (right-hand wheels).
 */
export function buildWheel(geo: WheelGeometries, pal: Palette, sign: number, outer: number): THREE.Group {
  const spin = new THREE.Group()
  spin.name = 'wheel'
  const hub = new THREE.Mesh(geo.hub, pal.aluminium)
  spin.add(hub)
  for (const z of [-1, 1]) {
    const plate = new THREE.Mesh(geo.plate, pal.plastic)
    plate.position.z = (z * WHEEL_WIDTH) / 2.6
    spin.add(plate)
  }
  const cap = new THREE.Mesh(geo.cap, pal.orange)
  cap.position.z = outer * (WHEEL_WIDTH / 2.6 + 0.003)
  spin.add(cap)

  const rollers = new THREE.InstancedMesh(geo.roller, pal.roller, ROLLERS)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const axis = new THREE.Vector3()
  const pos = new THREE.Vector3()
  const one = new THREE.Vector3(1, 1, 1)
  rollerLayout(ROLLERS, ROLLER_CENTER_R, sign).forEach((r, i) => {
    // body (x, y, z) -> three (x, z, -y)
    pos.set(r.px, r.pz, -r.py)
    axis.set(r.ax, r.az, -r.ay).normalize()
    q.setFromUnitVectors(up, axis)
    rollers.setMatrixAt(i, m.compose(pos, q, one))
  })
  rollers.instanceMatrix.needsUpdate = true
  spin.add(rollers)
  spin.traverse((o) => {
    o.castShadow = true
    o.receiveShadow = true
  })
  return spin
}
