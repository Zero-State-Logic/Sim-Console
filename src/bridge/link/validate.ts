import type {
  AckMsg,
  BoardId,
  BotToApp,
  DroneTel,
  HelloMsg,
  LidarScan,
  LogMsg,
  PongMsg,
  TelMsg,
} from '../../core/protocol'
import type { RobotKind } from '../../core/types'

/* ============================================================
   INBOUND VALIDATION — every line from a board is untrusted.
   Each message is rebuilt as a NEW object that copies only the
   known fields after type checks. Untrusted input is never
   spread, so extra keys (including __proto__ / constructor)
   cannot leak through. Any field with the wrong type makes the
   whole message invalid, with a reason for the serial monitor.
   ============================================================ */

export const MAX_JOINT_VALUES = 64
export const MAX_SCAN_SAMPLES = 2048
export const MAX_DRONES = 16
export const MAX_CAPS = 16
export const MAX_ID_CHARS = 32
export const MAX_FW_CHARS = 64
export const MAX_MSG_CHARS = 512

export type ParseResult =
  | { ok: true; msg: BotToApp }
  | { ok: false; kind: 'not-json'; reason: string }
  | { ok: false; kind: 'invalid'; t: string; reason: string }
  | { ok: false; kind: 'unknown'; t: string }

const BOARDS: readonly BoardId[] = ['esp32', 'pico', 'picow', 'stm32', 'pizero2w']
const ROBOTS: readonly RobotKind[] = ['walker', 'sweeper', 'swarm']

type Obj = Record<string, unknown>

/** Thrown inside the field readers; caught once in parseInbound. */
class FieldError extends Error {}

function fail(reason: string): never {
  throw new FieldError(reason)
}

