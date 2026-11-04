import { PROTOCOL_VERSION } from '../../core/protocol'
import type { CmdMsg, DroneSetpoint, HelloMsg, TelMsg } from '../../core/protocol'
import type { HardwareConfig } from '../../core/hardware'
import type { HardwareSpec } from '../../core/types'
import { createBody, type DriveMode, type VirtualBody } from './bodies'
import { createRng, type Rng } from './random'

/* ============================================================
   VIRTUAL DEVICE — an in-browser emulation of the generated
   kiyobridge firmware, so the whole hardware flow (hello, verify,
   home, live, E-STOP, watchdog, calibration) can be demoed online
   with no board. Pure: the loopback transport drives step() from
   a timer and carries the lines with a little latency.
   ============================================================ */

export const VIRTUAL_FW = 'kiyobridge-1.0-virtual'
export const BOOT_MS = 300
export const HOME_MS = 800
const SUBSTEP_MS = 10
const WARN_REPEAT_MS = 1000
const MAX_TEL_HZ = 200
const MAX_IN_VALUES = 64
const MAX_MODE_CHARS = 32

export type DevicePhase = 'boot' | 'idle' | 'homing' | 'ready' | 'estopped'

export interface VirtualDeviceOptions {
  spec: HardwareSpec
  /** Read every step, so calibration and watchdog edits apply live (like re-flashing settings). */
  getConfig: () => HardwareConfig
  /** One outgoing NDJSON line, no trailing newline. */
  emit: (line: string) => void
  seed?: number
  /** Give the virtual servos a hidden mounting error for the calibration tab to find. */
  miscalibrate?: boolean
  bootMs?: number
}

type Obj = Record<string, unknown>

function own(o: Obj, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined
}

function finiteArray(v: unknown, max: number): number[] | null {
  if (!Array.isArray(v) || v.length > max) return null
  for (const x of v) if (typeof x !== 'number' || !Number.isFinite(x)) return null
  return v as number[]
}

/** Firmware-side cmd parsing: only well-typed fields survive. */
function readCmd(o: Obj): CmdMsg | null {
  const cmd: CmdMsg = { t: 'cmd' }
  const q = own(o, 'q')
  const v = own(o, 'v')
  const w = own(o, 'w')
  const sp = own(o, 'sp')
  if (q !== undefined) cmd.q = finiteArray(q, MAX_IN_VALUES) ?? undefined
  if (w !== undefined) cmd.w = finiteArray(w, MAX_IN_VALUES) ?? undefined
  if (v !== undefined) {
    const a = finiteArray(v, 3)
    if (a && a.length === 3) cmd.v = [a[0], a[1], a[2]]
  }
  if (Array.isArray(sp)) {
    const out: DroneSetpoint[] = []
    for (const e of sp.slice(0, MAX_IN_VALUES)) {
      if (typeof e !== 'object' || e === null) continue
      const id = own(e as Obj, 'id')
      const p = finiteArray(own(e as Obj, 'p'), 3)
      const yaw = own(e as Obj, 'yaw')
      if (typeof id !== 'number' || !p || p.length !== 3) continue
      out.push(typeof yaw === 'number' ? { id, p: [p[0], p[1], p[2]], yaw } : { id, p: [p[0], p[1], p[2]] })
    }
    cmd.sp = out
  }
  const mode = own(o, 'mode')
  const h = own(o, 'h')
  if (typeof mode === 'string') cmd.mode = mode.slice(0, MAX_MODE_CHARS)
  if (typeof h === 'number' && Number.isFinite(h)) cmd.h = h
  const bad = (q !== undefined && !cmd.q) || (w !== undefined && !cmd.w) || (v !== undefined && !cmd.v)
  return bad ? null : cmd
}

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u)
}

export class VirtualDevice {
  private spec: HardwareSpec
  private body: VirtualBody
  private readonly rng: Rng
  private phase: DevicePhase = 'boot'
  private bootLeft: number
  private homeElapsed = 0
  private lastCmdAt: number | null = null
  private tripped = false
  private telAccum = 0
  private readonly warnAt = new Map<string, number>()
  uptimeMs = 0

  constructor(private readonly opts: VirtualDeviceOptions) {
    this.spec = opts.spec
    this.rng = createRng(opts.seed ?? 0xc0ffee)
    this.body = createBody(this.spec, this.rng, opts.miscalibrate ?? true, { warn: (k, m) => this.warn(k, m) })
    this.bootLeft = opts.bootMs ?? BOOT_MS
  }

  get state(): DevicePhase {
    return this.phase
  }

  /** Test hook. */
  get physical(): VirtualBody {
    return this.body
  }

  /** Power on: a non-JSON boot banner like a real board, then hello once booted. */
  start(): void {
    this.opts.emit(`kiyobridge virtual board booting (${this.spec.robot}, ${this.spec.joints} joints)`)
  }

  /** Re-flash for another robot: fresh body, reboot, new hello. */
  reflash(spec: HardwareSpec): void {
    this.spec = spec
    this.body = createBody(spec, this.rng, this.opts.miscalibrate ?? true, { warn: (k, m) => this.warn(k, m) })
    this.phase = 'boot'
    this.bootLeft = this.opts.bootMs ?? BOOT_MS
    this.uptimeMs = 0
    this.lastCmdAt = null
    this.tripped = false
    this.telAccum = 0
    this.warnAt.clear()
    this.start()
  }

