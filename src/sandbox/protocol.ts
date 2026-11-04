import type { Diagnostic } from '../compiler/api'
import type { BoardId } from '../core/protocol'
import type { ServoDriver } from '../core/hardware'
import type { SandboxCommand, SandboxFnDef, SensorSnapshot } from '../core/types'

/* ============================================================
   SANDBOX WORKER PROTOCOL — main thread <-> code worker.
   Both directions are validated: the worker runs untrusted user
   code, so nothing it posts is trusted, and the worker refuses
   malformed requests instead of crashing on them.
   ============================================================ */

export type Dialect = 'cpp' | 'js'
export const DIALECTS: readonly Dialect[] = ['cpp', 'js']

/** Instruction budget per tick for the C++ VM. */
export const TICK_BUDGET = 200_000
/** Commands one tick may return (matches the walker's per-frame cap). */
export const MAX_CMDS_PER_TICK = 2048
/** Serial characters one tick may return; the rest is cut with a marker. */
export const MAX_SERIAL_PER_TICK = 8192
export const MAX_SOURCE_CHARS = 200_000
export const MAX_INPUT_CHARS = 4096
const MAX_API_FNS = 64
const MAX_PARAMS = 8
const MAX_ARGS = 8
const MAX_JOINTS = 64
const MAX_SENSOR_KEYS = 64
const MAX_SENSOR_ARRAY = 4096
const MAX_GLOBALS = 200
const MAX_LOG = 32
const MAX_TEXT = 2000
const MAX_DIAGS = 100

const BOARD_IDS: readonly BoardId[] = ['esp32', 'pico', 'picow', 'stm32', 'pizero2w']
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The part of the hardware profile the shim needs to map servo outputs to joints. */
export interface HwMap {
  board: BoardId
  servoDriver: ServoDriver
  /** Per joint: GPIO pin or PCA9685 channel (0-15 at 0x40, 16-31 at 0x41). */
  servoPins: number[]
  servoMinUs: number
  servoMaxUs: number
  servoRangeDeg: number
  jointInvert: boolean[]
  jointOffsetDeg: number[]
  jointScale: number[]
}

export interface LoadMsg {
  t: 'load'
  /** Load generation; the reply echoes it so stale replies are dropped. */
  id: number
  dialect: Dialect
  source: string
  api: SandboxFnDef[]
  hw: HwMap
  intBits: 16 | 32
}

export interface TickMsg {
  t: 'tick'
  seq: number
  /** Virtual clock, ms (sim time). millis() reads it. */
  nowMs: number
  sensors: SensorSnapshot
  /** Text typed into the console, delivered to Serial.read(). */
  input?: string
  /** Ask for a globals snapshot now (stepping) instead of waiting for the 4 Hz slot. */
  wantGlobals?: boolean
}

export interface ResetMsg {
  t: 'reset'
}

export interface StopMsg {
  t: 'stop'
}

export type MainMsg = LoadMsg | TickMsg | ResetMsg | StopMsg

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  level: LogLevel
  text: string
}

export interface WatchEntry {
  name: string
  value: string
}

export interface LoadedMsg {
  t: 'loaded'
  id: number
  ok: boolean
  diagnostics: Diagnostic[]
  /** Wall time spent compiling (C++) or instantiating (JS), ms. */
  compileMs: number
  log: LogEntry[]
}

/** What the program is doing after a tick. */
export type RunStatus = 'running' | 'sleeping' | 'halted' | 'error'

export interface OutMsg {
  t: 'out'
  seq: number
  cmds: SandboxCommand[]
  /** Serial text chunks in order (not split into lines). */
  serial: string[]
  log: LogEntry[]
  status: RunStatus
  /** 1-based line executing now (0 = unknown). */
  line: number
  error?: Diagnostic
  /** Throttled to about 4 Hz. */
  globals?: WatchEntry[]
  /** LED_BUILTIN brightness 0..1. */
  led: number
  /** Instructions executed this tick (C++), 0 for JS. */
  executed: number
  /** loop() completions this tick. */
  loops: number
  wakeAtMs?: number
}

export type WorkerMsg = LoadedMsg | OutMsg

/* ---------------- small validators ---------------- */

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

function clip(s: string, max = MAX_TEXT): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function numArray(v: unknown, max: number): number[] | null {
  if (!Array.isArray(v) || v.length > max) return null
  return v.every(isFiniteNum) ? (v as number[]).slice() : null
}

function boolArray(v: unknown, max: number): boolean[] | null {
  if (!Array.isArray(v) || v.length > max) return null
  return v.every((b) => typeof b === 'boolean') ? (v as boolean[]).slice() : null
}

/* ---------------- main -> worker ---------------- */