/** Own-property read: never walks the prototype chain. */
function own(o: Obj, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function capStr(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function num(o: Obj, k: string, required: boolean): number | undefined {
  const v = own(o, k)
  if (v === undefined) return required ? fail(`missing ${k}`) : undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${k} is not a finite number`)
  return v
}

function int(o: Obj, k: string, required: boolean, min: number, max: number): number | undefined {
  const v = num(o, k, required)
  if (v === undefined) return undefined
  if (!Number.isInteger(v) || v < min || v > max) fail(`${k} must be an integer in ${min}..${max}`)
  return v
}

function str(o: Obj, k: string, required: boolean, maxChars: number): string | undefined {
  const v = own(o, k)
  if (v === undefined) return required ? fail(`missing ${k}`) : undefined
  if (typeof v !== 'string') fail(`${k} is not a string`)
  return capStr(v, maxChars)
}

function numArray(v: unknown, name: string, maxLen: number, exactLen?: number): number[] {
  if (!Array.isArray(v)) fail(`${name} is not an array`)
  if (v.length > maxLen) fail(`${name} has ${v.length} values (max ${maxLen})`)
  if (exactLen !== undefined && v.length !== exactLen) fail(`${name} must have ${exactLen} values`)
  const out = new Array<number>(v.length)
  for (let i = 0; i < v.length; i++) {
    const x: unknown = v[i]
    if (typeof x !== 'number' || !Number.isFinite(x)) fail(`${name}[${i}] is not a finite number`)
    out[i] = x
  }
  return out
}

function optArray(o: Obj, k: string, maxLen: number): number[] | undefined {
  const v = own(o, k)
  return v === undefined ? undefined : numArray(v, k, maxLen)
}

function vec3(v: unknown, name: string): [number, number, number] {
  const a = numArray(v, name, 3, 3)
  return [a[0], a[1], a[2]]
}

function optVec3(o: Obj, k: string): [number, number, number] | undefined {
  const v = own(o, k)
  return v === undefined ? undefined : vec3(v, k)
}

function parseHello(o: Obj): HelloMsg {
  const board = str(o, 'board', true, MAX_ID_CHARS) as string
  if (!BOARDS.includes(board as BoardId)) fail(`unknown board '${board}'`)
  const robot = str(o, 'robot', true, MAX_ID_CHARS) as string
  if (!ROBOTS.includes(robot as RobotKind)) fail(`unknown robot '${robot}'`)
  const msg: HelloMsg = {
    t: 'hello',
    proto: int(o, 'proto', true, 0, 1000) as number,
    board: board as BoardId,
    robot: robot as RobotKind,
    joints: int(o, 'joints', true, 0, MAX_JOINT_VALUES) as number,
  }
  const legs = int(o, 'legs', false, 0, MAX_JOINT_VALUES)
  const wheels = int(o, 'wheels', false, 0, MAX_JOINT_VALUES)
  const drones = int(o, 'drones', false, 0, MAX_DRONES)
  const fw = str(o, 'fw', false, MAX_FW_CHARS)
  if (legs !== undefined) msg.legs = legs
  if (wheels !== undefined) msg.wheels = wheels
  if (drones !== undefined) msg.drones = drones
  if (fw !== undefined) msg.fw = fw
  const caps = own(o, 'caps')
  if (caps !== undefined) {
    if (!Array.isArray(caps)) fail('caps is not an array')
    if (caps.length > MAX_CAPS) fail(`caps has ${caps.length} entries (max ${MAX_CAPS})`)
    msg.caps = caps.map((c: unknown, i) => (typeof c === 'string' ? capStr(c, MAX_ID_CHARS) : fail(`caps[${i}] is not a string`)))
  }
  return msg
}

function parseScan(v: unknown): LidarScan {
  if (!isObj(v)) fail('scan is not an object')
  const r = numArray(own(v, 'r'), 'scan.r', MAX_SCAN_SAMPLES)
  for (let i = 0; i < r.length; i++) if (r[i] < 0) fail(`scan.r[${i}] is negative`)
  return { a0: num(v, 'a0', true) as number, da: num(v, 'da', true) as number, r }
}

function parseDrone(v: unknown, i: number): DroneTel {
  if (!isObj(v)) fail(`drones[${i}] is not an object`)
  const d: DroneTel = {
    id: int(v, 'id', true, 0, 255) as number,
    p: vec3(own(v, 'p'), `drones[${i}].p`),
    att: vec3(own(v, 'att'), `drones[${i}].att`),
  }
  const bat = num(v, 'bat', false)
  if (bat !== undefined) d.bat = bat
  return d
}

function parseTel(o: Obj): TelMsg {
  const msg: TelMsg = { t: 'tel' }
  const ms = num(o, 'ms', false)
  if (ms !== undefined) msg.ms = ms
  const ang = optArray(o, 'ang', MAX_JOINT_VALUES)
  if (ang) msg.ang = ang
  const load = optArray(o, 'load', MAX_JOINT_VALUES)
  if (load) msg.load = load
  const enc = optArray(o, 'enc', MAX_JOINT_VALUES)
  if (enc) msg.enc = enc
  const imu = optVec3(o, 'imu')
  if (imu) msg.imu = imu
  const pose = optVec3(o, 'pose')
  if (pose) msg.pose = pose
  const vbat = num(o, 'vbat', false)
  if (vbat !== undefined) msg.vbat = vbat
  const scan = own(o, 'scan')
  if (scan !== undefined) msg.scan = parseScan(scan)
  const drones = own(o, 'drones')
  if (drones !== undefined) {
    if (!Array.isArray(drones)) fail('drones is not an array')
    if (drones.length > MAX_DRONES) fail(`drones has ${drones.length} entries (max ${MAX_DRONES})`)
    msg.drones = drones.map((d: unknown, i) => parseDrone(d, i))
  }
  return msg
}

function parseAck(o: Obj): AckMsg {
  const ok = own(o, 'ok')
  if (typeof ok !== 'boolean') fail('ok is not a boolean')
  const msg: AckMsg = { t: 'ack', of: str(o, 'of', true, MAX_ID_CHARS) as string, ok }
  const text = str(o, 'msg', false, MAX_MSG_CHARS)
  if (text !== undefined) msg.msg = text
  return msg
}

function parseLog(o: Obj): LogMsg {
  const lvl = own(o, 'lvl')
  const msg: LogMsg = { t: 'log', msg: str(o, 'msg', true, MAX_MSG_CHARS) as string }
  // a bad level is not worth dropping a log line over: unknown levels read as info
  msg.lvl = lvl === 'warn' || lvl === 'err' ? lvl : 'info'
  return msg
}

function parsePong(o: Obj): PongMsg {
  return { t: 'pong', id: int(o, 'id', true, 0, Number.MAX_SAFE_INTEGER) as number }
}

const PARSERS: Record<string, (o: Obj) => BotToApp> = {
  hello: parseHello,
  tel: parseTel,
  ack: parseAck,
  log: parseLog,
  pong: parsePong,
}

/** Parse and validate one inbound NDJSON line. Never throws. */
export function parseInbound(line: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { ok: false, kind: 'not-json', reason: 'not JSON' }
  }
  if (!isObj(raw)) return { ok: false, kind: 'not-json', reason: 'not a JSON object' }
  const t = own(raw, 't')
  if (typeof t !== 'string') return { ok: false, kind: 'invalid', t: '?', reason: 'missing message type t' }
  const tag = capStr(t, MAX_ID_CHARS)
  const parser = Object.prototype.hasOwnProperty.call(PARSERS, t) ? PARSERS[t] : undefined
  if (!parser) return { ok: false, kind: 'unknown', t: tag }
  try {
    return { ok: true, msg: parser(raw) }
  } catch (e) {
    if (e instanceof FieldError) return { ok: false, kind: 'invalid', t: tag, reason: e.message }
    throw e
  }
}
