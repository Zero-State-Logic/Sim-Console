import { describe, expect, it } from 'vitest'
import type { SandboxCommand } from '../../core/types'
import { MAX_COMMANDS_PER_FRAME, SandboxOverrides, WALKER_SANDBOX_API, applyWalkerCommands, walkerSensors, type SandboxTarget } from './sandboxApi'
import { WalkerSim } from './sim'

const DEG = Math.PI / 180

function recorder(): { t: SandboxTarget; calls: string[] } {
  const calls: string[] = []
  const t: SandboxTarget = {
    setJoint: (j, rad) => calls.push(`setJoint ${j} ${rad.toFixed(4)}`),
    setLeg: (i, x, y, z) => calls.push(`setLeg ${i} ${x} ${y} ${z}`),
    walk: (vx, vy, wz) => calls.push(`walk ${vx} ${vy} ${wz.toFixed(4)}`),
    stop: () => calls.push('stop'),
    setGait: (i) => calls.push(`setGait ${i}`),
    setBodyHeight: (h) => calls.push(`setBodyHeight ${h}`),
    setBodyPose: (r, p, y) => calls.push(`setBodyPose ${r.toFixed(4)} ${p.toFixed(4)} ${y.toFixed(4)}`),
  }
  return { t, calls }
}

describe('applyWalkerCommands', () => {
  it('converts degrees to radians and passes meters through', () => {
    const { t, calls } = recorder()
    const n = applyWalkerCommands(
      [
        { fn: 'setJoint', args: [4, 90] },
        { fn: 'setLeg', args: [1, 0.2, -0.1, -0.08] },
        { fn: 'walk', args: [0.1, 0, 45] },
        { fn: 'stop', args: [] },
        { fn: 'setGait', args: [2] },
        { fn: 'setBodyHeight', args: [0.09] },
        { fn: 'setBodyPose', args: [10, -5, 0] },
      ],
      6,
      t,
    )
    expect(n).toBe(7)
    expect(calls).toEqual([
      `setJoint 4 ${(90 * DEG).toFixed(4)}`,
      'setLeg 1 0.2 -0.1 -0.08',
      `walk 0.1 0 ${(45 * DEG).toFixed(4)}`,
      'stop',
      'setGait 2',
      'setBodyHeight 0.09',
      `setBodyPose ${(10 * DEG).toFixed(4)} ${(-5 * DEG).toFixed(4)} ${(0).toFixed(4)}`,
    ])
  })

  it('rejects unknown functions, missing or non-finite arguments and out-of-range indices', () => {
    const { t, calls } = recorder()
    const bad = [
      { fn: 'rm', args: [] },
      { fn: 'setJoint', args: [1] },
      { fn: 'setJoint', args: [18, 0] },
      { fn: 'setJoint', args: [-1, 0] },
      { fn: 'setJoint', args: [0.5, 0] },
      { fn: 'setLeg', args: [6, 0, 0, 0] },
      { fn: 'setLeg', args: [0, 2, 0, 0] },
      { fn: 'walk', args: [Infinity, 0, 0] },
      { fn: 'setGait', args: [-1] },
      { fn: 'setBodyHeight', args: ['0.1'] },
      null,
      { args: [1] },
    ] as unknown as SandboxCommand[]
    expect(applyWalkerCommands(bad, 6, t)).toBe(0)
    expect(calls).toEqual([])
  })

  it('caps the commands applied per frame', () => {
    const { t, calls } = recorder()
    const many = Array.from({ length: MAX_COMMANDS_PER_FRAME + 10 }, () => ({ fn: 'stop', args: [] }))
    expect(applyWalkerCommands(many, 6, t)).toBe(MAX_COMMANDS_PER_FRAME)
    expect(calls).toHaveLength(MAX_COMMANDS_PER_FRAME)
  })

  it('declares a query sensor for every query and the right arity for every command', () => {
    for (const f of WALKER_SANDBOX_API) {
      if (f.kind === 'query') expect(f.sensor).toBeTruthy()
      expect(f.doc.length).toBeGreaterThan(10)
    }
    expect(WALKER_SANDBOX_API.find((f) => f.name === 'setLeg')?.params).toEqual(['leg', 'x', 'y', 'z'])
  })
})

describe('walkerSensors', () => {
  it('reports joints in degrees, loads, contacts, IMU and counts', () => {
    const sim = new WalkerSim(4)
    const s = walkerSensors(sim, new Float64Array([0.1, -0.2, 0.3]))
    expect(s.legs).toBe(4)
    expect(s.joints).toBe(12)
    expect((s.joint as number[])[1]).toBeCloseTo((sim.state.q[1] * 180) / Math.PI, 2)
    expect((s.load as number[]).reduce((a, b) => a + b, 0)).toBeCloseTo(sim.weight, 2)
    expect(s.contact).toEqual([1, 1, 1, 1])
    expect((s.imu as number[])[1]).toBeCloseTo(-0.2 * (180 / Math.PI), 9)
  })
})

describe('SandboxOverrides', () => {
  it('holds a walk twist and pose overrides until cleared', () => {
    const o = new SandboxOverrides()
    expect(o.walking).toBe(false)
    o.walk(0.1, 0, 0.2)
    o.height = 0.1
    expect(o.walking).toBe(true)
    o.clear()
    expect(o.walking).toBe(false)
    expect(Number.isNaN(o.height)).toBe(true)
    expect(o.vx).toBe(0)
  })
})
