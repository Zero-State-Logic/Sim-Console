import { describe, expect, it } from 'vitest'
import { AGENT_IGNORED, AGENT_MOVING, AGENT_STATIC, DEFAULT_ORCA, orcaU, orcaVelocities, separationGuard } from './avoidance'

/** Kinematic agents flying straight at their goals with ORCA in the loop. */
function simulate(starts: number[][], goals: number[][], seconds: number, speed = 2, mask?: number[]) {
  const n = starts.length
  const pos = new Float64Array(starts.flat())
  const vel = new Float64Array(3 * n)
  const pref = new Float64Array(3 * n)
  const out = new Float64Array(3 * n)
  const m = mask ?? new Array(n).fill(AGENT_MOVING)
  const dt = 0.02
  let minD = Infinity
  for (let t = 0; t < seconds; t += dt) {
    for (let i = 0; i < n; i++) {
      const dx = goals[i][0] - pos[3 * i], dy = goals[i][1] - pos[3 * i + 1], dz = goals[i][2] - pos[3 * i + 2]
      const d = Math.hypot(dx, dy, dz)
      const s = m[i] === AGENT_MOVING ? Math.min(speed, d) / (d || 1) : 0
      pref[3 * i] = dx * s
      pref[3 * i + 1] = dy * s
      pref[3 * i + 2] = dz * s
    }
    orcaVelocities(out, pos, vel, pref, m, n)
    for (let i = 0; i < 3 * n; i++) {
      vel[i] = m[Math.floor(i / 3)] === AGENT_MOVING ? out[i] : 0
      pos[i] += vel[i] * dt
    }
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        minD = Math.min(minD, Math.hypot(pos[3 * i] - pos[3 * j], pos[3 * i + 1] - pos[3 * j + 1], pos[3 * i + 2] - pos[3 * j + 2]))
  }
  return { pos, minD }
}

describe('ORCA-lite avoidance', () => {
  it('keeps a head-on pair separated and still gets both to their goals', () => {
    // Arrange: exactly symmetric head-on swap (the degenerate case)
    const { pos, minD } = simulate([[-5, 0, 3], [5, 0, 3]], [[5, 0, 3], [-5, 0, 3]], 15)
    // Assert
    const combined = 2 * DEFAULT_ORCA.radius
    expect(minD).toBeGreaterThan(combined * 0.95)
    expect(Math.hypot(pos[0] - 5, pos[1], pos[2] - 3)).toBeLessThan(0.1)
    expect(Math.hypot(pos[3] + 5, pos[4], pos[5] - 3)).toBeLessThan(0.1)
  })

  it('resolves a four-way crossing through the same point', () => {
    const starts = [[-6, 0, 3], [6, 0, 3], [0, -6, 3], [0, 6, 3]]
    const goals = [[6, 0, 3], [-6, 0, 3], [0, 6, 3], [0, -6, 3]]
    const { minD } = simulate(starts, goals, 20)
    expect(minD).toBeGreaterThan(2 * DEFAULT_ORCA.radius * 0.9)
  })

  it('makes a mover go fully around a static obstacle', () => {
    const { pos, minD } = simulate([[-5, 0.01, 3], [0, 0, 3]], [[5, 0, 3], [0, 0, 3]], 12, 2, [AGENT_MOVING, AGENT_STATIC])
    expect(minD).toBeGreaterThan(2 * DEFAULT_ORCA.radius * 0.9)
    expect(pos[0]).toBeGreaterThan(4.5)
  })

  it('gives a non-binding constraint (u against the normal) for a pair that is already safe', () => {
    const u = new Float64Array(3)
    const n = new Float64Array(3)
    orcaU(u, n, 0, 4, 0, 0, 0, 0, 0.6, 2, 0.1)
    expect(u[0] * n[0] + u[1] * n[1] + u[2] * n[2]).toBeLessThan(0)
  })

  it('leaves preferred velocities alone when nobody is on a collision course', () => {
    const pos = new Float64Array([0, 0, 3, 0, 4, 3])
    const vel = new Float64Array([1, 0, 0, 1, 0, 0])
    const out = new Float64Array(6)
    orcaVelocities(out, pos, vel, vel, [AGENT_MOVING, AGENT_MOVING], 2)
    expect(Array.from(out)).toEqual([1, 0, 0, 1, 0, 0])
  })

  it('ignores masked-out agents', () => {
    const pos = new Float64Array([0, 0, 3, 1, 0, 3])
    const vel = new Float64Array([1, 0, 0, 0, 0, 0])
    const out = new Float64Array(6)
    orcaVelocities(out, pos, vel, vel, [AGENT_MOVING, AGENT_IGNORED], 2)
    expect(out[0]).toBe(1)
  })

  it('computes the keep-right tie-break for an exact head-on approach', () => {
    const u = new Float64Array(3)
    const n = new Float64Array(3)
    orcaU(u, n, 10, 0, 0, 8, 0, 0, 0.6, 2, 0.1)
    expect(u[0]).toBeCloseTo(0, 9)
    expect(u[1]).toBeLessThan(0)
    expect(u[2]).toBe(0)
  })

  it('resolves an overlap within one time step', () => {
    const u = new Float64Array(3)
    const n = new Float64Array(3)
    orcaU(u, n, 0.3, 0, 0, 0, 0, 0, 0.6, 2, 0.1)
    // must push the pair apart (relative velocity away from the neighbour)
    expect(u[0]).toBeLessThan(0)
    expect(n[0]).toBeCloseTo(-1, 12)
  })
})

describe('minimum-separation guard', () => {
  it('pushes a too-close pair apart and reports the minimum distance', () => {
    const pos = new Float64Array([0, 0, 3, 0.4, 0, 3, 10, 0, 3])
    const v = new Float64Array(9)
    const d = separationGuard(v, pos, [AGENT_MOVING, AGENT_MOVING, AGENT_MOVING], 3, 0.8, 1.5)
    expect(d).toBeCloseTo(0.4, 12)
    expect(v[0]).toBeLessThan(0)
    expect(v[3]).toBeGreaterThan(0)
    expect(v[6]).toBe(0)
  })

  it('does not push static agents', () => {
    const pos = new Float64Array([0, 0, 3, 0.4, 0, 3])
    const v = new Float64Array(6)
    separationGuard(v, pos, [AGENT_MOVING, AGENT_STATIC], 2, 0.8, 1.5)
    expect(v[3]).toBe(0)
    expect(v[0]).toBeLessThan(0)
  })
})
