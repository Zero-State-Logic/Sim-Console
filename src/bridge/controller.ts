import { MAX_LINE_BYTES, PROTOCOL_VERSION } from '../core/protocol'
import type { AckMsg, CmdMsg, HelloMsg, TelMsg, TransportId } from '../core/protocol'
import type { HardwareConfig } from '../core/hardware'
import type { CommandLevel, HardwareSpec, RobotModule } from '../core/types'
import { describeConnectError } from './link/env'
import { RateLimiter, SeqCounter, encodeMsg, serializeCmd } from './link/outbound'
import { PingTracker, RateMeter, isStale } from './link/ping'
import { parseInbound } from './link/validate'
import type { LinkError, LinkErrorCode, LinkState, LinkStatus, LogDir, LogTag, RobotSuggestion, Transport } from './types'

/* ============================================================
   LINK CONTROLLER — the connection state machine. No DOM, no
   timers: the host calls pump(now) on an interval and tick() per
   frame, so tests drive it with a hand-held clock.

   connect → handshake (hello? every 1 s, 3 s deadline) → verify
   (robot kind + joint count vs the active module) → homing
   (home, 5 s for the ack) → live (cmd at commandHz) ⇄ estopped.
   ============================================================ */

export const HANDSHAKE_TIMEOUT_MS = 3000
export const HELLO_RETRY_MS = 1000
export const HOME_TIMEOUT_MS = 5000
/** Non-urgent status snapshots are published at most this often. */
export const PUBLISH_MS = 100
/** E-STOP is re-sent at this period until the board acks it (a lost line must not leave it running). */
export const ESTOP_RESEND_MS = 250
export const ESTOP_MAX_SENDS = 8
/**
 * A command gap longer than this fraction of the board's watchdogMs counts as a trip. With
 * watchdogAction 'relax' the firmware then drops to idle and refuses cmd until HOME.
 */
export const WATCHDOG_MARGIN = 0.8
const SYS_REPEAT_MS = 2000
/** Rate-limited sys keys kept before the map is reset (bounded against hostile 't' values). */
const SYS_KEYS_MAX = 128
const CMD_BYTES_ALPHA = 0.1

/** States in which the board's hello matched the module and telemetry is meaningful. */
const VERIFIED: ReadonlySet<LinkState> = new Set<LinkState>(['ready', 'homing', 'live', 'estopped'])

export interface ControllerDeps {
  now(): number
  getConfig(): HardwareConfig
  /** urgent = a state transition or flag flip (publish now); otherwise throttled by the controller. */
  onStatus(s: LinkStatus, urgent: boolean): void
  log(dir: LogDir, text: string, tag?: LogTag): void
  onCommandSent?(cmd: CmdMsg, now: number): void
  onTelemetry?(tel: TelMsg, now: number): void
}

const TRANSPORT_LABEL: Record<TransportId, string> = {
  serial: 'USB serial',
  ble: 'Bluetooth',
  ws: 'WiFi WebSocket',
  loopback: 'virtual device',
}

const HELLO_HINT: Record<TransportId, string> = {
  serial: 'Check that the baud rate matches the firmware, that kiyobridge firmware is flashed, and that the board finished booting (press reset, then RETRY).',
  ble: 'Check that the board runs the kiyobridge BLE firmware (Nordic UART service) and is close by.',
  ws: 'Check the board IP and that the firmware WebSocket server listens on port 81.',
  loopback: 'The virtual device did not answer. Disconnect and connect again.',
}

function describeRobot(r: { robot: string; joints: number; legs?: number; wheels?: number; drones?: number }): string {
  const extra = r.legs !== undefined ? `, ${r.legs} legs` : r.wheels !== undefined ? `, ${r.wheels} wheels` : r.drones !== undefined ? `, ${r.drones} drones` : ''
  return `${r.robot.toUpperCase()} (${r.joints} joints${extra})`
}

