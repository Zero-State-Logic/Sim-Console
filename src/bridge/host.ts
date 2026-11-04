import type { HardwareConfig } from '../core/hardware'
import type { TransportId } from '../core/protocol'
import type { CommandLevel, RobotModule } from '../core/types'
import { CalibrationSession } from './calib/session'
import type { SweepPlan } from './calib/sweep'
import { LinkController } from './controller'
import type { BridgeApi } from './index'
import type { LogRing } from './link/logRing'
import { validateOutboundLine } from './link/outbound'
import type { BridgeState } from './store'
import type { TransportContext } from './transports'
import type { Transport } from './types'

/* ============================================================
   BRIDGE HOST — glues the pure pieces to the app: the link
   controller, the calibration session, the transports, the
   zustand store and a 20 Hz pump timer (handshake timeouts,
   pings and stale detection must run while the drive source is
   not HARDWARE too). Every side effect comes in through HostDeps,
   so the whole flow runs in Node tests with fake timers.
   ============================================================ */

export const PUMP_MS = 50
/** The serial monitor re-reads the log ring at most this often. */
export const LOG_PUBLISH_MS = 100
/** Pings typed into the monitor use ids far from the controller's own. */
const MONITOR_PING_BASE = 900_000

export interface HostDeps {
  now(): number
  /** Start a repeating timer; returns its stop function. */
  startTimer(fn: () => void, ms: number): () => void
  getConfig(): HardwareConfig
  setConfig(patch: Partial<HardwareConfig>): void
  publish(patch: Partial<BridgeState>): void
  log: LogRing
  makeTransport(id: TransportId, ctx: TransportContext): Transport
  /** Initial value of the virtual device's hidden mounting error. */
  miscalibrate: boolean
}

export interface SendResult {
  ok: boolean
  message: string
}

export class BridgeHost implements BridgeApi {
  readonly link: LinkController
  readonly calib: CalibrationSession
  private module: RobotModule | null = null
  private stopTimer: (() => void) | null = null
  private logVersion = -1
  private lastLogPublish = -Infinity
  private miscal: boolean
  private monitorPing = MONITOR_PING_BASE

  constructor(private readonly deps: HostDeps) {
    this.miscal = deps.miscalibrate
    this.link = new LinkController({
      now: deps.now,
      getConfig: deps.getConfig,
      onStatus: (s) => deps.publish({ ...s, canRetry: this.link.canRetry }),
      log: (dir, text, tag) => deps.log.push(deps.now(), dir, text, tag),
      onCommandSent: (cmd, now) => this.calib.onCommand(cmd, now),
      onTelemetry: (tel, now) => this.calib.onTelemetry(tel, now),
    })
    this.calib = new CalibrationSession({
      now: deps.now,
      spec: () => this.module?.getHardwareSpec() ?? null,
      config: deps.getConfig,
      setConfig: deps.setConfig,
      link: this.link,
      publish: (ui) => deps.publish({ calib: ui }),
    })
  }

  /* ---------------- BridgeApi (runtime hooks) ---------------- */

  tick(module: RobotModule, dt: number, _t: number): void {
    this.module = module
    this.link.tick(module, dt, this.deps.now())
  }

  onSourceEnter(module: RobotModule): void {
    this.module = module
    this.link.sourceEnter(module)
    this.flushLog(true)
  }

  onSourceExit(_module: RobotModule): void {
    this.calib.stopSweep()
    this.link.sourceExit()
    this.flushLog(true)
  }

  onRobotChange(module: RobotModule): void {
    this.module = module
    this.calib.clear()
    this.link.robotChanged(module)
    this.flushLog(true)
  }

  /* ---------------- user actions ---------------- */

