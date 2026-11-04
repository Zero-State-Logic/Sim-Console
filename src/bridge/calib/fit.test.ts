import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig, jointToServoDeg, servoToJointDeg, type HardwareConfig } from '../../core/hardware'
import type { HardwareSpec } from '../../core/types'
import { HOME_MS, VirtualDevice } from '../virtual/device'
import type { WalkerBody } from '../virtual/bodies'
import { CalibrationRecorder, snapshotMapping, type Series } from './recorder'
import {
  calibrate,
  calibrationPatch,
  correctedMapping,
  estimateLatency,
  fitLinear,
  identityCalibration,
  type CalibrationResult,
} from './fit'
import { SWEEP_DEFAULT, SWEEP_LEVELS, sweepDurationMs, sweepTargets } from './sweep'

function series(times: number[], rows: number[][]): Series {
  const stride = rows[0]?.length ?? 0
  const v = new Float64Array(times.length * stride)
  rows.forEach((r, i) => r.forEach((x, j) => (v[i * stride + j] = x)))
  return { t: Float64Array.from(times), v, n: times.length, stride }
}

/** A gait-like commanded signal: two sines per joint. */
function command(t: number, j: number): number {
  return 20 * Math.sin(2 * Math.PI * 0.7 * (t / 1000) + j) + 8 * Math.sin(2 * Math.PI * 1.9 * (t / 1000) + 2 * j)
}

function ok(r: CalibrationResult): Extract<CalibrationResult, { ok: true }> {
  if (!r.ok) throw new Error(r.reason)
  return r
}

describe('fitLinear', () => {
  it('recovers slope and intercept exactly from noiseless data', () => {
    const x = Array.from({ length: 50 }, (_, i) => i - 25)
    const y = x.map((v) => 1.03 * v - 2.5)
    const f = fitLinear(x, y)
    expect(f?.a).toBeCloseTo(1.03, 10)
    expect(f?.b).toBeCloseTo(-2.5, 10)
    expect(f?.rms).toBeCloseTo(0, 10)
    expect(f?.rmsRaw).toBeGreaterThan(1)
    expect(f?.excited).toBe(true)
  })

  it('falls back to an offset-only fit when the joint barely moved', () => {
    const x = Array.from({ length: 30 }, (_, i) => 10 + (i % 3) * 0.5)
    const y = x.map((v) => v + 1.5)
    const f = fitLinear(x, y)
    expect(f).toMatchObject({ a: 1, excited: false })
    expect(f?.b).toBeCloseTo(1.5, 10)
  })

  it('needs at least three points', () => {
    expect(fitLinear([1, 2], [1, 2])).toBeNull()
  })
})

describe('correctedMapping round trip through jointToServoDeg', () => {
  for (const invert of [false, true]) {
    it(`cancels a mounting error so measured equals commanded (invert=${invert})`, () => {
      // Arrange: a config in use and the physical truth it is wrong about
      const cfg: HardwareConfig = { ...defaultHardwareConfig('esp32', 1), jointInvert: [invert], jointOffsetDeg: [1.2], jointScale: [0.98] }
      const truth: HardwareConfig = { ...cfg, jointOffsetDeg: [-2.7], jointScale: [1.035] }
      const measure = (c: HardwareConfig, q: number) => servoToJointDeg(truth, 0, jointToServoDeg(c, 0, q))
      const xs = Array.from({ length: 40 }, (_, i) => -40 + 2 * i)
      // Act
      const f = fitLinear(xs, xs.map((q) => measure(cfg, q)))
      const fixed = correctedMapping(f!.a, f!.b, 0.98, 1.2, invert)
      const cfg2 = { ...cfg, jointScale: [fixed.scale], jointOffsetDeg: [fixed.offset] }
      // Assert
      expect(fixed.scale).toBeCloseTo(1.035, 9)
      expect(fixed.offset).toBeCloseTo(-2.7, 9)
      for (const q of [-30, 0, 12.5, 45]) expect(measure(cfg2, q)).toBeCloseTo(q, 9)
    })
  }
})

describe('estimateLatency', () => {
  it('finds a pure delay between commanded and measured', () => {
    const tc = Array.from({ length: 1000 }, (_, i) => i * 20)
    const tm = Array.from({ length: 500 }, (_, i) => 10 + i * 40)
    const cmd = series(tc, tc.map((t) => [command(t, 0), command(t, 1)]))
    const meas = series(tm, tm.map((t) => [command(t - 70, 0), command(t - 70, 1)]))
    const a = estimateLatency(cmd, meas, 400)
    expect(a.lagMs).toBeGreaterThan(65)
    expect(a.lagMs).toBeLessThan(75)
    expect(a.score).toBeGreaterThan(0.99)
  })

  it('returns NaN score when nothing moved', () => {
    const t = Array.from({ length: 100 }, (_, i) => i * 20)
    const flat = series(t, t.map(() => [5]))
    expect(Number.isNaN(estimateLatency(flat, flat).score)).toBe(true)
  })
})