export class LinkController {
  private transport: Transport | null = null
  private unsubs: (() => void)[] = []
  private module: RobotModule | null = null
  private lastRevision = -1
  private state: LinkState = 'idle'
  private transportId: TransportId | null = null
  private hello: HelloMsg | null = null
  private error: LinkError | null = null
  private verifiedSpec: HardwareSpec | null = null
  private sourceActive = false
  private levelOverride: CommandLevel | null = null
  private handshakeStart = 0
  private lastHelloReq = 0
  private homeStart = 0
  private verifiedAt = 0
  private lastTelAt: number | null = null
  private latestTel: TelMsg | null = null
  private telFresh = false
  private stale = false
  private closing = false
  private connectToken = 0
  private cmdBytes = 0
  private cmdCount = 0
  private dropped = 0
  /** Last cmd written (or the LIVE entry), for the board-watchdog check on resume. */
  private lastCmdAt = 0
  /** E-STOP sent and not yet acked: re-sent from pump(). */
  private estopPending = false
  private estopSentAt = 0
  private estopSends = 0
  private lastPublish = -Infinity
  private override: ((now: number) => CmdMsg | null) | null = null
  private readonly sysAt = new Map<string, number>()
  private readonly ping = new PingTracker()
  private readonly rx = new RateMeter()
  private readonly tx = new RateMeter()
  private readonly limiter = new RateLimiter(50)
  private readonly seq = new SeqCounter()

  constructor(private readonly deps: ControllerDeps) {}

  /* ---------------- queries ---------------- */

  get linkState(): LinkState {
    return this.state
  }

  get connected(): boolean {
    return this.transport !== null && this.state !== 'connecting'
  }

  /** A transport is attached (also while still connecting). */
  get attached(): boolean {
    return this.transport !== null
  }

  /** Effective command level: the override, else the spec default for the transport class. */
  level(): CommandLevel {
    if (this.levelOverride) return this.levelOverride
    const spec = this.verifiedSpec ?? this.module?.getHardwareSpec() ?? null
    if (!spec) return 'joint'
    const wired = this.transportId === null || this.transportId === 'serial' || this.transportId === 'loopback'
    return wired ? spec.defaultLevel.wired : spec.defaultLevel.wireless
  }

  status(): LinkStatus {
    return {
      state: this.state,
      attached: this.transport !== null,
      transport: this.transportId,
      hello: this.hello,
      error: this.error,
      rttMs: this.ping.rtt,
      rxLinesPerSec: this.rx.perSec,
      txLinesPerSec: this.tx.perSec,
      rxBytesPerSec: this.rx.bytesPerSec,
      txBytesPerSec: this.tx.bytesPerSec,
      cmdBytes: this.cmdBytes,
      cmdCount: this.cmdCount,
      latestTel: this.latestTel,
      stale: this.stale,
      level: this.level(),
      levelOverride: this.levelOverride,
      sourceActive: this.sourceActive,
      droppedLines: this.dropped,
    }
  }

  /* ---------------- user actions ---------------- */

  attachModule(m: RobotModule): void {
    this.module = m
    this.lastRevision = m.revision
  }

  async connect(t: Transport): Promise<void> {
    if (this.transport) await this.disconnect()
    const token = ++this.connectToken
    this.resetSession()
    this.transport = t
    this.transportId = t.id
    this.unsubs = [t.onLine((l) => this.handleLine(l)), t.onState((s, d) => this.handleTransportState(s, d))]
    if (t.onDrop) this.unsubs.push(t.onDrop((b) => this.handleOversize(b)))
    this.setState('connecting')
    this.sys(`connecting via ${TRANSPORT_LABEL[t.id]}`)
    if (!t.isSupported()) {
      this.detach()
      this.fail('unsupported', `${TRANSPORT_LABEL[t.id]} is not available in this browser.`)
      return
    }
    try {
      await t.connect()
    } catch (e) {
      if (token !== this.connectToken) return
      const info = describeConnectError(e, t.id)
      this.detach()
      if (info.cancelled) {
        this.sys(info.message)
        this.setState('idle')
        return
      }
      this.fail('connect-failed', info.message, info.detail)
      return
    }
    if (token !== this.connectToken) {
      // cancelled while the port was opening: close what just opened
      t.disconnect().catch(() => undefined)
      return
    }
    this.sys(`port open (${TRANSPORT_LABEL[t.id]}), waiting for hello`)
    if (this.hello) this.verify(this.deps.now(), false)
    else this.beginHandshake(this.deps.now())
  }

