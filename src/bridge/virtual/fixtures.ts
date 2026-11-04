import { legIk, neutralFeet, readWalkerGeometry, type WalkerGeom } from '../../codegen/walkerGeom'
import type { HardwareSpec } from '../../core/types'

/*
 * Test fixtures: a walker HardwareSpec with real geometry (radial mounts, mirrored
 * left/right like the sim), whose home pose is the IK of the neutral stance. Only the
 * bridge tests import this file.
 */

const RAD = Math.PI / 180

/** Mount yaws (deg) per leg count, REP-103: 0 = forward, + = left. */
const YAWS: Record<number, number[]> = {
  4: [45, 135, -135, -45],
  6: [45, 90, 135, -135, -90, -45],
  8: [30, 70, 110, 150, -150, -110, -70, -30],
}

export function walkerGeometrySpec(legs: 4 | 6 | 8 = 6): HardwareSpec {
  const yaws = YAWS[legs]
  const mountR = 0.1
  const coxa = 0.04
  const femur = 0.08
  const tibia = 0.12
  const standHeight = 0.09
  const footReach = 0.13
  const joints = legs * 3
  const spec: HardwareSpec = {
    robot: 'walker',
    joints,
    jointNames: Array.from({ length: joints }, (_, j) => `L${Math.floor(j / 3) + 1} ${['coxa', 'femur', 'tibia'][j % 3]}`),
    jointLimits: Array.from({ length: joints }, (_, j) => ([[-70, 70], [-85, 85], [-80, 80]] as [number, number][])[j % 3]),
    homePose: new Array<number>(joints).fill(0),
    legs,
    defaultLevel: { wired: 'joint', wireless: 'high' },
    geometry: {
      coxa,
      femur,
      tibia,
      standHeight,
      footReach,
      mountX: yaws.map((d) => mountR * Math.cos(d * RAD)),
      mountY: yaws.map((d) => mountR * Math.sin(d * RAD)),
      mountYawDeg: yaws,
    },
  }
  const g = geomOf(spec)
  const nf = neutralFeet(g)
  for (let i = 0; i < legs; i++) {
    const q = legIk(g, i, nf.x[i], nf.y[i], -standHeight).q
    for (let k = 0; k < 3; k++) spec.homePose[i * 3 + k] = q[k]
  }
  return spec
}

export function geomOf(spec: HardwareSpec): WalkerGeom {
  const r = readWalkerGeometry(spec)
  if (!r.geom) throw new Error(r.errors.join('; '))
  return r.geom
}

/** Joint angles (deg, leg-major) that put each foot at the given body-frame points. */
export function anglesForFeet(g: WalkerGeom, feet: readonly (readonly [number, number, number])[]): Float64Array {
  const q = new Float64Array(g.legs * 3)
  for (let i = 0; i < g.legs; i++) {
    const r = legIk(g, i, feet[i][0], feet[i][1], feet[i][2]).q
    q.set(r, i * 3)
  }
  return q
}

/** Body-frame feet for a body tilted by roll / pitch (rad) over flat ground at depth h, feet under the neutral points. */
export function tiltedFeet(g: WalkerGeom, roll: number, pitch: number, h: number): [number, number, number][] {
  const nf = neutralFeet(g)
  const cr = Math.cos(roll)
  const sr = Math.sin(roll)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const out: [number, number, number][] = []
  for (let i = 0; i < g.legs; i++) {
    const x = nf.x[i]
    const y = nf.y[i]
    const z = -h
    // p_body = Rx(φ)ᵀ·Ry(θ)ᵀ·p_level
    const x1 = x * cp - z * sp
    const z1 = x * sp + z * cp
    out.push([x1, y * cr + z1 * sr, -y * sr + z1 * cr])
  }
  return out
}