describe('calibrate', () => {
  const mapping = { jointScale: [1, 1], jointOffsetDeg: [0, 0], jointInvert: [false, false] }

  it('recovers per-joint gain/offset and the delay from a lagged, noisy recording', () => {
    // measured = a·cmd(t − 50 ms) + b with small noise
    const truth = [{ a: 0.97, b: 2 }, { a: 1.04, b: -1.5 }]
    let seed = 1
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.4
    const tc = Array.from({ length: 1500 }, (_, i) => i * 20)
    const tm = Array.from({ length: 750 }, (_, i) => 7 + i * 40)
    const cmd = series(tc, tc.map((t) => [command(t, 0), command(t, 1)]))
    const meas = series(tm, tm.map((t) => truth.map((p, j) => p.a * command(t - 50, j) + p.b + noise())))
    const r = ok(calibrate(cmd, meas, mapping, ['A', 'B']))
    expect(r.latency.lagMs).toBeGreaterThan(40)
    expect(r.latency.lagMs).toBeLessThan(60)
    r.joints.forEach((jc, j) => {
      expect(jc.fit?.a).toBeCloseTo(truth[j].a, 2)
      expect(jc.fit?.b).toBeCloseTo(truth[j].b, 1)
      expect(jc.fit!.rms).toBeLessThan(jc.fit!.rmsRaw)
      expect(jc.suspect).toBe(false)
    })
  })

  /** Simulate a first-order servo (tau ms) at 1 kHz on a 20 ms command stream, sampled at 25 Hz. */
  function servoTake(target: (t: number) => number, tauMs: number, gain: number, bias: number) {
    const tc = Array.from({ length: 1500 }, (_, i) => i * 20)
    const cmd = series(tc, tc.map((t) => [target(t)]))
    const tm: number[] = []
    const ym: number[][] = []
    let y = target(0)
    for (let t = 1; t < 30000; t++) {
      y += (target(Math.floor(t / 20) * 20) - y) * (1 - Math.exp(-1 / tauMs))
      if (t % 40 === 0) {
        tm.push(t)
        ym.push([gain * y + bias])
      }
    }
    return calibrate(cmd, series(tm, ym), { jointScale: [1], jointOffsetDeg: [0], jointInvert: [false] }, ['A'])
  }

  it('fits held (settled) steps without the servo-lag bias', () => {
    const stairs = (t: number) => [0, 15, -15, 7.5, -7.5, 11, -4, 4, -11][Math.floor(t / 900) % 9]
    const r = ok(servoTake(stairs, 60, 1.02, 0.5))
    expect(r.joints[0].source).toBe('static')
    expect(r.joints[0].fit?.a).toBeCloseTo(1.02, 3)
    expect(r.joints[0].fit?.b).toBeCloseTo(0.5, 2)
  })

  it('falls back to moving pairs (flagged dynamic) when the command never settles', () => {
    const r = ok(servoTake((t) => command(t, 0), 60, 1.02, 0.5))
    expect(r.joints[0].source).toBe('dynamic')
    expect(r.joints[0].fit?.excited).toBe(true)
  })

  it('marks an inverted joint as suspect and leaves it out of the patch', () => {
    const tc = Array.from({ length: 500 }, (_, i) => i * 20)
    const cmd = series(tc, tc.map((t) => [command(t, 0), command(t, 1)]))
    const meas = series(tc, tc.map((t) => [-command(t, 0), command(t, 1) + 3]))
    const r = ok(calibrate(cmd, meas, mapping, ['A', 'B']))
    const patch = calibrationPatch({ jointScale: [1, 1], jointOffsetDeg: [0, 0] }, r, 2)
    expect(r.joints[0].suspect).toBe(true)
    expect(patch.jointScale[0]).toBe(1)
    expect(patch.jointOffsetDeg[0]).toBe(0)
    expect(patch.jointOffsetDeg[1]).toBeCloseTo(-3, 1)
  })

  it('refuses to fit with too few samples or no joints', () => {
    const tiny = series([0, 20, 40], [[1], [2], [3]])
    expect(calibrate(tiny, tiny, mapping, ['A'])).toMatchObject({ ok: false })
    const empty: Series = { t: new Float64Array(0), v: new Float64Array(0), n: 0, stride: 0 }
    expect(calibrate(empty, empty, mapping, [])).toEqual({ ok: false, reason: 'no joint-level samples recorded' })
  })

  it('identityCalibration resets every joint', () => {
    expect(identityCalibration(3)).toEqual({ jointScale: [1, 1, 1], jointOffsetDeg: [0, 0, 0] })
  })
})