export function parseFnDef(v: unknown): SandboxFnDef | null {
  if (!isObj(v)) return null
  const { name, kind, params, sensor, doc } = v
  if (typeof name !== 'string' || !IDENT.test(name)) return null
  if (kind !== 'command' && kind !== 'query') return null
  if (!Array.isArray(params) || params.length > MAX_PARAMS) return null
  if (!params.every((p) => typeof p === 'string' && IDENT.test(p))) return null
  if (sensor !== undefined && typeof sensor !== 'string') return null
  const def: SandboxFnDef = { name, kind, params: (params as string[]).slice(), doc: typeof doc === 'string' ? clip(doc) : '' }
  if (typeof sensor === 'string') def.sensor = sensor
  return def
}

export function parseHwMap(v: unknown): HwMap | null {
  if (!isObj(v)) return null
  const board = v.board
  if (typeof board !== 'string' || !(BOARD_IDS as readonly string[]).includes(board)) return null
  if (v.servoDriver !== 'gpio' && v.servoDriver !== 'pca9685') return null
  const servoPins = numArray(v.servoPins, MAX_JOINTS)
  const jointInvert = boolArray(v.jointInvert, MAX_JOINTS)
  const jointOffsetDeg = numArray(v.jointOffsetDeg, MAX_JOINTS)
  const jointScale = numArray(v.jointScale, MAX_JOINTS)
  const { servoMinUs, servoMaxUs, servoRangeDeg } = v
  if (!servoPins || !jointInvert || !jointOffsetDeg || !jointScale) return null
  if (!isFiniteNum(servoMinUs) || !isFiniteNum(servoMaxUs) || servoMaxUs <= servoMinUs) return null
  if (!isFiniteNum(servoRangeDeg) || servoRangeDeg <= 0) return null
  return {
    board: board as BoardId,
    servoDriver: v.servoDriver,
    servoPins,
    servoMinUs,
    servoMaxUs,
    servoRangeDeg,
    jointInvert,
    jointOffsetDeg,
    jointScale,
  }
}

function isNumberList(v: unknown): v is ArrayLike<unknown> {
  return Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView))
}

/**
 * Lenient on purpose: a tick the worker refused would get no reply, and the watchdog
 * would then blame the user's loop(). Bad entries read as 0, extras are cut.
 */
export function parseSensors(v: unknown): SensorSnapshot | null {
  if (!isObj(v)) return null
  const out: SensorSnapshot = {}
  let kept = 0
  for (const k of Object.keys(v)) {
    if (kept >= MAX_SENSOR_KEYS) break
    const val = v[k]
    if (typeof val === 'number') out[k] = Number.isFinite(val) ? val : 0
    else if (isNumberList(val)) {
      const n = Math.min(val.length, MAX_SENSOR_ARRAY)
      const arr = new Array<number>(n)
      for (let i = 0; i < n; i++) {
        const x = val[i]
        arr[i] = typeof x === 'number' && Number.isFinite(x) ? x : 0
      }
      out[k] = arr
    } else continue
    kept++
  }
  return out
}

function parseLoad(v: Obj): LoadMsg | null {
  const { id, dialect, source, api, hw, intBits } = v
  if (!isInt(id)) return null
  if (dialect !== 'cpp' && dialect !== 'js') return null
  if (typeof source !== 'string' || source.length > MAX_SOURCE_CHARS) return null
  if (!Array.isArray(api) || api.length > MAX_API_FNS) return null
  const defs: SandboxFnDef[] = []
  for (const d of api) {
    const def = parseFnDef(d)
    if (!def) return null
    defs.push(def)
  }
  const map = parseHwMap(hw)
  if (!map || (intBits !== 16 && intBits !== 32)) return null
  return { t: 'load', id, dialect, source, api: defs, hw: map, intBits }
}

function parseTick(v: Obj): TickMsg | null {
  const { seq, nowMs, input, wantGlobals } = v
  if (!isInt(seq) || !isFiniteNum(nowMs) || nowMs < 0) return null
  const sensors = parseSensors(v.sensors)
  if (!sensors) return null
  const msg: TickMsg = { t: 'tick', seq, nowMs, sensors }
  if (typeof input === 'string' && input.length > 0) msg.input = input.slice(0, MAX_INPUT_CHARS)
  if (wantGlobals === true) msg.wantGlobals = true
  return msg
}

/** Worker side: accept only well-formed requests. */
export function parseMainMsg(data: unknown): MainMsg | null {
  if (!isObj(data)) return null
  switch (data.t) {
    case 'load':
      return parseLoad(data)
    case 'tick':
      return parseTick(data)
    case 'reset':
      return { t: 'reset' }
    case 'stop':
      return { t: 'stop' }
    default:
      return null
  }
}

/* ---------------- worker -> main ---------------- */