  async disconnect(): Promise<void> {
    const t = this.transport
    this.connectToken++
    if (!t) {
      if (this.state !== 'idle') this.setState('idle')
      return
    }
    const wasLive = this.state === 'live'
    this.closing = true
    this.detach()
    try {
      await t.disconnect()
    } catch {
      /* closing a dead port can throw; the link is gone either way */
    }
    this.closing = false
    this.resetSession()
    this.sys(wasLive ? 'disconnected while live: the board watchdog takes over (hold or relax)' : 'disconnected')
    this.setState('idle')
  }

  /** HOME: allowed once verified (also to re-arm after E-STOP or retry a failed home). */
  home(): boolean {
    if (!this.transport || !this.verifiedSpec) return false
    if (this.state === 'error' && this.error?.code !== 'home-timeout' && this.error?.code !== 'home-failed') return false
    this.error = null
    this.startHoming(this.deps.now())
    return true
  }

  /** Always allowed while a port is open (also when latched: pressing again re-sends it). */
  estop(): void {
    if (!this.transport || this.state === 'connecting') return
    const now = this.deps.now()
    this.estopPending = true
    this.estopSends = 0
    this.sendEstop(now)
    this.sys('E-STOP sent: streaming stopped, HOME to re-arm', 'err')
    this.error = null
    this.setState('estopped')
  }

  /** True when RETRY makes sense: an error with the link open, or an E-STOP before verification. */
  get canRetry(): boolean {
    return this.transport !== null && (this.state === 'error' || (this.state === 'estopped' && !this.verifiedSpec))
  }

  /** RETRY from an error with the link still open. */
  retry(): void {
    if (!this.canRetry) return
    const code = this.error?.code
    this.error = null
    if ((code === 'home-timeout' || code === 'home-failed') && this.verifiedSpec) this.startHoming(this.deps.now())
    else {
      this.hello = null
      this.beginHandshake(this.deps.now())
    }
  }

  /**
   * Replace the module's commands while LIVE (calibration step sweep). The source returns
   * null when done, which hands control back to the module. Cleared by E-STOP and link loss.
   */
  setCommandOverride(source: ((now: number) => CmdMsg | null) | null): void {
    this.override = source
  }

  get overriding(): boolean {
    return this.override !== null
  }

  setLevelOverride(level: CommandLevel | null): void {
    this.levelOverride = level
    this.publish(true)
  }

  /** A pre-validated line from the serial monitor. */
  sendRaw(line: string): boolean {
    if (!this.transport || this.state === 'connecting') return false
    return this.writeLine(line, true)
  }

  /* ---------------- runtime hooks ---------------- */

  sourceEnter(m: RobotModule): void {
    this.sourceActive = true
    this.module = m
    if (this.checkSpec(m)) return
    if (this.state === 'ready') this.startHoming(this.deps.now())
    else this.publish(true)
  }

  sourceExit(): void {
    this.sourceActive = false
    // stop streaming and park the robot; E-STOP stays latched until the user homes
    if (this.state === 'live') this.startHoming(this.deps.now())
    else this.publish(true)
  }

  robotChanged(m: RobotModule): void {
    this.attachModule(m)
    if (!this.transport || this.state === 'connecting') return
    if (this.transport.reflash) {
      this.verifiedSpec = null
      this.hello = null
      this.transport.reflash()
      this.sys('virtual device re-flashed for the new robot')
      this.beginHandshake(this.deps.now())
      return
    }
    if (this.hello) {
      if (this.state === 'live' || this.state === 'homing') this.sys('robot changed: streaming stopped, re-verifying', 'warn')
      this.verify(this.deps.now(), this.state === 'estopped')
    }
  }

