import { useConsole } from '../store'
import { bridge } from '../bridge'
import { sandbox } from '../sandbox'
import { getRobotEntry } from '../robots'
import { recorder } from './recorder'
import { telemetryBus, EMPTY_FRAME } from './telemetryBus'
import { useHardware } from './hardware'
import { FramePacer } from './framePacer'
import type { ControlValue, DriveSource, PointerEvt, RobotKind, RobotModule } from './types'

/** Largest frame step fed to modules; longer stalls (tab switch) are clamped. */
const MAX_FRAME_DT = 0.05

type ModuleListener = (m: RobotModule) => void

/*
 * The runtime owns the active robot module and routes the drive source every frame.
 * UI never calls module methods with side effects directly — it calls the runtime,
 * which keeps the store, bridge, sandbox and recorder consistent.
 */
class Runtime {
  private current: RobotModule | null = null
  private lastRevision = -1
  private listeners = new Set<ModuleListener>()
  /** Evens out rAF timing jitter so every frame advances the robot by the same step. */
  private readonly pacer = new FramePacer()
  /** Accumulated sim time, seconds. */
  t = 0

  get module(): RobotModule {
    if (!this.current) this.setRobot(useConsole.getState().robot)
    return this.current as RobotModule
  }

  /** Subscribe to module replacement (the viewport remounts the scene root). */
  onModuleChange(fn: ModuleListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  setRobot(kind: RobotKind): void {
    const prev = this.current
    const source = useConsole.getState().driveSource
    if (prev) {
      this.exitSource(source, prev)
      prev.dispose()
    }
    const next = getRobotEntry(kind).create()
    this.current = next
    this.t = 0
    this.pacer.resetDebt()
    this.lastRevision = next.revision
    recorder.clear()
    telemetryBus.current = EMPTY_FRAME
    useHardware.getState().syncToSpec(next.getHardwareSpec())
    bridge.onRobotChange(next)
    sandbox.onRobotChange(next)
    const preset = next.world.cameraPresets[0]?.id ?? 'iso'
    useConsole.setState((st) => ({
      robot: kind,
      cameraPreset: preset,
      controlRev: st.controlRev + 1,
      layoutRev: st.layoutRev + 1,
    }))
    if (prev) this.enterSource(source, next)
    for (const fn of this.listeners) fn(next)
  }

  setDriveSource(source: DriveSource): void {
    const st = useConsole.getState()
    if (st.driveSource === source) return
    const m = this.module
    this.exitSource(st.driveSource, m)
    useConsole.setState({ driveSource: source, drawerOpen: source !== 'sim' })
    this.enterSource(source, m)
  }

  setControl(key: string, value: ControlValue): void {
    this.module.setControl(key, value)
    this.syncRevision()
    useConsole.setState((st) => ({ controlRev: st.controlRev + 1 }))
  }

  reset(): void {
    this.module.reset()
    this.t = 0
    recorder.clear()
    useConsole.setState((st) => ({ controlRev: st.controlRev + 1 }))
  }

  /** Called once per rendered frame by the viewport. */
  frame(dt: number): void {
    const m = this.module
    if (recorder.isReplaying()) {
      const tel = recorder.applyReplayFrame(m)
      if (tel) telemetryBus.current = tel
      return
    }
    const st = useConsole.getState()
    let step = 0
    if (st.playing) {
      step = Math.min(this.pacer.next(dt), MAX_FRAME_DT) * st.timeScale
    } else {
      this.pacer.observe(dt)
      this.pacer.resetDebt()
    }
    this.t += step
    if (st.driveSource === 'code') sandbox.tick(m, step, this.t)
    else if (st.driveSource === 'hardware') bridge.tick(m, step, this.t)
    m.update(step, { source: st.driveSource, t: this.t })
    this.syncRevision()
    const tel = m.getTelemetry()
    telemetryBus.current = tel
    if (step > 0) recorder.capture(this.t, m, tel)
  }

  pointer(e: PointerEvt): boolean {
    const consumed = this.module.onPointer?.(e) ?? false
    if (consumed) this.syncRevision()
    return consumed
  }

  private syncRevision(): void {
    const m = this.current
    if (!m || m.revision === this.lastRevision) return
    this.lastRevision = m.revision
    useConsole.setState((st) => ({ layoutRev: st.layoutRev + 1, controlRev: st.controlRev + 1 }))
  }

  private enterSource(source: DriveSource, m: RobotModule): void {
    if (source === 'hardware') bridge.onSourceEnter(m)
    else if (source === 'code') sandbox.onSourceEnter(m)
  }

  private exitSource(source: DriveSource, m: RobotModule): void {
    if (source === 'hardware') bridge.onSourceExit(m)
    else if (source === 'code') sandbox.onSourceExit(m)
  }
}

export const runtime = new Runtime()
