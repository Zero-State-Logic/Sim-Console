import { describe, expect, it } from 'vitest'
import { defaultHardwareConfig, type HardwareConfig } from '../../core/hardware'
import type { CmdMsg } from '../../core/protocol'
import type { CommandLevel, HardwareSpec } from '../../core/types'
import type { CalibUi } from '../store'
import type { LinkState } from '../types'
import { CalibrationSession } from './session'
import { SWEEP_DEFAULT, sweepDurationMs } from './sweep'

const JOINTS = 3

function spec(robot: HardwareSpec['robot'] = 'walker'): HardwareSpec {
  return {
    robot,
    joints: JOINTS,
    jointNames: ['coxa', 'femur', 'tibia'],
    jointLimits: [[-60, 60], [-60, 60], [-60, 60]],
    homePose: [0, 10, -10],
    legs: 1,
    defaultLevel: { wired: 'joint', wireless: 'high' },
  }
}

interface Rig {
  s: CalibrationSession
  clock: { now: number }
  link: { linkState: LinkState; overriding: boolean; lvl: CommandLevel; source: ((now: number) => CmdMsg | null) | null }
  cfg: { current: HardwareConfig }
  ui: { last: CalibUi | null }
  robot: { spec: HardwareSpec | null }
}

function rig(): Rig {
  const clock = { now: 0 }
  const link: Rig['link'] = { linkState: 'live', overriding: false, lvl: 'joint', source: null }
  const cfg = { current: defaultHardwareConfig('esp32', JOINTS) }
  const ui: Rig['ui'] = { last: null }
  const robot: Rig['robot'] = { spec: spec() }
  const s = new CalibrationSession({
    now: () => clock.now,
    spec: () => robot.spec,
    config: () => cfg.current,
    setConfig: (patch) => void (cfg.current = { ...cfg.current, ...patch }),
    link: {
      get linkState() {
        return link.linkState
      },
      get overriding() {
        return link.source !== null
      },
      level: () => link.lvl,
      setCommandOverride: (src) => void (link.source = src),
    },
    publish: (u) => void (ui.last = u),
  })
  return { s, clock, link, cfg, ui, robot }
}

/** A servo with gain 1.02, bias +1.5° and 60 ms of delay, sampled at 25 Hz; commands at 50 Hz. */
function runSweep(r: Rig): void {
  const history: { t: number; q: number[] }[] = []
  const end = sweepDurationMs(SWEEP_DEFAULT) + 200
  for (let t = 0; t <= end; t += 20) {
    r.clock.now = t
    const cmd = r.link.source ? r.link.source(t) : null
    // like LinkController.sendCommand: a null from the override hands control back
    if (r.link.source && !cmd) r.link.source = null
    if (cmd?.q) {
      history.push({ t, q: cmd.q.slice() })
      r.s.onCommand(cmd, t)
    }
    if (t % 40 === 0 && history.length > 0) {
      let k = history.length - 1
      while (k > 0 && history[k].t > t - 60) k--
      r.s.onTelemetry({ t: 'tel', ang: history[k].q.map((q) => 1.02 * q + 1.5) }, t)
    }
    r.s.update(t)
  }
}

describe('CalibrationSession: preconditions', () => {
  it('explains what blocks recording: link not LIVE, not a walker, or not JOINT level', () => {
    // Arrange
    const r = rig()
    // Act / Assert
    r.link.linkState = 'ready'
    expect(r.s.blocker()).toMatch(/LIVE link/)
    r.link.linkState = 'live'
    r.robot.spec = spec('sweeper')
    expect(r.s.blocker()).toMatch(/WALKER/)
    r.robot.spec = spec()
    r.link.lvl = 'high'
    expect(r.s.blocker()).toMatch(/JOINT/)
    r.link.lvl = 'joint'
    expect(r.s.blocker()).toBeNull()
  })

  it('does not start recording while blocked, and says why', () => {
    // Arrange
    const r = rig()
    r.link.linkState = 'homing'
    // Act
    r.s.startRecording()
    // Assert
    expect(r.ui.last?.recording).toBe(false)
    expect(r.ui.last?.message).toMatch(/LIVE link/)
  })

  it('needs a recording before FIT and a fit before APPLY', () => {
    // Arrange
    const r = rig()
    // Act
    r.s.fit()
    const fitMsg = r.ui.last?.message
    r.s.apply()
    // Assert
    expect(fitMsg).toBe('Nothing recorded yet.')
    expect(r.ui.last?.message).toBe('Run FIT first.')
  })
})