  /** Connect with the transport selected in the hardware profile. */
  async connect(module: RobotModule): Promise<void> {
    this.module = module
    this.link.attachModule(module)
    const ctx: TransportContext = {
      config: this.deps.getConfig,
      spec: () => (this.module ?? module).getHardwareSpec(),
      miscalibrate: this.miscal,
    }
    const transport = this.deps.makeTransport(this.deps.getConfig().transport, ctx)
    this.ensureTimer()
    try {
      await this.link.connect(transport)
    } finally {
      this.afterAction()
    }
  }

  async disconnect(): Promise<void> {
    this.calib.clear()
    await this.link.disconnect()
    this.afterAction()
  }

  home(): boolean {
    const ok = this.link.home()
    this.afterAction()
    return ok
  }

  estop(): void {
    this.calib.stopSweep()
    this.link.estop()
    this.afterAction()
  }

  retry(): void {
    this.link.retry()
    this.afterAction()
  }

  setLevelOverride(level: CommandLevel | null): void {
    this.link.setLevelOverride(level)
  }

  /**
   * A line typed into the serial monitor. It must be one JSON object with a string t.
   * home / estop / ping go through the state machine so the UI and the board agree.
   */
  sendLine(text: string): SendResult {
    const r = validateOutboundLine(text)
    if (!r.ok) return { ok: false, message: r.reason }
    if (!this.link.attached) return { ok: false, message: 'not connected' }
    const t = (JSON.parse(r.line) as { t: string }).t
    let sent: boolean
    if (t === 'estop') {
      this.estop()
      sent = true
    } else if (t === 'home') sent = this.home()
    else if (t === 'ping') sent = this.link.sendRaw(JSON.stringify({ t: 'ping', id: this.monitorPing++ }))
    else sent = this.link.sendRaw(r.line)
    this.flushLog(true)
    if (!sent) return { ok: false, message: t === 'home' ? 'HOME needs a verified board' : 'link busy, line not sent' }
    return { ok: true, message: r.known ? 'sent' : `sent ('${t}' is not a protocol v1 message)` }
  }

  clearLog(): void {
    this.deps.log.clear()
    this.flushLog(true)
  }

  exportLog(): string {
    return this.deps.log.toNdjson()
  }

  get miscalibrate(): boolean {
    return this.miscal
  }

  /** Virtual device only; takes effect on the next connect (the board is "built" then). */
  setMiscalibrate(on: boolean): void {
    this.miscal = on
    this.deps.publish({ miscalibrate: on })
  }

  /* ---------------- calibration ---------------- */

  calibBlocker(): string | null {
    return this.calib.blocker()
  }

  calibRecord(): void {
    this.calib.startRecording()
  }

  calibStop(): void {
    this.calib.stopRecording()
  }

  calibSweep(plan?: SweepPlan): void {
    this.calib.startSweep(plan)
  }

  calibStopSweep(): void {
    this.calib.stopSweep()
  }

  calibFit(): void {
    this.calib.fit()
  }

  calibApply(): void {
    this.calib.apply()
  }

  calibReset(): void {
    this.calib.reset()
  }

  /* ---------------- internals ---------------- */

  private afterAction(): void {
    this.flushLog(true)
    if (this.link.attached) this.ensureTimer()
  }

  private ensureTimer(): void {
    if (this.stopTimer) return
    this.stopTimer = this.deps.startTimer(() => this.pump(), PUMP_MS)
  }

  private pump(): void {
    const now = this.deps.now()
    if (this.module) this.link.syncModule(this.module)
    this.link.pump(now)
    this.calib.update(now)
    if (this.link.attached) {
      this.flushLog(false)
      return
    }
    // link gone (error, drop, disconnect): stop polling until the next connect
    this.stopTimer?.()
    this.stopTimer = null
    this.flushLog(true)
  }

  private flushLog(force: boolean): void {
    const v = this.deps.log.version
    if (v === this.logVersion) return
    const now = this.deps.now()
    if (!force && now - this.lastLogPublish < LOG_PUBLISH_MS) return
    this.logVersion = v
    this.lastLogPublish = now
    this.deps.publish({ logRev: v })
  }
}
