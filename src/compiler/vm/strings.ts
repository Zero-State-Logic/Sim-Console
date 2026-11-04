/* ============================================================
   ARDUINO STRING RUNTIME — WString.h behaviour: unsigned index
   clamping, ASCII-only case mapping and trimming, atol/atof
   number parsing, itoa-style base formatting, and Print-style
   float formatting (2 decimals by default).
   ============================================================ */

import { formatFloat } from '../arith'
import { StrKind } from '../bytecode'
import type { Slot } from './values'

const SPACE = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g

/** Unsigned int parameter semantics: negative values are huge. */
function u(n: number): number {
  return n >>> 0
}

function toChar(c: number): string {
  return String.fromCharCode(c & 0xff)
}

/** Char codes are signed (char is signed on the boards we model). */
export function charCode(s: string, i: number): number {
  const c = s.charCodeAt(i) & 0xff
  return c > 127 ? c - 256 : c
}

export function numToString(v: number, kind: number): string {
  if (kind === StrKind.CHAR) return toChar(v)
  if (kind === StrKind.FLOAT) return formatFloat(v, 2)
  return String(v)
}

/** String(value, base) — non-decimal bases print the two's complement bits, like itoa/utoa. */
export function intToString(v: number, base: number, bits: number): string {
  const b = base >= 2 && base <= 36 ? base : 10
  if (b === 10) return String(v)
  let x = v
  if (x < 0) x += 2 ** bits
  return Math.trunc(x).toString(b)
}

export function substring(s: string, from: number, to: number | undefined): string {
  let left = u(from)
  let right = to === undefined ? s.length : u(to)
  if (left > right) [left, right] = [right, left]
  if (left >= s.length) return ''
  return s.slice(left, Math.min(right, s.length))
}

function needle(x: number | string): string {
  return typeof x === 'number' ? toChar(x) : x
}

export function indexOf(s: string, x: number | string, from: number | undefined): number {
  const start = from === undefined ? 0 : u(from)
  if (start >= s.length) return -1
  return s.indexOf(needle(x), start)
}

export function lastIndexOf(s: string, x: number | string, from: number | undefined): number {
  const n = needle(x)
  if (n.length === 0 || n.length > s.length) return -1
  // WString: the char overload gives -1 for a start past the end, the String overload clamps it
  if (typeof x === 'number' && from !== undefined && u(from) >= s.length) return -1
  const start = from === undefined ? s.length - 1 : Math.min(u(from), s.length - 1)
  return s.lastIndexOf(n, start)
}

/** atol(): optional whitespace and sign, then digits; 0 when there are none. */
export function toInt(s: string): number {
  const n = parseInt(s, 10)
  return Number.isNaN(n) ? 0 : n | 0
}

/** atof() rounded to float. */
export function toFloat(s: string): number {
  return Math.fround(toDouble(s))
}

/** atof(): leading whitespace, then a decimal number, inf or nan; 0 when there is none. */
export function toDouble(s: string): number {
  const t = s.trim().toLowerCase()
  if (/^[+-]?inf/.test(t)) return t.startsWith('-') ? -Infinity : Infinity
  if (/^[+-]?nan/.test(t)) return NaN
  const n = parseFloat(t)
  return Number.isNaN(n) ? 0 : n
}

export function upper(s: string): string {
  return s.replace(/[a-z]/g, (c) => c.toUpperCase())
}

export function lower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

export function trim(s: string): string {
  return s.replace(SPACE, '')
}

export function equalsIgnoreCase(a: string, b: string): boolean {
  return a.length === b.length && lower(a) === lower(b)
}

export function startsWith(s: string, x: string, offset: number | undefined): boolean {
  const off = offset === undefined ? 0 : u(offset)
  if (off > s.length - x.length || x.length > s.length) return false
  return s.startsWith(x, off)
}

export function replace(s: string, a: number | string, b: number | string): string {
  const find = needle(a)
  if (find.length === 0) return s
  return checkLength(s.split(find).join(needle(b)))
}

/**
 * Cap on a String's length. A board runs out of RAM long before this; the cap turns a
 * runaway `s += s` into a runtime error at that line instead of exhausting the worker.
 */
export const MAX_STRING_LENGTH = 1_000_000

/** Returns s, or throws (a runtime error at the current line) when it is longer than the cap. */
export function checkLength(s: string): string {
  if (s.length > MAX_STRING_LENGTH) {
    throw new Error(`String is too long (${s.length} characters, the limit is ${MAX_STRING_LENGTH}): a real board runs out of memory long before this`)
  }
  return s
}

export function remove(s: string, index: number, count: number | undefined): string {
  const i = u(index)
  if (i >= s.length) return s
  const n = count === undefined ? s.length - i : Math.min(u(count), s.length - i)
  return s.slice(0, i) + s.slice(i + n)
}

export function setCharAt(s: string, i: number, c: number): string {
  const k = u(i)
  if (k >= s.length) return s
  return s.slice(0, k) + toChar(c) + s.slice(k + 1)
}

/** strcmp(): difference of the first differing bytes. */
export function compareTo(a: string, b: string): number {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const ca = i < a.length ? a.charCodeAt(i) & 0xff : 0
    const cb = i < b.length ? b.charCodeAt(i) & 0xff : 0
    if (ca !== cb) return ca - cb
  }
  return 0
}

/** toCharArray / getBytes: copies up to bufsize-1 chars plus the terminating zero, in place. */
export function toCharArray(s: string, buf: Slot[], size: number, index: number): void {
  const bufsize = Math.min(u(size), buf.length)
  if (bufsize === 0) return
  const start = u(index)
  let n = 0
  for (; n < bufsize - 1 && start + n < s.length; n++) buf[n] = charCode(s, start + n)
  buf[n] = 0
}
