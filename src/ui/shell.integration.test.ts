import { beforeEach, describe, expect, it } from 'vitest'
import { runtime } from '../core/runtime'
import { recorder, RECORD_HZ } from '../core/recorder'
import { telemetryBus } from '../core/telemetryBus'
import { useHardware } from '../core/hardware'
import { applyControlValues, applyProfile, captureProfile, parseProfileFile, serializeProfile, type ProfileTarget } from '../core/profiles'
import { ROBOT_KINDS } from '../robots'
import { useConsole } from '../store'
import type { RobotKind, RobotModule } from '../core/types'
import { groupControls } from './controls/controlMath'
import { dirFromKeys, driveKeyInfo, resolveDir } from './keyboard/keymap'
import { presetsFor } from './profiles/presets'

/*
 * Shell × real robot modules, headless. Drives the actual runtime with every registered
 * robot and checks the contract the generic rails rely on: every instrument key the
 * layout names is present in the telemetry, the control schema is well-formed and
 * keyboard-bindable, and record / replay / profiles round-trip through the module.
 * A kind without a module of its own runs the registry's placeholder; the checks
 * that need the real schema are skipped for it.
 */
const FRAME_DT = 1 / 60
const DIR_VALUES = ['fl', 'f', 'fr', 'l', 'stop', 'r', 'bl', 'b', 'br']
const TURN_VALUES = ['ccw', 'none', 'cw']
const CAMERA_IDS = ['iso', 'front', 'side', 'top']

function run(frames: number): void {
  for (let i = 0; i < frames; i++) runtime.frame(FRAME_DT)
}

function isPlaceholder(m: RobotModule): boolean {
  return m.getInstrumentLayout().subtitle === 'PLACEHOLDER'
}

const target: ProfileTarget = {
  currentKind: () => runtime.module.kind,
  setRobot: (k) => runtime.setRobot(k),
  module: () => runtime.module,
  setControl: (k, v) => runtime.setControl(k, v),
  setHardware: (cfg) => useHardware.getState().setConfig(cfg),
}

beforeEach(() => {
  useConsole.setState({ playing: true, timeScale: 1, driveSource: 'sim' })
})

