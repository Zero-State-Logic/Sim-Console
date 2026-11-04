import { describe, expect, it } from 'vitest'
import { getRobotEntry } from './index'
import type { RobotKind, RobotModule } from '../core/types'

/*
 * Motion quality guard for every robot, driven headlessly through the RobotModule
 * contract exactly as the runtime drives it.
 *  - Smooth: the drawn position (followTarget) must advance evenly frame to frame. A
 *    fixed-step physics loop drawn without interpolation saws by a few mm per frame;
 *    the speed jump between consecutive frames would then be far above what the
 *    robot's acceleration allows.
 *  - Precise: the result at a given sim time must not depend on the frame rate.
 */
const FRAME = 1 / 60

interface Run {
  speeds: number[]
  endX: number
  endY: number
  endZ: number
}

function drive(m: RobotModule, kind: RobotKind): void {
  if (kind === 'walker') m.setControl('dir', 'f')
  if (kind === 'swarm') m.setControl('takeoff', true)
}

function run(kind: RobotKind, dts: number[]): Run {
  const m = getRobotEntry(kind).create()
  drive(m, kind)
  const speeds: number[] = []
  let t = 0
  let p0 = m.followTarget()!.clone()
  for (const dt of dts) {
    t += dt
    m.update(dt, { source: 'sim', t })
    const p = m.followTarget()!
    speeds.push(p.distanceTo(p0) / dt)
    p0 = p.clone()
  }
  m.dispose()
  return { speeds, endX: p0.x, endY: p0.y, endZ: p0.z }
}

/** Frame pattern 40 Hz / 90 Hz / 60 Hz repeating, trimmed to end at exactly `total` s. */
function irregular(total: number): number[] {
  const pattern = [1 / 40, 1 / 90, 1 / 60]
  const out: number[] = []
  let s = 0
  for (let i = 0; s + pattern[i % 3] <= total + 1e-12; i++) {
    out.push(pattern[i % 3])
    s += pattern[i % 3]
  }
  if (total - s > 1e-12) out.push(total - s)
  return out
}

function maxJump(v: number[]): number {
  let j = 0
  for (let i = 1; i < v.length; i++) j = Math.max(j, Math.abs(v[i] - v[i - 1]))
  return j
}

const CASES: { kind: RobotKind; warmFrames: number; frames: number; maxJumpMs: number }[] = [
  // walker body glides at constant commanded speed while the legs step
  { kind: 'walker', warmFrames: 180, frames: 300, maxJumpMs: 0.005 },
  // sweeper accelerates at <= 1.6 m/s² -> <= 0.027 m/s per 60 Hz frame
  { kind: 'sweeper', warmFrames: 180, frames: 300, maxJumpMs: 0.035 },
  // drones bank through the route corners at up to ~3.5 m/s² (≈ 20° tilt) -> ~0.06 m/s per
  // frame; without render extrapolation 1 kHz-vs-60 Hz aliasing alone gave 0.19 m/s
  { kind: 'swarm', warmFrames: 600, frames: 600, maxJumpMs: 0.08 },
]

describe('robot motion quality', () => {
  for (const c of CASES) {
    it(`${c.kind}: drawn motion advances smoothly at 60 Hz (no fixed-step aliasing)`, () => {
      const r = run(c.kind, new Array(c.warmFrames + c.frames).fill(FRAME))
      expect(maxJump(r.speeds.slice(c.warmFrames))).toBeLessThan(c.maxJumpMs)
    })

    it(`${c.kind}: the pose at a given sim time does not depend on the frame rate`, () => {
      const total = (c.warmFrames + c.frames) * FRAME
      const a = run(c.kind, new Array(c.warmFrames + c.frames).fill(FRAME))
      const b = run(c.kind, irregular(total))
      const d = Math.hypot(a.endX - b.endX, a.endY - b.endY, a.endZ - b.endZ)
      expect(d).toBeLessThan(0.002)
    })
  }

  it('swarm: the leader holds the cruise speed instead of overshooting after corners', () => {
    const m = getRobotEntry('swarm').create() as RobotModule & {
      sim: { leader: { s: Float64Array } | null; phase: string; settings: { cruiseSpeed: number } }
    }
    m.setControl('takeoff', true)
    let t = 0
    let peak = 0
    for (let i = 0; i < 60 * 30; i++) {
      t += FRAME
      m.update(FRAME, { source: 'sim', t })
      const l = m.sim.leader
      if (l && m.sim.phase === 'mission' && t > 6) peak = Math.max(peak, Math.hypot(l.s[3], l.s[4]))
    }
    const cruise = m.sim.settings.cruiseSpeed
    m.dispose()
    expect(peak).toBeGreaterThan(cruise * 0.9)
    expect(peak).toBeLessThan(cruise * 1.15)
  })
})
