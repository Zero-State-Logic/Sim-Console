import { describe, expect, it } from 'vitest'
import { BODY_RADIUS, airframesTouch, motorHubs } from './collision'
import { STATE_LEN } from './dynamics'
import { QUAD_250 } from './params'
import { eulerToQuat } from './quat'

const p = QUAD_250
const d = p.armLength / Math.SQRT2

function at(x: number, y: number, z: number, yaw = 0, roll = 0): Float64Array {
  const s = new Float64Array(STATE_LEN)
  s[0] = x
  s[1] = y
  s[2] = z
  eulerToQuat(s, 6, roll, 0, yaw)
  return s
}

const touch = (a: Float64Array, b: Float64Array): boolean => airframesTouch(a, b, p.armLength, p.propRadius)

describe('airframe contact', () => {
  it('places the motor hubs where the mixer has them (FL, FR, RR, RL) and rotates them with yaw', () => {
    // Arrange
    const hubs = new Float64Array(12)
    // Act
    motorHubs(hubs, at(1, 2, 3), d)
    // Assert
    expect(Array.from(hubs)).toEqual([1 + d, 2 + d, 3, 1 + d, 2 - d, 3, 1 - d, 2 - d, 3, 1 - d, 2 + d, 3].map((v) => expect.closeTo(v, 12)))
    motorHubs(hubs, at(0, 0, 0, Math.PI / 4), d)
    // a 45° yaw puts the front-left arm on +y
    expect(hubs[0]).toBeCloseTo(0, 12)
    expect(hubs[1]).toBeCloseTo(p.armLength, 12)
  })

  it('touches side by side at 2·(d + r) ≈ 0.30 m with the arms crossed and 2·(arm + r) ≈ 0.37 m with them aligned', () => {
    // Arrange: hand-derived contact distances for 5" props on a 250 frame
    const crossed = 2 * d + 2 * p.propRadius
    const aligned = 2 * p.armLength + 2 * p.propRadius
    expect(crossed).toBeCloseTo(0.297, 3)
    expect(aligned).toBeCloseTo(0.367, 3)
    // Act + Assert: yaw 0 (arms at 45° to the line between them)
    expect(touch(at(0, 0, 3), at(crossed - 0.01, 0, 3))).toBe(true)
    expect(touch(at(0, 0, 3), at(crossed + 0.01, 0, 3))).toBe(false)
    // yaw 45° (an arm of each points at the other): contact reaches much further
    const y45 = Math.PI / 4
    expect(touch(at(0, 0, 3, y45), at(aligned - 0.01, 0, 3, y45))).toBe(true)
    expect(touch(at(0, 0, 3, y45), at(aligned + 0.01, 0, 3, y45))).toBe(false)
  })

  it('does not count a drone hovering 0.2 m above another as a collision, but a 0.1 m stack is one', () => {
    expect(touch(at(0, 0, 3), at(0, 0, 3.2))).toBe(false)
    expect(touch(at(0, 0, 3), at(0, 0, 3.1))).toBe(true)
  })

  it('detects body-to-body and prop-to-body contact', () => {
    expect(touch(at(0, 0, 3), at(2 * BODY_RADIUS - 0.01, 0, 3, 0.3))).toBe(true)
    // B's centre right next to A's front-left motor hub
    expect(touch(at(0, 0, 3), at(d + BODY_RADIUS, d + BODY_RADIUS, 3.05, 0.2))).toBe(true)
  })

  it('uses the full attitude: a steeply banked drone above a neighbour dips its props into it', () => {
    // Arrange: B 0.15 m above A; level, the hubs are 0.15 m apart (> 2r = 0.127 m)
    const a = at(0, 0, 3)
    expect(touch(a, at(0, 0, 3.15))).toBe(false)
    // Act: B rolls 60°; one pair of its hubs drops by d·sin 60° ≈ 0.073 m and moves
    // inward to d·cos 60°, so its hub sits √((d/2)² + 0.077²) ≈ 0.087 m from A's
    const banked = at(0, 0, 3.15, 0, Math.PI / 3)
    // Assert
    expect(touch(a, banked)).toBe(true)
  })
})
