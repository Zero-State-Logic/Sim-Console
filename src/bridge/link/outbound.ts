import { MAX_LINE_BYTES } from '../../core/protocol'
import type { AppToBot, CmdMsg } from '../../core/protocol'
import { utf8Length } from './framing'

/* ============================================================
   OUTBOUND — rate limiting, sequence numbers and a compact
   command serializer. Commands go out at up to 50 Hz, so the
   serializer rounds to the precision the hardware can use and
   refuses to emit non-finite numbers (NaN is not JSON, and a
   board must never get garbage targets).
   ============================================================ */

/**
 * Fixed-rate gate driven by a wall clock (ms). Keeps the long-run average at `hz`
 * even when frames do not line up with the period, without bursting after a stall.
 */
export class RateLimiter {
  private nextAt = -Infinity
  private periodMs: number

  constructor(hz: number) {
    this.periodMs = 1000 / Math.max(hz, 0.001)
  }

  setHz(hz: number): void {
    this.periodMs = 1000 / Math.max(hz, 0.001)
  }

  get period(): number {
    return this.periodMs
  }

  /** True (and consumes the slot) when a send is due at `now`. */
  ready(now: number): boolean {
    if (now < this.nextAt) return false
    // fell behind by more than one period (tab stall, first call): restart from now
    this.nextAt = now - this.nextAt > this.periodMs ? now + this.periodMs : this.nextAt + this.periodMs
    return true
  }

  reset(): void {
    this.nextAt = -Infinity
  }
}

/** Command sequence numbers, wrapping well inside a uint32 on the board. */
export class SeqCounter {
  private n = 0
  static readonly WRAP = 0x7fffffff

  next(): number {
    const v = this.n
    this.n = this.n >= SeqCounter.WRAP ? 0 : this.n + 1
    return v
  }

  get value(): number {
    return this.n
  }

  reset(): void {
    this.n = 0
  }
}

const POW10 = [1, 10, 100, 1000, 10000, 100000]

/** Shortest decimal string of x rounded to `digits` places ('-0' prints as '0'). */
export function fmtNum(x: number, digits: number): string {
  const p = POW10[digits] ?? 10 ** digits
  const r = Math.round(x * p) / p
  return r === 0 ? '0' : String(r)
}

class NonFinite extends Error {}

function arr(a: readonly number[], digits: number, name: string): string {
  let s = '['
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new NonFinite(`${name}[${i}]`)
    if (i > 0) s += ','
    s += fmtNum(x, digits)
  }
  return `${s}]`
}

function scalar(x: number, digits: number, name: string): string {
  if (!Number.isFinite(x)) throw new NonFinite(name)
  return fmtNum(x, digits)
}

/** Rounding per field: joint degrees 0.01°, twist 0.1 mm/s, wheels 1 mrad/s, positions 1 mm. */
const DIGITS = { q: 2, v: 4, w: 3, h: 4, p: 3, yaw: 2 }
const MAX_MODE_CHARS = 32

export type SerializeResult = { ok: true; line: string } | { ok: false; reason: string }

/** Serialize a command with a sequence number. Same key order as the protocol examples. */
export function serializeCmd(cmd: CmdMsg, seq: number): SerializeResult {
  try {
    let s = `{"t":"cmd","seq":${seq}`
    if (cmd.q) s += `,"q":${arr(cmd.q, DIGITS.q, 'q')}`
    if (cmd.v) s += `,"v":${arr(cmd.v, DIGITS.v, 'v')}`
    if (cmd.w) s += `,"w":${arr(cmd.w, DIGITS.w, 'w')}`
    if (cmd.sp) {
      s += ',"sp":['
      for (let i = 0; i < cmd.sp.length; i++) {
        const d = cmd.sp[i]
        if (i > 0) s += ','
        s += `{"id":${scalar(d.id, 0, `sp[${i}].id`)},"p":${arr(d.p, DIGITS.p, `sp[${i}].p`)}`
        if (d.yaw !== undefined) s += `,"yaw":${scalar(d.yaw, DIGITS.yaw, `sp[${i}].yaw`)}`
        s += '}'
      }
      s += ']'
    }
    if (cmd.mode !== undefined) s += `,"mode":${JSON.stringify(String(cmd.mode).slice(0, MAX_MODE_CHARS))}`
    if (cmd.h !== undefined) s += `,"h":${scalar(cmd.h, DIGITS.h, 'h')}`
    return { ok: true, line: `${s}}` }
  } catch (e) {
    if (e instanceof NonFinite) return { ok: false, reason: `non-finite value in ${e.message}` }
    throw e
  }
}

/** Serialize any non-cmd app-to-bot message. */
export function encodeMsg(msg: Exclude<AppToBot, CmdMsg>): string {
  return JSON.stringify(msg)
}

const KNOWN_OUT = new Set(['cmd', 'home', 'estop', 'ping', 'hello?'])

export type OutboundCheck = { ok: true; line: string; known: boolean } | { ok: false; reason: string }

/**
 * Validate a hand-typed line from the serial monitor before it is sent: it must be one
 * JSON object with a string t and fit in one protocol line. It is re-serialized, so
 * whitespace and newlines inside the input cannot split it into two lines on the wire.
 */
export function validateOutboundLine(text: string): OutboundCheck {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'empty line' }
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch (e) {
    return { ok: false, reason: `not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'must be a JSON object' }
  const t = (raw as Record<string, unknown>).t
  if (typeof t !== 'string' || t.length === 0) return { ok: false, reason: 'missing string field "t"' }
  const line = JSON.stringify(raw)
  if (utf8Length(line) > MAX_LINE_BYTES) return { ok: false, reason: `longer than ${MAX_LINE_BYTES} bytes` }
  return { ok: true, line, known: KNOWN_OUT.has(t) }
}