  /** Timeouts, retries, pings, stale detection, rate meters. Call often (~20 Hz). */
  pump(now: number): void {
    if (!this.transport) return
    if (this.state === 'handshake') this.pumpHandshake(now)
    else if (this.state === 'homing' && now - this.homeStart >= HOME_TIMEOUT_MS) {
      this.fail('home-timeout', 'The board did not confirm HOME within 5 s.', 'Check servo power and the firmware log, then RETRY.')
    } else if (this.state === 'estopped') this.pumpEstop(now)
    if (this.hello && this.state !== 'connecting' && this.ping.due(now)) {
      this.writeLine(encodeMsg({ t: 'ping', id: this.ping.issue(now) }), false)
    }
    if (VERIFIED.has(this.state)) {
      const st = isStale(now, this.lastTelAt, this.verifiedAt)
      if (st !== this.stale) {
        this.stale = st
        if (st) this.sysOnce('stale', 'telemetry STALE: nothing received for 500 ms', 'warn')
        this.publish(true)
      }
    } else if (this.stale) {
      this.stale = false
      this.publish(true)
    }
    this.rx.update(now)
    this.tx.update(now)
    this.publish(false)
  }

  /**
   * The module may have been replaced or reshaped (leg count) since the last look.
   * Re-verifies when its spec no longer matches the board. Returns true if it acted.
   */
  syncModule(m: RobotModule): boolean {
    if (m === this.module && m.revision === this.lastRevision) return false
    this.module = m
    this.lastRevision = m.revision
    return this.checkSpec(m)
  }

  /** Per frame while the drive source is HARDWARE. */
  tick(m: RobotModule, dt: number, now: number): void {
    if (this.syncModule(m)) return
    this.pump(now)
    if (this.telFresh && this.latestTel && VERIFIED.has(this.state)) {
      this.telFresh = false
      m.applyTelemetry(this.latestTel)
    }
    if (this.state !== 'live' || dt <= 0 || !this.transport) return
    if (this.boardRelaxed(now)) {
      this.sys('commands paused longer than the board watchdog (relax): re-homing before streaming', 'warn')
      this.startHoming(now)
      return
    }
    const hz = this.deps.getConfig().commandHz
    if (1000 / Math.max(hz, 0.001) !== this.limiter.period) this.limiter.setHz(hz)
    if (!this.limiter.ready(now)) return
    this.sendCommand(m, now)
  }

  /* ---------------- internals ---------------- */

  /**
   * The firmware arms its watchdog at HOME and feeds it with every cmd. After a gap past
   * watchdogMs with action 'relax' it has gone limp and refuses cmd until HOME, so streaming
   * on would be silently ignored (a pause, or a background tab with no frames).
   */
  private boardRelaxed(now: number): boolean {
    const cfg = this.deps.getConfig()
    return cfg.watchdogAction === 'relax' && now - this.lastCmdAt > cfg.watchdogMs * WATCHDOG_MARGIN
  }

  private sendEstop(now: number): void {
    this.estopSentAt = now
    this.estopSends++
    this.writeLine(encodeMsg({ t: 'estop' }), true)
  }

  /** Re-send an unconfirmed E-STOP; give up loudly after ESTOP_MAX_SENDS. */
  private pumpEstop(now: number): void {
    if (!this.estopPending || now - this.estopSentAt < ESTOP_RESEND_MS) return
    if (this.estopSends < ESTOP_MAX_SENDS) {
      this.sendEstop(now)
      return
    }
    this.estopPending = false
    this.sys(`the board never confirmed E-STOP (${ESTOP_MAX_SENDS} tries): check the robot and cut its power if it still moves`, 'err')
  }

  private sendCommand(m: RobotModule, now: number): void {
    let cmd = this.override ? this.override(now) : null
    if (!cmd) {
      this.override = null
      cmd = m.buildCommand(this.level())
    }
    const r = serializeCmd(cmd, this.seq.next())
    if (!r.ok) {
      this.sysOnce('nonfinite', `cmd dropped: ${r.reason} (module bug)`, 'err')
      return
    }
    if (!this.writeLine(r.line, false)) return
    this.lastCmdAt = now
    this.cmdCount++
    const bytes = r.line.length + 1
    this.cmdBytes = this.cmdBytes === 0 ? bytes : this.cmdBytes + CMD_BYTES_ALPHA * (bytes - this.cmdBytes)
    this.deps.onCommandSent?.(cmd, now)
  }