  receive(line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      this.log('err', 'bad json')
      return
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return this.log('err', 'expected a JSON object')
    const t = own(raw as Obj, 't')
    switch (t) {
      case 'hello?':
        if (this.phase !== 'boot') this.sendHello()
        return
      case 'ping': {
        const id = own(raw as Obj, 'id')
        if (typeof id === 'number' && Number.isFinite(id)) this.send({ t: 'pong', id })
        return
      }
      case 'home':
        return this.startHome()
      case 'estop':
        return this.estop()
      case 'cmd':
        return this.onCmd(raw as Obj)
      default:
        this.warn('unknown', `unknown message '${String(t).slice(0, 16)}'`)
    }
  }

  /** Advance the board by dtMs (sub-stepped at 10 ms like a firmware loop). */
  step(dtMs: number): void {
    let left = dtMs
    while (left > 1e-9) {
      const h = Math.min(left, SUBSTEP_MS)
      this.stepOnce(h)
      left -= h
    }
  }

  private stepOnce(h: number): void {
    this.uptimeMs += h
    const cfg = this.opts.getConfig()
    if (this.phase === 'boot') {
      this.bootLeft -= h
      if (this.bootLeft > 0) return
      this.phase = 'idle'
      this.sendHello()
      this.log('info', 'ready, waiting for home')
    }
    if (this.phase === 'homing') this.advanceHome(h)
    this.checkWatchdog(cfg)
    this.body.step(h / 1000)
    const period = 1000 / Math.min(Math.max(cfg.telemetryHz, 1), MAX_TEL_HZ)
    this.telAccum += h
    if (this.telAccum >= period) {
      this.telAccum = this.telAccum > 4 * period ? 0 : this.telAccum - period
      this.sendTel()
    }
  }

  private advanceHome(h: number): void {
    this.homeElapsed += h
    const u = Math.min(1, this.homeElapsed / HOME_MS)
    this.body.homeProgress(smoothstep(u))
    if (u < 1) return
    this.phase = 'ready'
    // the firmware arms the watchdog the moment homing completes (lastCmd_ = now)
    this.lastCmdAt = this.uptimeMs
    this.tripped = false
    this.send({ t: 'ack', of: 'home', ok: true })
  }

  /** Firmware KiyoBridge::watchdog: hold keeps accepting cmd; relax drops to idle and needs HOME. */
  private checkWatchdog(cfg: HardwareConfig): void {
    if (this.phase !== 'ready' || this.lastCmdAt === null || this.tripped) return
    if (this.uptimeMs - this.lastCmdAt <= cfg.watchdogMs) return
    this.tripped = true
    if (cfg.watchdogAction === 'relax') {
      this.setMode('relax')
      this.phase = 'idle'
      this.log('warn', `watchdog: no cmd for ${cfg.watchdogMs} ms, outputs relaxed; send home to resume`)
      return
    }
    this.setMode('hold')
    this.log('warn', `watchdog: no cmd for ${cfg.watchdogMs} ms, holding the last pose`)
  }

  private onCmd(o: Obj): void {
    if (this.phase === 'boot' || this.phase === 'homing') return
    if (this.phase === 'idle') return this.warn('nothome', 'cmd ignored: send home first')
    if (this.phase === 'estopped') return this.warn('estopped', 'cmd ignored: E-STOP active, send home to re-arm')
    const cmd = readCmd(o)
    if (!cmd) return this.warn('badcmd', 'cmd ignored: malformed fields')
    this.lastCmdAt = this.uptimeMs
    if (this.tripped) {
      this.tripped = false
      this.log('info', 'watchdog cleared, commands resumed')
    }
    this.setMode('track')
    this.body.command(cmd, this.opts.getConfig())
  }

  private startHome(): void {
    if (this.phase === 'boot') {
      this.send({ t: 'ack', of: 'home', ok: false, msg: 'booting' })
      return
    }
    this.phase = 'homing'
    this.homeElapsed = 0
    this.setMode('hold')
    this.body.beginHome(this.opts.getConfig())
    this.log('info', 'homing')
  }

  private estop(): void {
    if (this.phase === 'boot') return
    this.phase = 'estopped'
    this.setMode('frozen')
    this.send({ t: 'ack', of: 'estop', ok: true })
    this.log('warn', `E-STOP: ${this.body.estopNote}, send home to re-arm`)
  }

  private setMode(m: DriveMode): void {
    this.body.setMode(m)
  }

  private sendHello(): void {
    const s = this.spec
    // built in protocol-example key order (legs before joints), typed against HelloMsg
    const hello: Omit<HelloMsg, 'joints'> & { joints?: number } = {
      t: 'hello',
      proto: PROTOCOL_VERSION,
      board: this.opts.getConfig().board,
      robot: s.robot,
    }
    if (s.legs !== undefined) hello.legs = s.legs
    if (s.wheels !== undefined) hello.wheels = s.wheels
    if (s.drones !== undefined) hello.drones = s.drones
    hello.joints = s.joints
    hello.fw = VIRTUAL_FW
    hello.caps = ['virtual', ...this.body.caps]
    this.opts.emit(JSON.stringify(hello))
  }

  private sendTel(): void {
    const tel: TelMsg = { t: 'tel', ms: Math.round(this.uptimeMs) }
    this.body.telemetry(tel)
    this.send(tel)
  }

  private send(msg: object): void {
    this.opts.emit(JSON.stringify(msg))
  }

  private log(lvl: 'info' | 'warn' | 'err', msg: string): void {
    this.send({ t: 'log', lvl, msg })
  }

  /** Warn at most once per second per key, like firmware that rate-limits its own logs. */
  private warn(key: string, msg: string): void {
    const last = this.warnAt.get(key)
    if (last !== undefined && this.uptimeMs - last < WARN_REPEAT_MS) return
    this.warnAt.set(key, this.uptimeMs)
    this.log('warn', msg)
  }
}
