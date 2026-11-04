import type { SandboxCommand, SandboxFnDef, SensorSnapshot } from '../../core/types'
import { MAX_CMDS_PER_TICK, type HwMap, type LogEntry, type LogLevel } from '../protocol'
import { adcBits, ledPin } from './boards'
import { Pins } from './pins'
import { SerialPort } from './serialPort'
import { ServoBank, type ServoSink } from './servos'

/* ============================================================
   ARDUINO SHIM — the virtual board both dialects run against:
   GPIO, Serial, Servo / PCA9685, I2C stubs and the robot API.
   One instance per loaded program. Pure TS, lives in the worker.
   ============================================================ */

const MAX_LOG_PER_TICK = 16
const I2C_NACK_ADDR = 2

export interface ShimOutput {
  cmds: SandboxCommand[]
  serial: string[]
  log: LogEntry[]
}

export class ArduinoShim implements ServoSink {
  /** Virtual clock, ms (sim time). */
  now = 0
  /** Sim time of the first tick after load / reset: millis() counts from here, like a board's boot. */
  private bootMs: number | null = null
  readonly serial = new SerialPort()
  readonly pins: Pins
  readonly servos: ServoBank
  private sensors: SensorSnapshot = {}
  private cmds: SandboxCommand[] = []
  /** Index in `cmds` of the latest setJoint per joint, while only setJoints follow it. */
  private jointSlot = new Map<number, number>()
  private log: LogEntry[] = []
  private warned = new Set<string>()
  private readonly fns = new Map<string, SandboxFnDef>()
  private wireAddr = -1
  private seed = 0x2545f491

  constructor(readonly hw: HwMap, api: readonly SandboxFnDef[]) {
    for (const f of api) this.fns.set(f.name, f)
    this.pins = new Pins(ledPin(hw.board), adcBits(hw.board))
    this.servos = new ServoBank(hw, this)
  }

  get ledPin(): number {
    return this.pins.ledPin
  }

  get led(): number {
    return this.pins.led
  }

  get api(): SandboxFnDef[] {
    return [...this.fns.values()]
  }

  beginTick(nowMs: number, sensors: SensorSnapshot, input?: string): void {
    this.now = nowMs
    if (this.bootMs === null) this.bootMs = nowMs
    this.sensors = sensors
    if (input) this.serial.feed(input)
  }

  /** Arduino millis() for the JS dialect: virtual ms since the program started (the C++ VM keeps its own). */
  millis(): number {
    return Math.max(0, Math.floor(this.now - (this.bootMs ?? this.now)))
  }

  micros(): number {
    return Math.max(0, Math.floor((this.now - (this.bootMs ?? this.now)) * 1000))
  }

  /** Everything produced since the last call. */
  takeOutput(): ShimOutput {
    const out = { cmds: this.cmds, serial: this.serial.take(), log: this.log }
    this.cmds = []
    this.jointSlot.clear()
    this.log = []
    return out
  }

  reset(): void {
    this.serial.reset()
    this.pins.reset()
    this.servos.reset()
    this.cmds = []
    this.jointSlot.clear()
    this.log = []
    this.warned.clear()
    this.wireAddr = -1
    this.seed = 0x2545f491
    this.bootMs = null
  }

  /* ---------------- notes ---------------- */

  note(level: LogLevel, text: string): void {
    if (this.log.length < MAX_LOG_PER_TICK) this.log.push({ level, text })
  }

  warnOnce(key: string, text: string, level: LogLevel = 'warn'): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.note(level, text)
  }

  /* ---------------- robot API ---------------- */

  hasFn(name: string): boolean {
    return this.fns.has(name)
  }

  /** Command: queue {fn, args}. Query: read the latest sensor snapshot. */
  callRobot(name: string, args: readonly number[]): number {
    const def = this.fns.get(name)
    if (!def) return 0
    if (def.kind === 'query') return this.query(def, args)
    const vals: number[] = []
    for (let i = 0; i < def.params.length; i++) {
      const v = args[i]
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        this.warnOnce(`nan-${name}`, `${name}() got a non-finite or missing argument (${def.params[i]}); the call was dropped.`)
        return 0
      }
      vals.push(v)
    }
    this.push(name, vals)
    return 0
  }

  private query(def: SandboxFnDef, args: readonly number[]): number {
    const v = def.sensor ? this.sensors[def.sensor] : undefined
    if (typeof v === 'number') return v
    if (!Array.isArray(v)) return 0
    const i = Math.trunc(args[0] ?? 0)
    return i >= 0 && i < v.length ? v[i] : 0
  }

  /** Joint command from a servo output (only on robots that expose setJoint). */
  setJoint(joint: number, deg: number): void {
    const def = this.fns.get('setJoint')
    if (!def || def.kind !== 'command') {
      this.warnOnce('servo-no-joints', 'Servo output is ignored: this robot has no setJoint() (servo pins map to joints on the walker).')
      return
    }
    this.push('setJoint', [joint, Math.round(deg * 100) / 100])
  }

  private push(fn: string, args: number[]): void {
    // repeated setJoint on the same joint inside one tick collapses to the last value
    if (fn === 'setJoint') {
      const slot = this.jointSlot.get(args[0])
      if (slot !== undefined) {
        this.cmds[slot] = { fn, args }
        return
      }
    } else this.jointSlot.clear()
    if (this.cmds.length >= MAX_CMDS_PER_TICK) {
      this.warnOnce('cmd-cap', `More than ${MAX_CMDS_PER_TICK} robot commands in one frame; the rest were dropped.`)
      return
    }
    if (fn === 'setJoint') this.jointSlot.set(args[0], this.cmds.length)
    this.cmds.push({ fn, args })
  }

  /* ---------------- I2C / Wire ---------------- */

  wireBegin(): void {
    this.wireAddr = -1
  }

  wireBeginTransmission(addr: number): void {
    this.wireAddr = Math.trunc(addr)
  }

  /** 0 = ACK. Only PCA9685 objects answer on the virtual bus; anything else NACKs. */
  wireEndTransmission(): number {
    const ok = this.servos.hasPcaAt(this.wireAddr)
    this.wireAddr = -1
    return ok ? 0 : I2C_NACK_ADDR
  }

  /* ---------------- stubs with notes ---------------- */

  bridgeCall(): void {
    this.warnOnce(
      'bridge',
      'kiyobridge sketch: Bridge.begin() / Bridge.update() link a real board to SIM CONSOLE and are no-ops here. Call the robot API (see API) to drive the virtual robot.',
      'info',
    )
  }

  wifiCall(): void {
    this.warnOnce('wifi', 'WiFi is not simulated: WiFi calls are stubs and status() reports WL_CONNECTED.')
  }

  /* ---------------- JS-side helpers (the C++ VM has its own) ---------------- */

  randomSeed(s: number): void {
    this.seed = (Math.trunc(s) >>> 0) || 0x2545f491
  }

  /** Arduino random(max) / random(min, max): integer in [min, max). xorshift32. */
  random(a: number, b?: number): number {
    const lo = b === undefined ? 0 : Math.trunc(a)
    const hi = b === undefined ? Math.trunc(a) : Math.trunc(b)
    if (hi <= lo) return lo
    let x = this.seed
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.seed = x >>> 0
    return lo + (this.seed % (hi - lo))
  }
}