  /** The module's spec changed shape (leg count) while connected: re-verify. Returns true if it acted. */
  private checkSpec(m: RobotModule): boolean {
    if (!this.transport) return false
    const ref = this.verifiedSpec
    if (ref) {
      const spec = m.getHardwareSpec()
      if (spec.robot === ref.robot && spec.joints === ref.joints) return false
      this.robotChanged(m)
      return true
    }
    // after a mismatch the user may have reshaped the robot (e.g. leg count) to match the board
    if (this.state === 'error' && this.error?.code === 'mismatch' && this.hello) {
      this.verify(this.deps.now(), false)
      return true
    }
    return false
  }

  private pumpHandshake(now: number): void {
    if (now - this.handshakeStart >= HANDSHAKE_TIMEOUT_MS) {
      this.fail('hello-timeout', 'No hello from the board within 3 s.', HELLO_HINT[this.transportId ?? 'serial'])
      return
    }
    if (now - this.lastHelloReq >= HELLO_RETRY_MS) {
      this.lastHelloReq = now
      this.writeLine(encodeMsg({ t: 'hello?' }), true)
    }
  }

  private beginHandshake(now: number): void {
    this.handshakeStart = now
    this.lastHelloReq = now
    this.setState('handshake')
    this.writeLine(encodeMsg({ t: 'hello?' }), true)
  }

  private startHoming(now: number): void {
    this.homeStart = now
    this.setState('homing')
    this.writeLine(encodeMsg({ t: 'home' }), true)
    this.sys('homing: waiting for the board to reach its safe pose')
  }

  private verify(now: number, keepEstop: boolean): void {
    const h = this.hello
    const spec = this.module?.getHardwareSpec() ?? null
    if (!h || !spec) return
    this.setState('verify')
    if (h.proto !== PROTOCOL_VERSION) {
      this.fail('proto', `Firmware speaks protocol v${h.proto}; this app speaks v${PROTOCOL_VERSION}.`, 'Regenerate the firmware with GENERATE FIRMWARE and flash it again.')
      return
    }
    if (h.robot !== spec.robot || h.joints !== spec.joints) {
      const suggest: RobotSuggestion = { robot: h.robot, joints: h.joints, legs: h.legs, wheels: h.wheels, drones: h.drones }
      this.fail(
        'mismatch',
        `Board is a ${describeRobot(h)}; the active robot is a ${describeRobot(spec)}.`,
        'Switch the robot to match the board, or flash firmware generated for the active robot.',
        suggest,
      )
      return
    }
    this.verifiedSpec = spec
    this.verifiedAt = now
    this.error = null
    this.sys(`verified ${describeRobot(h)} on ${h.board}${h.fw ? `, fw ${h.fw}` : ''}`)
    this.limiter.setHz(this.deps.getConfig().commandHz)
    if (keepEstop) this.setState('estopped')
    else if (this.sourceActive) this.startHoming(now)
    else this.setState('ready')
  }

  private handleLine(line: string): void {
    const now = this.deps.now()
    this.rx.add(line.length + 1, now)
    const r = parseInbound(line)
    if (!r.ok) {
      this.deps.log('rx', line, 'invalid')
      if (r.kind === 'invalid') {
        this.dropped++
        this.sysOnce(`bad-${r.t}`, `dropped '${r.t}': ${r.reason}`, 'warn')
      } else if (r.kind === 'unknown') this.sysOnce(`unk-${r.t}`, `unknown message type '${r.t}'`, 'warn')
      return
    }
    const msg = r.msg
    const tag = msg.t === 'log' && msg.lvl !== 'info' ? msg.lvl : undefined
    this.deps.log('rx', line, tag)
    switch (msg.t) {
      case 'hello':
        return this.onHello(msg, now)
      case 'tel':
        return this.onTel(msg, now)
      case 'ack':
        return this.onAck(msg)
      case 'pong':
        this.ping.resolve(msg.id, now)
        return
      case 'log':
        return
    }
  }

  /** The framer discarded an over-long line (garbage at the wrong baud, or a firmware bug). */
  private handleOversize(bytes: number): void {
    this.dropped++
    this.sysOnce('oversize', `dropped a ${bytes}-byte line (protocol limit ${MAX_LINE_BYTES} bytes): check the baud rate`, 'warn')
    this.publish(false)
  }

