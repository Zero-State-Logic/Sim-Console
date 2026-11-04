import { describe, expect, it } from 'vitest'
import { quatToRotation, rotationToQuat, rotationZYX, rpyFromRotation, wrapAngle } from './pose'

const DEG = Math.PI / 180

describe('rotation ↔ quaternion', () => {
  it('round-trips every branch of Shepperd extraction, including 180° turns', () => {
    // yaw / pitch / roll chosen so each diagonal entry in turn dominates (trace ≤ 0)
    const cases: [number, number, number][] = [[10, 5, -3], [180, 0, 0], [0, 179, 0], [0, 0, 180], [170, 20, 175], [-90, 60, 120]]
    const R = new Float64Array(9)
    const back = new Float64Array(9)
    const q = new Float64Array(4)
    for (const [y, p, r] of cases) {
      // Arrange
      rotationZYX(y * DEG, p * DEG, r * DEG, R)
      // Act
      rotationToQuat(R, q)
      quatToRotation(q[0], q[1], q[2], q[3], back)
      // Assert: unit quaternion that rebuilds the same matrix
      expect(Math.hypot(q[0], q[1], q[2], q[3]), `${y},${p},${r}`).toBeCloseTo(1, 12)
      for (let k = 0; k < 9; k++) expect(back[k], `${y},${p},${r}`).toBeCloseTo(R[k], 12)
    }
  })

  it('recovers roll, pitch and yaw from R = Rz·Ry·Rx', () => {
    const R = new Float64Array(9)
    const rpy = new Float64Array(3)
    rotationZYX(0.7, -0.2, 0.35, R)
    rpyFromRotation(R, rpy)
    expect(rpy[0]).toBeCloseTo(0.35, 12)
    expect(rpy[1]).toBeCloseTo(-0.2, 12)
    expect(rpy[2]).toBeCloseTo(0.7, 12)
  })

  it('wraps angles into (−π, π]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12)
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 12)
    expect(wrapAngle(-3.5 * Math.PI)).toBeCloseTo(0.5 * Math.PI, 12)
  })
})
