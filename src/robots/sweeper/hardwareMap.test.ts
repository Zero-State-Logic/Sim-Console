import { describe, expect, it } from 'vitest'
import type { TelMsg } from '../../core/protocol'
import { MAX_WHEEL_SPEED } from './constants'
import { buildCmd, hardwareSpec, parseTelemetry, telemetryRows } from './hardwareMap'
import { mecanumInverse } from './mecanum'

describe('hardware spec', () => {
  it('describes four wheels FL FR RL RR with speed limits in deg/s', () => {
    const s = hardwareSpec()
    expect(s.robot).toBe('sweeper')
    expect(s.jointNames).toEqual(['WHEEL FL', 'WHEEL FR', 'WHEEL RL', 'WHEEL RR'])
    expect(s.jointLimits[0][1]).toBe(Math.round((MAX_WHEEL_SPEED * 180) / Math.PI))
    expect(s.homePose).toEqual([0, 0, 0, 0])
  })
})

describe('commands', () => {
  it('sends wheel speeds at joint level and the body twist at high level, rounded to 1e-3', () => {
    const w = [1.23456, -2, 3, -4]
    const twist = { vx: 0.12345, vy: -0.05, wz: 0.7777 }
    expect(buildCmd('joint', w, twist, 'goto')).toEqual({ t: 'cmd', w: [1.235, -2, 3, -4], mode: 'goto' })
    expect(buildCmd('high', w, twist, 'goto')).toEqual({ t: 'cmd', v: [0.123, -0.05, 0.778], mode: 'goto' })
  })

  it('agrees with the board-side mixing the generated firmware uses', () => {
    // the virtual device and the firmware mix 'v' with the same geometry the spec sends
    const g = hardwareSpec().geometry as Record<string, number>
    const out = [0, 0, 0, 0]
    mecanumInverse(0.2, 0.1, 0.5, out)
    const k = (g.halfLength + g.halfWidth) * 0.5
    expect(out[0]).toBeCloseTo((0.2 - 0.1 - k) / g.wheelRadius)
    expect(out[3]).toBeCloseTo((0.2 - 0.1 + k) / g.wheelRadius)
  })
})

describe('telemetry parsing (untrusted input)', () => {
  it('reads encoders, converts the heading to radians and keeps a valid scan', () => {
    const p = parseTelemetry({ t: 'tel', enc: [1, 2, 3, 4], pose: [1, -1, 90], scan: { a0: 0, da: 1, r: [1, 2] } })
    expect(p.enc).toEqual([1, 2, 3, 4])
    expect(p.pose?.[2]).toBeCloseTo(Math.PI / 2)
    expect(p.scan?.r).toEqual([1, 2])
  })

  it('rejects short, non-finite or absurd fields and clamps wild encoder values', () => {
    const junk = { t: 'tel', enc: [1, 2, Number.NaN, 4], pose: [5000, 0, 0], scan: { a0: 0, da: 1, r: [] } } as TelMsg
    expect(parseTelemetry(junk)).toEqual({ enc: null, pose: null, scan: null })
    const wild = parseTelemetry({ t: 'tel', enc: [1e9, 0, 0, 0] })
    expect(wild.enc?.[0]).toBe(4 * MAX_WHEEL_SPEED)
    const huge = parseTelemetry({ t: 'tel', scan: { a0: 0, da: 0.1, r: new Array(5000).fill(1) } })
    expect(huge.scan).toBeNull()
  })

  it('builds the per-wheel table with rpm, and dashes without encoders', () => {
    const t = telemetryRows([1, 1, 1, 1], { t: 'tel', enc: [2 * Math.PI, 0, 0, 0] })
    expect(t.cols).toEqual(['WHEEL', 'CMD rad/s', 'MEAS rad/s', 'RPM'])
    expect(t.rows[0].cells).toEqual([1, 6.283, 60])
    expect(telemetryRows([0, 0, 0, 0], null).rows[0].cells).toEqual([0, '—', '—'])
  })
})