  private onHello(msg: HelloMsg, now: number): void {
    const prev = this.state
    this.hello = msg
    if (prev === 'connecting' || prev === 'idle' || prev === 'disconnected') return
    if (prev === 'live' || prev === 'homing') this.sys('board re-announced itself (reset?): streaming stopped, re-verifying', 'warn')
    this.verify(now, prev === 'estopped')
  }

  private onTel(msg: TelMsg, now: number): void {
    this.latestTel = msg
    this.lastTelAt = now
    this.telFresh = true
    if (this.stale && VERIFIED.has(this.state)) {
      this.stale = false
      this.publish(true)
    }
    this.deps.onTelemetry?.(msg, now)
  }

  private onAck(msg: AckMsg): void {
    if (msg.of === 'estop') {
      if (this.estopPending) this.sys('board confirmed E-STOP')
      this.estopPending = false
      return
    }
    if (msg.of !== 'home' || this.state !== 'homing') return
    if (!msg.ok) {
      this.fail('home-failed', `The board refused HOME${msg.msg ? `: ${msg.msg}` : ''}.`, 'Wait for it to finish booting, then RETRY.')
      return
    }
    this.limiter.reset()
    // the board's watchdog starts counting now
    this.lastCmdAt = this.deps.now()
    this.cmdCount = 0
    this.sys(this.sourceActive ? 'home confirmed: LIVE' : 'home confirmed: ready (switch to HARDWARE to stream)')
    this.setState(this.sourceActive ? 'live' : 'ready')
  }

  private handleTransportState(s: 'open' | 'closed' | 'error', detail?: string): void {
    if (s === 'open' || this.closing || !this.transport) return
    this.detach()
    this.hello = null
    this.verifiedSpec = null
    this.error = {
      code: 'transport-lost',
      message: 'Link lost.',
      detail: detail ?? 'The board disconnected (cable, power or range). Its watchdog holds or relaxes the servos.',
    }
    this.sys(`link lost${detail ? `: ${detail}` : ''}`, 'err')
    this.setState('disconnected')
  }

  private fail(code: LinkErrorCode, message: string, detail?: string, suggest?: RobotSuggestion): void {
    this.error = suggest ? { code, message, detail, suggest } : { code, message, detail }
    this.sys(message, 'err')
    this.setState('error')
  }

  private writeLine(line: string, critical: boolean): boolean {
    const t = this.transport
    if (!t) return false
    if (!t.write(line, critical)) {
      this.sysOnce('backlog', 'tx backlog: line dropped (link slower than the command rate)', 'warn')
      return false
    }
    const now = this.deps.now()
    this.tx.add(line.length + 1, now)
    this.deps.log('tx', line)
    return true
  }

  private detach(): void {
    for (const u of this.unsubs) u()
    this.unsubs = []
    this.transport = null
  }

  private resetSession(): void {
    this.hello = null
    this.error = null
    this.verifiedSpec = null
    this.latestTel = null
    this.lastTelAt = null
    this.telFresh = false
    this.stale = false
    this.cmdBytes = 0
    this.cmdCount = 0
    this.dropped = 0
    this.estopPending = false
    this.ping.reset()
    this.rx.reset()
    this.tx.reset()
    this.limiter.reset()
    this.seq.reset()
    this.sysAt.clear()
  }

  private setState(s: LinkState): void {
    if (s === this.state) return
    this.state = s
    // anything that stops streaming also ends a calibration sweep
    if (s !== 'live') this.override = null
    this.publish(true)
  }

  private publish(urgent: boolean): void {
    const now = this.deps.now()
    if (!urgent && now - this.lastPublish < PUBLISH_MS) return
    this.lastPublish = now
    this.deps.onStatus(this.status(), urgent)
  }

  private sys(text: string, tag?: LogTag): void {
    this.deps.log('sys', text, tag)
  }

  private sysOnce(key: string, text: string, tag?: LogTag): void {
    const now = this.deps.now()
    const last = this.sysAt.get(key)
    if (last !== undefined && now - last < SYS_REPEAT_MS) return
    // keys embed the untrusted 't' of bad lines: a hostile stream must not grow the map forever
    if (last === undefined && this.sysAt.size >= SYS_KEYS_MAX) this.sysAt.clear()
    this.sysAt.set(key, now)
    this.sys(text, tag)
  }
}