describe('CalibrationSession: record and fit', () => {
  it('records only joint commands and measured angles while recording', () => {
    // Arrange
    const r = rig()
    r.s.startRecording()
    // Act
    r.s.onCommand({ t: 'cmd', q: [1, 2, 3] }, 10)
    r.s.onCommand({ t: 'cmd', v: [0.1, 0, 0] }, 20)
    r.s.onTelemetry({ t: 'tel', ang: [1, 2, 3] }, 30)
    r.s.onTelemetry({ t: 'tel', imu: [0, 0, 0] }, 40)
    r.s.stopRecording()
    r.s.onCommand({ t: 'cmd', q: [1, 2, 3] }, 50)
    // Assert
    expect(r.ui.last?.cmdSamples).toBe(1)
    expect(r.ui.last?.telSamples).toBe(1)
    expect(r.ui.last?.recording).toBe(false)
    expect(r.ui.last?.message).toMatch(/Stopped: 1 measured samples/)
  })

  it('reports a failed fit with too little data', () => {
    // Arrange
    const r = rig()
    r.s.startRecording()
    r.s.onCommand({ t: 'cmd', q: [1, 2, 3] }, 10)
    r.s.onTelemetry({ t: 'tel', ang: [1, 2, 3] }, 30)
    // Act
    r.s.fit()
    // Assert
    expect(r.ui.last?.result?.ok).toBe(false)
    expect(r.ui.last?.message).toMatch(/^Fit failed: need at least/)
  })
})

describe('CalibrationSession: step sweep', () => {
  it('drives the joints through the sweep, fits on its own at the end, and APPLY cancels the error', () => {
    // Arrange
    const r = rig()
    // Act
    r.s.startSweep()
    const started = r.ui.last
    runSweep(r)
    const fitted = r.ui.last
    r.s.apply()
    // Assert
    expect(started?.sweeping).toBe(true)
    expect(started?.message).toMatch(/Step sweep: every joint steps ±15°/)
    expect(r.link.source).toBeNull()
    expect(fitted?.sweeping).toBe(false)
    const res = fitted?.result
    expect(res?.ok).toBe(true)
    if (!res?.ok) return
    expect(res.latency.lagMs).toBeGreaterThan(40)
    expect(res.latency.lagMs).toBeLessThan(110)
    for (const j of res.joints) {
      expect(j.source).toBe('static')
      expect(j.fit?.a).toBeCloseTo(1.02, 3)
      expect(j.fit?.b).toBeCloseTo(1.5, 2)
    }
    for (let j = 0; j < JOINTS; j++) {
      expect(r.cfg.current.jointScale[j]).toBeCloseTo(1 / 1.02, 4)
      expect(r.cfg.current.jointOffsetDeg[j]).toBeCloseTo(-1.5 / 1.02, 2)
    }
    expect(r.ui.last?.message).toMatch(/GENERATE FIRMWARE/)
    expect(r.ui.last?.result).toBeNull()
  })

  it('notices a sweep cut short when the link leaves LIVE (override cleared)', () => {
    // Arrange
    const r = rig()
    r.s.startSweep()
    r.clock.now = 500
    r.link.source?.(500)
    // Act: E-STOP or link loss clears the override in the controller
    r.link.source = null
    r.s.update(600)
    // Assert
    expect(r.ui.last?.sweeping).toBe(false)
    expect(r.ui.last?.recording).toBe(false)
    expect(r.ui.last?.message).toBe('Sweep interrupted (the link left LIVE).')
  })

  it('STOP SWEEP hands control back and keeps the take for FIT', () => {
    // Arrange
    const r = rig()
    r.s.startSweep()
    r.s.onCommand({ t: 'cmd', q: [1, 2, 3] }, 10)
    // Act
    r.s.stopSweep()
    // Assert
    expect(r.link.source).toBeNull()
    expect(r.ui.last?.cmdSamples).toBe(1)
    expect(r.ui.last?.message).toMatch(/Sweep stopped early/)
  })

  it('RESET stops a sweep and restores the identity mapping', () => {
    // Arrange
    const r = rig()
    r.cfg.current = { ...r.cfg.current, jointScale: [0.9, 1, 1.1], jointOffsetDeg: [1, 2, 3] }
    r.s.startSweep()
    // Act
    r.s.reset()
    // Assert
    expect(r.link.source).toBeNull()
    expect(r.cfg.current.jointScale).toEqual([1, 1, 1])
    expect(r.cfg.current.jointOffsetDeg).toEqual([0, 0, 0])
    expect(r.ui.last?.message).toMatch(/Calibration reset/)
  })

  it('clear() drops everything (robot change or link drop)', () => {
    // Arrange
    const r = rig()
    r.s.startSweep()
    // Act
    r.s.clear()
    // Assert
    expect(r.link.source).toBeNull()
    expect(r.ui.last).toMatchObject({ recording: false, sweeping: false, cmdSamples: 0, result: null, message: null })
  })
})