describe('CalibrationRecorder', () => {
  it('records only while recording, only matching joint counts, with increasing times', () => {
    const rec = new CalibrationRecorder(4, 4)
    const cfg = defaultHardwareConfig('esp32', 2)
    rec.addCommand(0, [1, 2])
    rec.start(2, cfg)
    rec.addCommand(10, [1, 2])
    rec.addCommand(10, [3, 4])
    rec.addCommand(20, [1])
    rec.addMeasured(15, [1, 2])
    expect(rec.cmdSamples).toBe(1)
    expect(rec.telSamples).toBe(1)
    expect(rec.mapping).toEqual(snapshotMapping(cfg, 2))
  })

  it('stops itself when full', () => {
    const rec = new CalibrationRecorder(2, 2)
    rec.start(1, defaultHardwareConfig('esp32', 1))
    for (let i = 0; i < 5; i++) rec.addCommand(i, [i])
    expect(rec.cmdSamples).toBe(2)
    expect(rec.recording).toBe(false)
    expect(rec.full).toBe(true)
    rec.clear()
    expect(rec.cmdSamples).toBe(0)
  })
})

describe('calibration end to end on the virtual device', () => {
  it('finds the hidden mounting error and APPLY makes measured track commanded', () => {
    // Arrange: a miscalibrated virtual walker, homed
    const joints = 6
    const spec: HardwareSpec = {
      robot: 'walker',
      joints,
      jointNames: Array.from({ length: joints }, (_, i) => `J${i}`),
      jointLimits: Array.from({ length: joints }, () => [-70, 70] as [number, number]),
      homePose: new Array(joints).fill(0),
      legs: 2,
      defaultLevel: { wired: 'joint', wireless: 'high' },
    }
    const cfg = { current: defaultHardwareConfig('esp32', joints) }
    const lines: string[] = []
    const dev = new VirtualDevice({ spec, getConfig: () => cfg.current, emit: (l) => lines.push(l), miscalibrate: true, seed: 11 })
    dev.start()
    dev.step(400)
    dev.receive('{"t":"home"}')
    dev.step(HOME_MS + 50)
    const body = dev.physical as WalkerBody

    const take = () => {
      const rec = new CalibrationRecorder()
      rec.start(joints, cfg.current)
      lines.length = 0
      const q: number[] = []
      for (let t = 0; sweepTargets(spec, SWEEP_DEFAULT, t, q); t += 20) {
        dev.receive(JSON.stringify({ t: 'cmd', seq: t, q }))
        rec.addCommand(dev.uptimeMs, q)
        dev.step(20)
        for (const l of lines.splice(0)) {
          const m = JSON.parse(l) as { t: string; ang?: number[] }
          if (m.t === 'tel') rec.addMeasured(dev.uptimeMs, m.ang)
        }
      }
      return ok(calibrate(rec.data().cmd, rec.data().tel, rec.mapping!, spec.jointNames))
    }

    // Act
    const first = take()
    cfg.current = { ...cfg.current, ...calibrationPatch(cfg.current, first, joints) }
    const second = take()

    // Assert: proposed values match the hidden truth, and the residual after APPLY is noise-level
    first.joints.forEach((jc, j) => {
      expect(jc.source).toBe('static')
      expect(Math.abs(jc.scale - body.trueScale[j])).toBeLessThan(0.005)
      expect(Math.abs(jc.offset - body.trueOffset[j])).toBeLessThan(0.25)
    })
    second.joints.forEach((jc) => {
      expect(jc.fit!.rmsRaw).toBeLessThan(0.6)
      expect(Math.abs(jc.fit!.a - 1)).toBeLessThan(0.005)
    })
    expect(first.joints.some((jc) => jc.fit!.rmsRaw > 1)).toBe(true)
  })
})

describe('sweepTargets', () => {
  const spec: HardwareSpec = {
    robot: 'walker',
    joints: 3,
    jointNames: ['a', 'b', 'c'],
    jointLimits: [[-90, 90], [-10, 10], [-90, 90]],
    homePose: [0, 5, -20],
    defaultLevel: { wired: 'joint', wireless: 'high' },
  }

  it('visits every level on every joint around home, clamped to the limits', () => {
    const out: number[] = []
    const seen: number[][] = [[], [], []]
    for (let t = 0; sweepTargets(spec, SWEEP_DEFAULT, t, out); t += SWEEP_DEFAULT.holdMs) out.forEach((q, j) => seen[j].push(q))
    expect(seen[0]).toHaveLength(SWEEP_LEVELS.length * SWEEP_DEFAULT.cycles)
    expect(new Set(seen[0]).size).toBe(SWEEP_LEVELS.length)
    expect(Math.max(...seen[0])).toBe(15)
    expect(Math.max(...seen[1])).toBe(10)
    expect(Math.min(...seen[2])).toBe(-35)
  })

  it('holds each level for holdMs and ends after the planned duration', () => {
    const a: number[] = []
    const b: number[] = []
    sweepTargets(spec, SWEEP_DEFAULT, 10, a)
    sweepTargets(spec, SWEEP_DEFAULT, SWEEP_DEFAULT.holdMs - 10, b)
    expect(a).toEqual(b)
    expect(sweepTargets(spec, SWEEP_DEFAULT, sweepDurationMs(SWEEP_DEFAULT), a)).toBe(false)
    expect(sweepTargets(spec, SWEEP_DEFAULT, -1, a)).toBe(false)
  })
})