describe.each(ROBOT_KINDS.map((r) => r.kind))('%s module in the shell', (kind: RobotKind) => {
  beforeEach(() => {
    runtime.setRobot(kind)
  })

  it('publishes a value for every gauge, channel, bar and readout the layout names', () => {
    // Arrange + Act
    run(45)
    const layout = runtime.module.getInstrumentLayout()
    const tel = telemetryBus.current
    // Assert
    for (const g of layout.gauges) expect(Number.isFinite(tel.gauges[g.key]), `gauge ${g.key}`).toBe(true)
    for (const c of layout.charts) {
      for (const ch of c.channels) expect(Number.isFinite(tel.channels[ch.key]), `chart ${c.key} channel ${ch.key}`).toBe(true)
    }
    if (layout.bars) expect(tel.bars.length, 'bar count').toBeGreaterThanOrEqual(layout.bars.labels.length)
    for (const r of layout.readouts) expect(tel.readouts[r.key], `readout ${r.key}`).toBeDefined()
    expect(runtime.t).toBeCloseTo(45 * FRAME_DT, 6)
  })

  it('declares a well-formed, groupable control schema with in-range values', () => {
    const m = runtime.module
    const schema = m.getControlSchema()
    const values = m.getControlValues()
    expect(new Set(schema.map((d) => d.key)).size).toBe(schema.length)
    expect(groupControls(schema).length).toBeGreaterThan(0)
    for (const d of schema) {
      const v = values[d.key]
      if (d.type === 'slider') {
        expect(d.max, `${d.key} range`).toBeGreaterThan(d.min)
        if (typeof v === 'number') {
          expect(v, `${d.key} value`).toBeGreaterThanOrEqual(d.min - 1e-9)
          expect(v, `${d.key} value`).toBeLessThanOrEqual(d.max + 1e-9)
        }
      } else if (d.type === 'select' && v !== undefined) {
        expect(d.options.map((o) => o.value), `${d.key} options`).toContain(v)
      }
    }
  })

  it('follows the shared keyboard and camera conventions', () => {
    const m = runtime.module
    const ids = m.world.cameraPresets.map((p) => p.id)
    expect(ids[0]).toBe('iso')
    expect(new Set(ids).size).toBe(ids.length)
    if (isPlaceholder(m)) return
    for (const id of CAMERA_IDS) expect(ids, `camera preset ${id}`).toContain(id)
    const info = driveKeyInfo(m.getControlSchema())
    if (info.dir) expect(info.dir).toEqual(DIR_VALUES)
    if (info.turn) for (const v of info.turn) expect(TURN_VALUES).toContain(v)
  })

  it('accepts keyboard drive values and keeps stepping', () => {
    const info = driveKeyInfo(runtime.module.getControlSchema())
    if (!info.dir) return
    runtime.setControl('dir', resolveDir(dirFromKeys(new Set(['KeyW', 'KeyD'])), info.dir))
    if (info.turn) runtime.setControl('turn', 'ccw')
    run(30)
    expect(runtime.module.getControlValues().dir).toBe('fr')
    runtime.setControl('dir', 'stop')
    if (info.turn) runtime.setControl('turn', 'none')
    run(5)
    expect(Number.isFinite(runtime.t)).toBe(true)
  })

  it('records at 30 Hz, replays the past and returns to the live state', () => {
    // Arrange
    const m = runtime.module
    recorder.start(m)
    run(60)
    recorder.stop()
    const frames = recorder.size
    // Act
    expect(recorder.enterReplay(m, runtime.t)).toBe(true)
    recorder.seek(recorder.frameAt(Math.floor(frames / 2))?.t ?? 0)
    run(3)
    const replayT = runtime.t
    recorder.exitReplay(m)
    run(1)
    // Assert
    expect(frames).toBeGreaterThanOrEqual(RECORD_HZ - 2)
    expect(frames).toBeLessThanOrEqual(RECORD_HZ + 1)
    expect(replayT).toBeCloseTo(60 * FRAME_DT, 6)
    expect(recorder.isReplaying()).toBe(false)
    expect(useConsole.getState().playing).toBe(true)
    expect(recorder.exportCsv().split('\n')[0].startsWith('t')).toBe(true)
  })

  it('shows the recorded pose while scrubbing and the live pose again after BACK TO LIVE', () => {
    // Arrange: drive forward (if the module has a pad) while recording
    const m = runtime.module
    const info = driveKeyInfo(m.getControlSchema())
    if (info.dir) runtime.setControl('dir', 'f')
    recorder.start(m)
    run(1)
    const firstT = recorder.frameAt(0)?.t ?? 0
    const recorded = m.followTarget()?.clone()
    run(120)
    recorder.stop()
    const live = m.followTarget()?.clone()
    if (info.dir) runtime.setControl('dir', 'stop')
    // a module that did not move in 2 s has no poses to tell apart
    if (!recorded || !live || recorded.distanceTo(live) < 0.01) {
      recorder.discard(m)
      return
    }
    // Act + Assert
    recorder.enterReplay(m, runtime.t)
    recorder.seek(firstT)
    run(1)
    expect(m.followTarget()?.distanceTo(recorded), 'replayed pose').toBeLessThan(1e-3)
    recorder.exitReplay(m)
    // the live view is drawn interpolated, up to one 120 Hz physics substep (<= 3 mm at
    // sweeper speed) behind the physics pose that BACK TO LIVE restores exactly
    expect(m.followTarget()?.distanceTo(live), 'live pose').toBeLessThan(5e-3)
    recorder.discard(m)
  })

  it('re-imports its own JSON recording and rejects other robot kinds', () => {
    const m = runtime.module
    recorder.start(m)
    run(20)
    recorder.stop()
    const json = recorder.exportJson()
    const res = recorder.importJson(json, m, runtime.t)
    expect(res.ok).toBe(true)
    expect(recorder.isReplaying()).toBe(true)
    run(2)
    recorder.exitReplay(m)
    const other = ROBOT_KINDS.find((r) => r.kind !== kind)?.kind ?? 'walker'
    const foreign = json.replace(`"kind":"${kind}"`, `"kind":"${other}"`)
    const rejected = recorder.importJson(foreign, m, runtime.t)
    expect(rejected.ok).toBe(false)
    recorder.discard(m)
  })

  it('round-trips a saved profile through a JSON file', () => {
    // Arrange
    const saved = captureProfile('bench test', runtime.module, useHardware.getState().config)
    const parsed = parseProfileFile(serializeProfile(saved))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    runtime.setRobot(kind)
    // Act
    const report = applyProfile(parsed.value[0], target)
    // Assert
    expect(report.rejected).toEqual([])
    expect(report.configError).toBeNull()
    const live = runtime.module.getControlValues()
    for (const [k, v] of Object.entries(saved.controls)) {
      if (typeof v === 'number') expect(live[k], k).toBeCloseTo(v, 6)
      else expect(live[k], k).toBe(v)
    }
  })

  it('offers built-in presets that the live schema accepts', () => {
    if (isPlaceholder(runtime.module)) return
    for (const p of presetsFor(kind)) {
      runtime.setRobot(kind)
      const report = applyControlValues(p.controls, target)
      expect(report.rejected, `preset ${p.id}`).toEqual([])
      run(2)
    }
  })
})
