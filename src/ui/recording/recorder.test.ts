import { beforeEach, describe, expect, it } from 'vitest'
import { RECORD_CAPACITY, Recorder, useRecorder } from '../../core/recorder'
import { useConsole } from '../../store'
import type { RobotKind, RobotModule, StepContext, TelemetryFrame } from '../../core/types'

/* A minimal module whose whole state is one number, so restore() is observable. */
class FakeModule {
  x = 0
  restored: unknown[] = []
  updates: number[] = []
  constructor(readonly kind: RobotKind = 'walker', readonly label = 'WALKER') {}
  snapshot(): unknown {
    return { x: this.x }
  }
  restore(s: unknown): void {
    this.restored.push(s)
    this.x = (s as { x: number }).x
  }
  update(dt: number, _ctx: StepContext): void {
    this.updates.push(dt)
  }
  asModule(): RobotModule {
    return this as unknown as RobotModule
  }
}

function tel(v: number): TelemetryFrame {
  return { t: 0, gauges: { v }, channels: { v }, bars: [v], readouts: { v } }
}

/** Drive `seconds` of sim at 60 Hz with x = t. */
function simulate(rec: Recorder, m: FakeModule, from: number, seconds: number): number {
  let t = from
  const frames = Math.round(seconds * 60)
  for (let i = 0; i < frames; i++) {
    t += 1 / 60
    m.x = t
    rec.capture(t, m.asModule(), tel(t))
  }
  return t
}

