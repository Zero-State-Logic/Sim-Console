import { describe, expect, it } from 'vitest'
import { parseSnapshot, serializeArena, takeSnapshot } from './persist'
import { SweeperSim } from './sim'

describe('snapshots', () => {
  it('captures pose, wheels, coverage and bump as plain data', () => {
    const sim = new SweeperSim(6, [])
    sim.step(0.5)
    const s = takeSnapshot(sim)
    expect(structuredClone(s)).toEqual(s)
    expect(parseSnapshot(s)).toEqual(s)
  })

  it('rejects malformed snapshots and clamps the coverage percent', () => {
    expect(parseSnapshot(null)).toBeNull()
    expect(parseSnapshot({ x: 0, y: 0, th: 0, cov: 0, w: [0, 0, 0] })).toBeNull()
    expect(parseSnapshot({ x: 0, y: Number.NaN, th: 0, cov: 0, w: [0, 0, 0, 0] })).toBeNull()
    expect(parseSnapshot({ x: 0, y: 0, th: 0, cov: 400, w: [0, 0, 0, 0] })?.cov).toBe(100)
  })
})

describe('arena config', () => {
  it('serializes the size and every obstacle', () => {
    const sim = new SweeperSim()
    const c = serializeArena(sim.size, sim.obstacles)
    expect(c.v).toBe(1)
    expect(c.size).toBe(6)
    expect(c.obstacles).toHaveLength(sim.obstacles.length)
  })
})