export function parseDiagnostic(v: unknown): Diagnostic | null {
  if (!isObj(v)) return null
  const { severity, message, line, col, endLine, endCol } = v
  if (severity !== 'error' && severity !== 'warning') return null
  if (typeof message !== 'string' || !isInt(line) || !isInt(col)) return null
  const d: Diagnostic = { severity, message: clip(message), line: Math.max(1, line), col: Math.max(1, col) }
  if (isInt(endLine) && isInt(endCol)) {
    d.endLine = Math.max(d.line, endLine)
    d.endCol = Math.max(1, endCol)
  }
  return d
}

function parseLog(v: unknown): LogEntry[] {
  if (!Array.isArray(v)) return []
  const out: LogEntry[] = []
  for (const e of v.slice(0, MAX_LOG)) {
    if (!isObj(e) || typeof e.text !== 'string') continue
    const level: LogLevel = e.level === 'warn' || e.level === 'error' ? e.level : 'info'
    out.push({ level, text: clip(e.text) })
  }
  return out
}

/** Keep only commands the active robot API declares, with finite numeric args. */
export function sanitizeCommands(v: unknown, commandNames: ReadonlySet<string>): SandboxCommand[] {
  if (!Array.isArray(v)) return []
  const out: SandboxCommand[] = []
  const n = Math.min(v.length, MAX_CMDS_PER_TICK)
  for (let i = 0; i < n; i++) {
    const c = v[i]
    if (!isObj(c) || typeof c.fn !== 'string' || !commandNames.has(c.fn)) continue
    const args = numArray(c.args, MAX_ARGS)
    if (args) out.push({ fn: c.fn, args })
  }
  return out
}

function parseSerial(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  let total = 0
  for (const s of v) {
    if (typeof s !== 'string') continue
    const room = MAX_SERIAL_PER_TICK - total
    if (room <= 0) break
    const chunk = s.length > room ? s.slice(0, room) : s
    out.push(chunk)
    total += chunk.length
  }
  return out
}

function parseGlobals(v: unknown): WatchEntry[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: WatchEntry[] = []
  for (const e of v.slice(0, MAX_GLOBALS)) {
    if (isObj(e) && typeof e.name === 'string' && typeof e.value === 'string') {
      out.push({ name: clip(e.name, 64), value: clip(e.value, 400) })
    }
  }
  return out
}

const RUN_STATUSES: readonly RunStatus[] = ['running', 'sleeping', 'halted', 'error']

function parseOut(v: Obj, commandNames: ReadonlySet<string>): OutMsg | null {
  const { seq, status, line, led, executed, loops, wakeAtMs } = v
  if (!isInt(seq) || typeof status !== 'string' || !(RUN_STATUSES as readonly string[]).includes(status)) return null
  const msg: OutMsg = {
    t: 'out',
    seq,
    cmds: sanitizeCommands(v.cmds, commandNames),
    serial: parseSerial(v.serial),
    log: parseLog(v.log),
    status: status as RunStatus,
    line: isInt(line) && line > 0 ? line : 0,
    led: isFiniteNum(led) ? Math.min(Math.max(led, 0), 1) : 0,
    executed: isFiniteNum(executed) && executed > 0 ? Math.round(executed) : 0,
    loops: isInt(loops) && loops > 0 ? loops : 0,
  }
  const error = v.error === undefined ? null : parseDiagnostic(v.error)
  if (error) msg.error = error
  const globals = parseGlobals(v.globals)
  if (globals) msg.globals = globals
  if (isFiniteNum(wakeAtMs)) msg.wakeAtMs = wakeAtMs
  return msg
}

function parseLoaded(v: Obj): LoadedMsg | null {
  const { id, ok, compileMs } = v
  if (!isInt(id) || typeof ok !== 'boolean') return null
  const diagnostics: Diagnostic[] = []
  if (Array.isArray(v.diagnostics)) {
    for (const d of v.diagnostics.slice(0, MAX_DIAGS)) {
      const p = parseDiagnostic(d)
      if (p) diagnostics.push(p)
    }
  }
  return {
    t: 'loaded',
    id,
    ok,
    diagnostics,
    compileMs: isFiniteNum(compileMs) && compileMs >= 0 ? compileMs : 0,
    log: parseLog(v.log),
  }
}

/** Main side: the worker runs user code, so its replies are untrusted. */
export function parseWorkerMsg(data: unknown, commandNames: ReadonlySet<string>): WorkerMsg | null {
  if (!isObj(data)) return null
  if (data.t === 'out') return parseOut(data, commandNames)
  if (data.t === 'loaded') return parseLoaded(data)
  return null
}

/** Names of the command functions in an API (for sanitizeCommands). */
export function commandNameSet(api: readonly SandboxFnDef[]): Set<string> {
  return new Set(api.filter((f) => f.kind === 'command').map((f) => f.name))
}
