import { describe, expect, it } from 'vitest'
import { mecanumInverse, ROMI_GEOMETRY } from '../robots/sweeper/mecanum'
import { forwardMatrix, readSweeperGeometry, SWEEPER_DEFAULTS, wheelCorner, wheelSpeeds, wheelTable } from './mecanumGen'
import { sweeperSpec } from './testing/fixtures'

const TWISTS: [number, number, number][] = [
  [0.3, 0, 0],
  [0, 0.2, 0],
  [0, 0, 1.2],
  [0.15, -0.1, 0.7],
  [-0.2, 0.05, -0.4],
]

describe('firmware mecanum mixing', () => {
  const spec = sweeperSpec()
  const { geom } = readSweeperGeometry(spec)
  const { rows } = wheelTable(spec, geom)

  it('matches the sweeper module inverse kinematics wheel for wheel', () => {
    const out = new Float64Array(4)
    for (const [vx, vy, wz] of TWISTS) {
      mecanumInverse(vx, vy, wz, out, ROMI_GEOMETRY)
      const ours = wheelSpeeds(rows, geom.wheelRadius, vx, vy, wz)
      for (let i = 0; i < 4; i++) expect(ours[i]).toBeCloseTo(out[i], 9)
    }
  })

  it('recovers the twist with the least-squares forward matrix (FK · IK = identity)', () => {
    const fk = forwardMatrix(rows, geom.wheelRadius)
    for (const twist of TWISTS) {
      const w = wheelSpeeds(rows, geom.wheelRadius, ...twist)
      for (let k = 0; k < 3; k++) expect(fk[k].reduce((s, m, i) => s + m * w[i], 0)).toBeCloseTo(twist[k], 9)
    }
  })

  it('reads wheel corners from the joint names in any common spelling', () => {
    expect(wheelCorner('WHEEL FL')).toBe('FL')
    expect(wheelCorner('rear right')).toBe('RR')
    expect(wheelCorner('BL')).toBe('RL')
    expect(wheelCorner('wheel_lf')).toBe('FL')
    expect(wheelCorner('motor 3')).toBeNull()
  })

  it('follows the joint order when the names are shuffled', () => {
    const shuffled = { ...spec, jointNames: ['WHEEL RR', 'WHEEL FL', 'WHEEL RL', 'WHEEL FR'] }
    const t = wheelTable(shuffled, geom)
    expect(t.guessed).toBe(false)
    expect(t.rows.map((r) => [Math.sign(r.x), Math.sign(r.y)])).toEqual([
      [-1, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
    ])
  })

  it('falls back to FL, FR, RL, RR and the romi defaults when the spec is bare', () => {
    const bare = { ...spec, jointNames: ['a', 'b', 'c', 'd'], geometry: undefined }
    const g = readSweeperGeometry(bare)
    expect(g.missing).toEqual(['wheelRadius', 'halfLength', 'halfWidth', 'maxWheelSpeed'])
    expect(g.geom).toEqual(SWEEPER_DEFAULTS)
    expect(wheelTable(bare, g.geom).guessed).toBe(true)
  })
})
