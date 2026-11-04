import type { HardwareConfig } from '../../core/hardware'
import type { CmdMsg, TelMsg } from '../../core/protocol'
import type { CommandLevel, HardwareSpec } from '../../core/types'
import type { CalibUi } from '../store'
import type { LinkState } from '../types'
import { calibrate, calibrationPatch, identityCalibration, type CalibrationResult } from './fit'
import { CalibrationRecorder } from './recorder'
import { SWEEP_DEFAULT, sweepDurationMs, sweepTargets, type SweepPlan } from './sweep'

/* ============================================================
   CALIBRATION SESSION — the CALIBRATION tab's workflow:
   RECORD (passive, while the user drives) or STEP SWEEP (active,
   robot on a stand), then FIT, APPLY or RESET. Pure: the host
   passes the link, the config store and a clock.
   ============================================================ */

export interface CalibLink {
  readonly linkState: LinkState
  readonly overriding: boolean
  level(): CommandLevel
  setCommandOverride(source: ((now: number) => CmdMsg | null) | null): void
}

export interface CalibHost {
  now(): number
  spec(): HardwareSpec | null
  config(): HardwareConfig
  setConfig(patch: Partial<HardwareConfig>): void
  link: CalibLink
  publish(ui: CalibUi): void
}

const PUBLISH_MS = 250

export class CalibrationSession {
  private readonly rec = new CalibrationRecorder()
  private sweep: { start: number; spec: HardwareSpec; q: number[]; plan: SweepPlan } | null = null
  private result: CalibrationResult | null = null
  private message: string | null = null
  private lastPublish = -Infinity

  constructor(private readonly host: CalibHost) {}

  /** Why recording cannot start right now, or null when it can. */
  blocker(): string | null {
    const spec = this.host.spec()
    if (this.host.link.linkState !== 'live') return 'Calibration needs a LIVE link: connect and go to HARDWARE.'
    if (!spec || spec.robot !== 'walker') return 'Calibration fits servo joint angles, so it applies to the WALKER.'
    if (this.host.link.level() !== 'joint') return 'Switch the command level to JOINT: calibration compares joint angles.'
    return null
  }

  startRecording(): void {
    const why = this.blocker()
    if (why) return this.say(why)
    const spec = this.host.spec() as HardwareSpec
    this.rec.start(spec.joints, this.host.config())
    this.result = null
    this.say('Recording: drive the robot through a wide range of poses, or hold poses for a second each.')
  }

  stopRecording(): void {
    this.rec.stop()
    this.say(`Stopped: ${this.rec.telSamples} measured samples over ${this.rec.durationSec.toFixed(1)} s.`)
  }

  startSweep(plan: SweepPlan = SWEEP_DEFAULT): void {
    const why = this.blocker()
    if (why) return this.say(why)
    const spec = this.host.spec() as HardwareSpec
    this.rec.start(spec.joints, this.host.config())
    this.result = null
    this.sweep = { start: this.host.now(), spec, q: [], plan }
    this.host.link.setCommandOverride((now) => this.sweepCommand(now))
    this.say(`Step sweep: every joint steps ±${plan.amplitudeDeg}° around home for ${(sweepDurationMs(plan) / 1000).toFixed(0)} s.`)
  }

  stopSweep(): void {
    if (!this.sweep) return
    this.sweep = null
    this.host.link.setCommandOverride(null)
    this.rec.stop()
    this.say('Sweep stopped early; FIT uses what was recorded.')
  }

  fit(): void {
    const spec = this.host.spec()
    const { cmd, tel } = this.rec.data()
    if (!this.rec.mapping || !spec) return this.say('Nothing recorded yet.')
    this.rec.stop()
    this.result = calibrate(cmd, tel, this.rec.mapping, spec.jointNames)
    if (!this.result.ok) return this.say(`Fit failed: ${this.result.reason}.`)
    const dyn = this.result.joints.filter((j) => j.source === 'dynamic').length
    const bad = this.result.joints.filter((j) => j.suspect).length
    const notes = [
      dyn > 0 ? `${dyn} joint(s) fitted from moving data (servo lag can read the gain low; a STEP SWEEP is more accurate)` : '',
      bad > 0 ? `${bad} joint(s) look miswired or inverted and are left out` : '',
    ].filter(Boolean)
    this.say(notes.length ? `Fitted. ${notes.join('; ')}.` : 'Fitted from settled data. Review, then APPLY.')
  }

  apply(): void {
    const r = this.result
    const spec = this.host.spec()
    if (!r || !r.ok || !spec) return this.say('Run FIT first.')
    this.host.setConfig(calibrationPatch(this.host.config(), r, spec.joints))
    this.rec.clear()
    this.result = null
    this.say(
      'Applied to the hardware profile. The virtual device uses it at once; a real board has the mapping compiled in, so GENERATE FIRMWARE and flash it again. Then record again to check the residual.',
    )
  }

  reset(): void {
    const spec = this.host.spec()
    if (!spec) return
    this.stopSweep()
    this.host.setConfig(identityCalibration(spec.joints))
    this.rec.clear()
    this.result = null
    this.say('Calibration reset: scale 1, offset 0 on every joint.')
  }

  /** Robot changed or link dropped: drop the take. */
  clear(): void {
    if (this.sweep) this.host.link.setCommandOverride(null)
    this.sweep = null
    this.rec.clear()
    this.result = null
    this.message = null
    this.publish(true)
  }

  onCommand(cmd: CmdMsg, now: number): void {
    if (this.rec.recording && cmd.q) this.rec.addCommand(now, cmd.q)
  }

  onTelemetry(tel: TelMsg, now: number): void {
    if (this.rec.recording && tel.ang) this.rec.addMeasured(now, tel.ang)
  }

  /** Call often: detects a sweep cut short by E-STOP / link loss and publishes progress. */
  update(now: number): void {
    if (this.sweep && !this.host.link.overriding) {
      this.sweep = null
      this.rec.stop()
      this.say('Sweep interrupted (the link left LIVE).')
      return
    }
    if (this.rec.full && this.message?.startsWith('Recording')) this.say('Recording buffer full: stopped. FIT when ready.')
    if (now - this.lastPublish >= PUBLISH_MS) this.publish(false)
  }

  ui(): CalibUi {
    const s = this.sweep
    return {
      recording: this.rec.recording,
      full: this.rec.full,
      cmdSamples: this.rec.cmdSamples,
      telSamples: this.rec.telSamples,
      durationSec: this.rec.durationSec,
      sweeping: s !== null,
      sweepProgress: s ? Math.min(1, (this.host.now() - s.start) / sweepDurationMs(s.plan)) : 0,
      result: this.result,
      message: this.message,
    }
  }

  private sweepCommand(now: number): CmdMsg | null {
    const s = this.sweep
    if (!s) return null
    if (sweepTargets(s.spec, s.plan, now - s.start, s.q)) return { t: 'cmd', q: s.q }
    // done: hand control back to the module and fit straight away
    this.sweep = null
    this.fit()
    return null
  }

  private say(msg: string): void {
    this.message = msg
    this.publish(true)
  }

  private publish(force: boolean): void {
    const now = this.host.now()
    if (!force && now - this.lastPublish < PUBLISH_MS) return
    this.lastPublish = now
    this.host.publish(this.ui())
  }
}
