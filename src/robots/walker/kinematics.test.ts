import { describe, expect, it } from 'vitest'
import { buildLayout, DEFAULT_DIMS, LEG_COUNTS, nominalHeightFor, type WalkerDims } from './geometry'
import {
  IK_JOINT_LIMIT,
  IK_OK,
  IK_OUT_OF_REACH,
  JOINT_MAX,
  JOINT_MIN,
  addHoldingTorque,
  bodyToLeg,
  legFK,
  legIK,
  legJacobian,
  legToBody,
} from './kinematics'

const D: WalkerDims = DEFAULT_DIMS
const DEG = Math.PI / 180

/** Small deterministic PRNG so failures are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

describe('legFK / legIK', () => {
  it('places the foot at coxa+femur out and tibia down at joint zero', () => {
    // Arrange
    const q = new Float64Array([0, 0, 0])
    const p = new Float64Array(3)
    // Act
    legFK(D, q, 0, p, 0)
    // Assert
    expect(p[0]).toBeCloseTo(D.coxa + D.femur, 12)
    expect(p[1]).toBeCloseTo(0, 12)
    expect(p[2]).toBeCloseTo(-D.tibia, 12)
  })

  it('follows the documented sign convention: coxa + is CCW, femur + is up, tibia + is foot out', () => {
    const p0 = new Float64Array(3)
    const p = new Float64Array(3)
    legFK(D, new Float64Array([0, 0, 0]), 0, p0, 0)
    legFK(D, new Float64Array([0.2, 0, 0]), 0, p, 0)
    expect(p[1]).toBeGreaterThan(p0[1])
    legFK(D, new Float64Array([0, 0.2, 0]), 0, p, 0)
    expect(p[2]).toBeGreaterThan(p0[2])
    legFK(D, new Float64Array([0, 0, 0.2]), 0, p, 0)
    expect(p[0]).toBeGreaterThan(p0[0])
  })

  it('round-trips FK(IK(p)) = p for random reachable joint configurations', () => {
    // Arrange: sample joint space inside the limits, map to a foot target with FK
    const rand = rng(42)
    const q = new Float64Array(3)
    const target = new Float64Array(3)
    const sol = new Float64Array(3)
    const back = new Float64Array(3)
    let tested = 0
    for (let k = 0; k < 2000; k++) {
      q[0] = (rand() * 2 - 1) * 60 * DEG
      q[1] = (rand() * 2 - 1) * 70 * DEG
      q[2] = (rand() * 2 - 1) * 70 * DEG
      legFK(D, q, 0, target, 0)
      // Act
      const status = legIK(D, target[0], target[1], target[2], sol, 0)
      if (status !== IK_OK) continue
      legFK(D, sol, 0, back, 0)
      tested++
      // Assert
      for (let c = 0; c < 3; c++) expect(back[c]).toBeCloseTo(target[c], 9)
    }
    expect(tested).toBeGreaterThan(1000)
  })

  it('round-trips random reachable body-frame foot targets on every leg of 4, 6 and 8-leg layouts', () => {
    const rand = rng(99)
    const q = new Float64Array(3)
    const leg = new Float64Array(3)
    const foot = new Float64Array(3)
    const body = new Float64Array(3)
    for (const n of LEG_COUNTS) {
      const L = buildLayout(n, D)
      let tested = 0
      for (let k = 0; k < 600; k++) {
        const i = k % n
        // Arrange: a target around the neutral foot, ±4 cm sideways, 3..15 cm below the mounts
        const tx = L.neutralX[i] + (rand() * 2 - 1) * 0.04
        const ty = L.neutralY[i] + (rand() * 2 - 1) * 0.04
        const tz = -0.03 - rand() * 0.12
        bodyToLeg(L.mountX[i], L.mountY[i], L.mountYaw[i], tx, ty, tz, leg, 0)
        // Act
        if (legIK(D, leg[0], leg[1], leg[2], q, 0) !== IK_OK) continue
        legFK(D, q, 0, foot, 0)
        legToBody(L.mountX[i], L.mountY[i], L.mountYaw[i], foot[0], foot[1], foot[2], body, 0)
        tested++
        // Assert
        expect(body[0]).toBeCloseTo(tx, 9)
        expect(body[1]).toBeCloseTo(ty, 9)
        expect(body[2]).toBeCloseTo(tz, 9)
      }
      expect(tested, `${n} legs`).toBeGreaterThan(400)
    }
  })

  it('picks the knee-up solution (knee above the hip-foot line)', () => {
    const sol = new Float64Array(3)
    legIK(D, 0.12, 0, -0.08, sol, 0)
    const kneeZ = D.femur * Math.sin(sol[1])
    // the straight line from the femur joint to the foot at the knee's radius
    const kneeR = D.femur * Math.cos(sol[1])
    const lineZ = (-0.08 * kneeR) / (0.12 - D.coxa)
    expect(kneeZ).toBeGreaterThan(lineZ)
  })

  it('round-trips the neutral stance of every leg for 4, 6 and 8 legs', () => {
    for (const n of LEG_COUNTS) {
      const L = buildLayout(n, D)
      const h = nominalHeightFor(D)
      const leg = new Float64Array(3)
      const q = new Float64Array(3)
      const foot = new Float64Array(3)
      const body = new Float64Array(3)
      for (let i = 0; i < n; i++) {
        bodyToLeg(L.mountX[i], L.mountY[i], L.mountYaw[i], L.neutralX[i], L.neutralY[i], -h, leg, 0)
        expect(legIK(D, leg[0], leg[1], leg[2], q, 0)).toBe(IK_OK)
        legFK(D, q, 0, foot, 0)
        legToBody(L.mountX[i], L.mountY[i], L.mountYaw[i], foot[0], foot[1], foot[2], body, 0)
        expect(body[0]).toBeCloseTo(L.neutralX[i], 9)
        expect(body[1]).toBeCloseTo(L.neutralY[i], 9)
        expect(body[2]).toBeCloseTo(-h, 9)
      }
    }
  })

  it('stands in the reference posture: femur raised, tibia near vertical, splayed out', () => {
    const L = buildLayout(6, D)
    const leg = new Float64Array(3)
    const q = new Float64Array(3)
    bodyToLeg(L.mountX[0], L.mountY[0], L.mountYaw[0], L.neutralX[0], L.neutralY[0], -nominalHeightFor(D), leg, 0)
    legIK(D, leg[0], leg[1], leg[2], q, 0)
    expect(q[0]).toBeCloseTo(0, 9)
    expect(q[1] / DEG).toBeCloseTo(35, 6)
    // tibia absolute angle α + β − 90° = −80°
    expect((q[1] + q[2]) / DEG - 90).toBeCloseTo(-80, 6)
  })
})

describe('reachability clamp', () => {
  it('reports and clamps a target beyond the leg reach onto the workspace boundary', () => {
    const sol = new Float64Array(3)
    const back = new Float64Array(3)
    const status = legIK(D, 0.5, 0, 0, sol, 0)
    expect(status & IK_OUT_OF_REACH).toBeTruthy()
    legFK(D, sol, 0, back, 0)
    // stretched (almost) straight out; the tibia limit stops it short of a dead-straight knee
    const reach = Math.hypot(back[0] - D.coxa, back[2])
    expect(reach).toBeLessThanOrEqual(D.femur + D.tibia)
    expect(reach).toBeGreaterThan(0.99 * (D.femur + D.tibia))
    expect(back[1]).toBeCloseTo(0, 9)
  })

  it('reports a target too close to the femur joint', () => {
    const sol = new Float64Array(3)
    expect(legIK(D, D.coxa + 0.001, 0, 0, sol, 0) & IK_OUT_OF_REACH).toBeTruthy()
    expect(legIK(D, D.coxa, 0, 0, sol, 0) & IK_OUT_OF_REACH).toBeTruthy()
  })

  it('clamps joints to their limits and reports it', () => {
    const sol = new Float64Array(3)
    // straight behind the mount: coxa would need 180°
    const status = legIK(D, -0.12, 0.01, -0.08, sol, 0)
    expect(status & IK_JOINT_LIMIT).toBeTruthy()
    for (let j = 0; j < 3; j++) {
      expect(sol[j]).toBeGreaterThanOrEqual(JOINT_MIN[j])
      expect(sol[j]).toBeLessThanOrEqual(JOINT_MAX[j])
    }
  })
})

describe('legJacobian', () => {
  it('matches a central finite difference of FK', () => {
    const q = new Float64Array([0.3, 0.5, -0.4])
    const J = new Float64Array(9)
    legJacobian(D, q, 0, J)
    const h = 1e-6
    const a = new Float64Array(3)
    const b = new Float64Array(3)
    for (let c = 0; c < 3; c++) {
      const qp = q.slice()
      const qm = q.slice()
      qp[c] += h
      qm[c] -= h
      legFK(D, qp, 0, a, 0)
      legFK(D, qm, 0, b, 0)
      for (let r = 0; r < 3; r++) expect(J[r * 3 + c]).toBeCloseTo((a[r] - b[r]) / (2 * h), 6)
    }
  })

  it('gives the lever-arm torque for a vertical ground force: τ_femur = −u·F', () => {
    // Arrange: femur horizontal, tibia vertical → foot sits at u = femur length from the femur axis
    const q = new Float64Array([0, 0, 0])
    const J = new Float64Array(9)
    legJacobian(D, q, 0, J)
    const tau = new Float64Array(3)
    // Act: 10 N pushing the foot up
    addHoldingTorque(J, 0, 0, 10, tau, 0)
    // Assert: the femur servo pushes down with 10 N × femur; the vertical tibia and coxa carry none
    expect(tau[1]).toBeCloseTo(-10 * D.femur, 12)
    expect(tau[2]).toBeCloseTo(0, 12)
    expect(tau[0]).toBeCloseTo(0, 12)
  })

  it('loads the tibia servo by the horizontal tibia lever', () => {
    // tibia tilted out by 30°: foot is L3·sin30 outward of the knee
    const q = new Float64Array([0, 0, 30 * DEG])
    const J = new Float64Array(9)
    legJacobian(D, q, 0, J)
    const tau = new Float64Array(3)
    addHoldingTorque(J, 0, 0, 10, tau, 0)
    expect(tau[2]).toBeCloseTo(-10 * D.tibia * Math.sin(30 * DEG), 12)
  })
})

describe('frames', () => {
  it('bodyToLeg and legToBody are inverses', () => {
    const a = new Float64Array(3)
    const b = new Float64Array(3)
    bodyToLeg(0.05, -0.08, -1.1, 0.2, -0.15, -0.07, a, 0)
    legToBody(0.05, -0.08, -1.1, a[0], a[1], a[2], b, 0)
    expect(b[0]).toBeCloseTo(0.2, 12)
    expect(b[1]).toBeCloseTo(-0.15, 12)
    expect(b[2]).toBeCloseTo(-0.07, 12)
  })
})
