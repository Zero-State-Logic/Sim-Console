import { describe, expect, it } from 'vitest'
import { eulerToQuat, quatCosTilt, quatFromColumns, quatMul, quatNormalizeAt, quatToEuler, quatYaw } from './quat'
import { simQuatToThree, simToThree, threeToSim, wrapPi } from './frames'

describe('quaternion helpers', () => {
  it('round-trips ZYX Euler angles through a quaternion', () => {
    // Arrange
    const cases: [number, number, number][] = [
      [0, 0, 0],
      [0.3, -0.2, 1.1],
      [-1.0, 0.7, -2.9],
      [0.05, 1.2, 3.0],
    ]
    const q = new Float64Array(4)
    const e = new Float64Array(3)
    for (const [r, p, y] of cases) {
      // Act
      eulerToQuat(q, 0, r, p, y)
      quatToEuler(e, q, 0)
      // Assert
      expect(e[0]).toBeCloseTo(r, 9)
      expect(e[1]).toBeCloseTo(p, 9)
      expect(e[2]).toBeCloseTo(y, 9)
      expect(quatYaw(q, 0)).toBeCloseTo(y, 9)
    }
  })

  it('rebuilds the same rotation from its matrix columns in every Shepperd branch', () => {
    const q = new Float64Array(4)
    const out = new Float64Array(4)
    const b1 = new Float64Array(3), b2 = new Float64Array(3), b3 = new Float64Array(3)
    const angles: [number, number, number][] = [[0.1, 0.2, 0.3], [3.0, 0.1, 0.2], [0.2, 0.1, 3.0], [1.5, 1.4, -1.5], [3.1, 0, 0], [0, 0, 3.1]]
    for (const [r, p, y] of angles) {
      eulerToQuat(q, 0, r, p, y)
      const [w, x, yy, z] = q
      // columns of R(q)
      b1.set([1 - 2 * (yy * yy + z * z), 2 * (x * yy + w * z), 2 * (x * z - w * yy)])
      b2.set([2 * (x * yy - w * z), 1 - 2 * (x * x + z * z), 2 * (yy * z + w * x)])
      b3.set([2 * (x * z + w * yy), 2 * (yy * z - w * x), 1 - 2 * (x * x + yy * yy)])
      quatFromColumns(out, b1, b2, b3)
      const dot = Math.abs(out[0] * q[0] + out[1] * q[1] + out[2] * q[2] + out[3] * q[3])
      expect(dot).toBeCloseTo(1, 9)
    }
  })

  it('composes rotations: two 45° yaws make a 90° yaw', () => {
    const a = new Float64Array(4)
    const out = new Float64Array(4)
    eulerToQuat(a, 0, 0, 0, Math.PI / 4)
    quatMul(out, a, a)
    expect(quatYaw(out, 0)).toBeCloseTo(Math.PI / 2, 12)
    expect(quatCosTilt(out, 0)).toBeCloseTo(1, 12)
  })

  it('normalizes a scaled quaternion and recovers identity from a zero one', () => {
    const q = new Float64Array([2, 0, 0, 2])
    quatNormalizeAt(q, 0)
    expect(Math.hypot(...q)).toBeCloseTo(1, 12)
    const z = new Float64Array(4)
    quatNormalizeAt(z, 0)
    expect(Array.from(z)).toEqual([1, 0, 0, 0])
  })
})

describe('frame mapping', () => {
  it('maps sim REP-103 (z up) to three.js (y up) and back', () => {
    const t = simToThree({ x: 0, y: 0, z: 0 }, 1, 2, 3)
    expect(t).toEqual({ x: 1, y: 3, z: -2 })
    const s = threeToSim({ x: 0, y: 0, z: 0 }, t.x, t.y, t.z)
    expect(s).toEqual({ x: 1, y: 2, z: 3 })
  })

  it('keeps the quaternion rotation consistent with the position mapping', () => {
    // A 90° CCW yaw in the sim turns sim +x into sim +y, which is three.js -Z.
    const q = new Float64Array(4)
    eulerToQuat(q, 0, 0, 0, Math.PI / 2)
    const t = simQuatToThree({ w: 0, x: 0, y: 0, z: 0 }, q[0], q[1], q[2], q[3])
    // rotate three.js +X by t: v' = v + 2w(u×v) + 2u×(u×v)
    const ux = t.x, uy = t.y, uz = t.z, w = t.w
    const cx = 0, cy = uz, cz = -uy // u × (1,0,0)
    const ccx = uy * cz - uz * cy, ccy = uz * cx - ux * cz, ccz = ux * cy - uy * cx
    const v = [1 + 2 * w * cx + 2 * ccx, 2 * w * cy + 2 * ccy, 2 * w * cz + 2 * ccz]
    expect(v[0]).toBeCloseTo(0, 12)
    expect(v[1]).toBeCloseTo(0, 12)
    expect(v[2]).toBeCloseTo(-1, 12)
  })

  it('wraps angles into (-pi, pi]', () => {
    expect(wrapPi(3 * Math.PI)).toBeCloseTo(Math.PI, 12)
    expect(wrapPi(-3 * Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12)
    expect(wrapPi(0.5)).toBe(0.5)
  })
})