describe('Recorder', () => {
  let clock = 0
  let rec: Recorder
  let m: FakeModule

  beforeEach(() => {
    clock = 0
    rec = new Recorder(() => clock)
    m = new FakeModule()
    useConsole.setState({ playing: true, timeScale: 1 })
  })

  it('ignores frames until recording starts', () => {
    simulate(rec, m, 0, 1)
    expect(rec.size).toBe(0)
  })

  it('samples at 30 Hz from a 60 Hz loop', () => {
    // Arrange
    rec.start(m.asModule())
    // Act
    simulate(rec, m, 0, 2)
    // Assert
    expect(rec.size).toBe(60)
    expect(rec.isRecording()).toBe(true)
  })

  it('still samples at 30 Hz when the display runs at 50 Hz', () => {
    // Arrange
    rec.start(m.asModule())
    // Act: 2 s at 50 Hz (sampling every other frame would give 25 Hz)
    for (let f = 1; f <= 100; f++) rec.capture(f / 50, m.asModule(), tel(f / 50))
    // Assert
    expect(Math.abs(rec.size - 60)).toBeLessThanOrEqual(1)
  })

  it('caps the buffer at 120 s and keeps the newest frames', () => {
    rec.start(m.asModule())
    const end = simulate(rec, m, 0, 125)
    expect(rec.size).toBe(RECORD_CAPACITY)
    const frames = rec.frames()
    const newest = frames[frames.length - 1].t
    expect(end - newest).toBeLessThan(1 / 30)
    expect(newest - frames[0].t).toBeCloseTo(120 - 1 / 30, 6)
  })

  it('stores telemetry copies, not references', () => {
    rec.start(m.asModule())
    const frame = tel(1)
    rec.capture(1, m.asModule(), frame)
    frame.gauges.v = 42
    expect(rec.frameAt(0)?.tel.gauges.v).toBe(1)
    expect(rec.frameAt(0)?.tel.t).toBe(1)
  })

  it('restarts the buffer when the sim clock goes backwards', () => {
    rec.start(m.asModule())
    simulate(rec, m, 0, 1)
    simulate(rec, m, 0, 0.5)
    expect(rec.size).toBe(15)
  })

  it('restarts the buffer when the robot kind changes mid-recording', () => {
    rec.start(m.asModule())
    simulate(rec, m, 0, 1)
    const other = new FakeModule('sweeper', 'SWEEPER')
    clock += 250
    simulate(rec, other, 1, 0.5)
    expect(rec.size).toBe(15)
    expect(useRecorder.getState().kind).toBe('sweeper')
  })

  it('enters replay, pauses the live sim and restores the first frame', () => {
    // Arrange
    rec.start(m.asModule())
    simulate(rec, m, 0, 1)
    m.x = 77
    // Act
    const ok = rec.enterReplay(m.asModule(), 1)
    const shown = rec.applyReplayFrame(m.asModule())
    // Assert
    expect(ok).toBe(true)
    expect(rec.isReplaying()).toBe(true)
    expect(rec.isRecording()).toBe(false)
    expect(useConsole.getState().playing).toBe(false)
    expect(m.x).toBeCloseTo(1 / 60, 6)
    expect(shown?.gauges.v).toBeCloseTo(1 / 60, 6)
    expect(m.updates.at(-1)).toBe(0)
  })

  it('refuses to enter replay with an empty buffer', () => {
    expect(rec.enterReplay(m.asModule())).toBe(false)
    expect(rec.applyReplayFrame(m.asModule())).toBeNull()
  })

  it('seeks to the frame at or before the cursor and restores only on change', () => {
    rec.start(m.asModule())
    simulate(rec, m, 0, 1)
    rec.enterReplay(m.asModule())
    rec.seek(0.5)
    rec.applyReplayFrame(m.asModule())
    const restores = m.restored.length
    rec.applyReplayFrame(m.asModule())
    expect(m.restored.length).toBe(restores)
    expect(m.x).toBeLessThanOrEqual(0.5)
    expect(m.x).toBeGreaterThan(0.5 - 1 / 30 - 1e-9)
  })

  it('advances the cursor in real time scaled by the sim speed while playing', () => {
    rec.start(m.asModule())
    simulate(rec, m, 0, 2)
    rec.enterReplay(m.asModule())
    useConsole.setState({ timeScale: 2 })
    rec.setReplayPlaying(true)
    const start = rec.cursor()
    clock += 50
    rec.applyReplayFrame(m.asModule())
    clock += 50
    rec.applyReplayFrame(m.asModule())
    expect(rec.cursor() - start).toBeCloseTo(0.2, 6)
  })

  it('stops playing at the end and rewinds when play is pressed again', () => {
    rec.start(m.asModule())
    simulate(rec, m, 0, 0.5)
    const end = rec.frames()[rec.size - 1].t
    rec.enterReplay(m.asModule())
    rec.setReplayPlaying(true)
    for (let i = 0; i < 20; i++) {
      clock += 100
      rec.applyReplayFrame(m.asModule())
    }
    expect(rec.isReplayPlaying()).toBe(false)
    expect(rec.cursor()).toBeCloseTo(end, 6)
    rec.setReplayPlaying(true)
    expect(rec.cursor()).toBeCloseTo(1 / 60, 6)
  })

  it('steps whole frames and clamps at the ends', () => {
    rec.start(m.asModule())
    simulate(rec, m, 0, 1)
    rec.enterReplay(m.asModule())
    rec.step(3)
    expect(rec.indexAt(rec.cursor())).toBe(3)
    rec.step(-10)
    expect(rec.indexAt(rec.cursor())).toBe(0)
    rec.step(1000)
    expect(rec.indexAt(rec.cursor())).toBe(rec.size - 1)
  })

  it('exits replay back to the live state and play flag captured on entry', () => {
    // Arrange
    rec.start(m.asModule())
    simulate(rec, m, 0, 1)
    m.x = 123
    rec.enterReplay(m.asModule(), 1)
    rec.seek(0.2)
    rec.applyReplayFrame(m.asModule())
    // Act
    rec.exitReplay(m.asModule())
    // Assert
    expect(rec.isReplaying()).toBe(false)
    expect(m.x).toBe(123)
    expect(useConsole.getState().playing).toBe(true)
    expect(rec.size).toBeGreaterThan(0)
  })

  it('clear() drops frames, leaves replay and restores the play flag', () => {
    rec.start(m.asModule())
    simulate(rec, m, 0, 1)
    rec.enterReplay(m.asModule())
    rec.clear()
    expect(rec.size).toBe(0)
    expect(rec.isReplaying()).toBe(false)
    expect(useConsole.getState().playing).toBe(true)
  })

  it('clear() keeps a running recording armed so a reset keeps capturing', () => {
    rec.start(m.asModule())
    simulate(rec, m, 0, 1)
    rec.clear()
    simulate(rec, m, 0, 0.5)
    expect(rec.isRecording()).toBe(true)
    expect(rec.size).toBe(15)
  })

  it('discard() stops recording and empties the buffer', () => {
    rec.start(m.asModule())
    simulate(rec, m, 0, 1)
    rec.discard(m.asModule())
    expect(rec.size).toBe(0)
    expect(rec.isRecording()).toBe(false)
  })

  it('exports CSV rows and a JSON file that imports back into replay', () => {
    // Arrange
    rec.start(m.asModule())
    simulate(rec, m, 0, 1)
    rec.stop()
    const csv = rec.exportCsv()
    const json = rec.exportJson(new Date('2026-11-03T00:00:00Z'))
    // Act
    const fresh = new Recorder(() => clock)
    const res = fresh.importJson(json, m.asModule(), 5)
    // Assert
    expect(csv.trim().split('\n')).toHaveLength(31)
    expect(res).toEqual({ ok: true, frames: 30 })
    expect(fresh.isReplaying()).toBe(true)
  })

  it('rejects an import for another robot and reports the message', () => {
    rec.start(m.asModule())
    simulate(rec, m, 0, 0.5)
    const json = rec.exportJson()
    const res = new Recorder(() => clock).importJson(json, new FakeModule('swarm', 'SWARM').asModule())
    expect(res.ok).toBe(false)
    expect(useRecorder.getState().message).toContain('Switch to WALKER')
  })

  it('pushes store updates on transitions and throttles them while recording', () => {
    rec.start(m.asModule())
    expect(useRecorder.getState().recording).toBe(true)
    simulate(rec, m, 0, 1)
    // the clock never advanced, so only the forced push from start() landed
    expect(useRecorder.getState().frames).toBe(0)
    clock += 250
    simulate(rec, m, 1, 0.1)
    expect(useRecorder.getState().frames).toBeGreaterThan(30)
  })
})
