/* ============================================================
   VM BUILTINS — math, timing, avr-libc random(), Arduino map(),
   character classification and the String library, dispatched
   by builtin id. Arguments are read in place from the stack.
   ============================================================ */

import { arduinoMap, formatFloat, randomBelow } from '../arith'
import { B } from '../builtins'
import * as S from './strings'
import type { Slot } from './values'

export interface BuiltinHost {
  /** Virtual time since boot, ms (fractional). */
  elapsedMs(): number
  random(): number
  seed(s: number): void
}

/** C round(): half away from zero (JS Math.round rounds half up). */
function cRound(v: number): number {
  return v < 0 ? -Math.round(-v) : Math.round(v)
}

function isSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13)
}

function isPunct(c: number): boolean {
  return c > 32 && c < 127 && !/[A-Za-z0-9]/.test(String.fromCharCode(c))
}

function charClass(id: number, c: number): number | null {
  const ch = c & 0xff
  switch (id) {
    case B.C_ISDIGIT: return ch >= 48 && ch <= 57 ? 1 : 0
    case B.C_ISALPHA: return (ch | 32) >= 97 && (ch | 32) <= 122 ? 1 : 0
    case B.C_ISALNUM: return (ch >= 48 && ch <= 57) || ((ch | 32) >= 97 && (ch | 32) <= 122) ? 1 : 0
    case B.C_ISSPACE: return isSpace(ch) ? 1 : 0
    case B.C_ISWHITESPACE: return ch === 32 || ch === 9 ? 1 : 0
    case B.C_ISUPPER: return ch >= 65 && ch <= 90 ? 1 : 0
    case B.C_ISLOWER: return ch >= 97 && ch <= 122 ? 1 : 0
    case B.C_ISPUNCT: return isPunct(ch) ? 1 : 0
    case B.C_ISXDIGIT: return /[0-9A-Fa-f]/.test(String.fromCharCode(ch)) ? 1 : 0
    case B.C_ISPRINT: return ch >= 32 && ch < 127 ? 1 : 0
    case B.C_ISGRAPH: return ch > 32 && ch < 127 ? 1 : 0
    case B.C_ISCONTROL: return ch < 32 || ch === 127 ? 1 : 0
    case B.C_ISASCII: return c >= 0 && c < 128 ? 1 : 0
    case B.C_TOUPPER: return ch >= 97 && ch <= 122 ? c - 32 : c
    case B.C_TOLOWER: return ch >= 65 && ch <= 90 ? c + 32 : c
    default: return null
  }
}

function math(id: number, a: number, b: number): number | null {
  switch (id) {
    case B.SQRT: return Math.sqrt(a)
    case B.POW: return Math.pow(a, b)
    case B.SIN: return Math.sin(a)
    case B.COS: return Math.cos(a)
    case B.TAN: return Math.tan(a)
    case B.ASIN: return Math.asin(a)
    case B.ACOS: return Math.acos(a)
    case B.ATAN: return Math.atan(a)
    case B.ATAN2: return Math.atan2(a, b)
    case B.EXP: return Math.exp(a)
    case B.LOG: return Math.log(a)
    case B.LOG10: return Math.log10(a)
    case B.FLOOR: return Math.floor(a)
    case B.CEIL: return Math.ceil(a)
    case B.ROUND: return cRound(a)
    case B.FABS: return Math.abs(a)
    case B.FMOD: return a % b
    case B.HYPOT: return Math.hypot(a, b)
    case B.TRUNC: return Math.trunc(a)
    case B.FMIN: return Math.min(a, b)
    case B.FMAX: return Math.max(a, b)
    case B.CBRT: return Math.cbrt(a)
    case B.ISNAN: return Number.isNaN(a) ? 1 : 0
    case B.ISINF: return a === Infinity || a === -Infinity ? 1 : 0
    default: return null
  }
}

/** Runs builtin `id` on stack[base .. base+argc). */
export function callBuiltin(host: BuiltinHost, id: number, st: Slot[], base: number, argc: number): Slot {
  const a = st[base]
  const b = st[base + 1]
  if (id >= B.SQRT && id <= B.CBRT) return math(id, a as number, b as number) ?? 0
  if (id >= B.C_ISDIGIT && id <= B.C_ISWHITESPACE) return charClass(id, a as number) ?? 0
  switch (id) {
    case B.MILLIS: return Math.floor(host.elapsedMs()) >>> 0
    case B.MICROS: return Math.floor(host.elapsedMs() * 1000) >>> 0
    case B.RANDOM1: return randomBelow(host.random(), a as number)
    case B.RANDOM2: {
      const lo = a as number
      const hi = b as number
      if (lo >= hi) return lo
      return (randomBelow(host.random(), (hi - lo) | 0) + lo) | 0
    }
    case B.RANDOM_SEED:
      if ((a as number) !== 0) host.seed(a as number)
      return 0
    case B.MAP: return arduinoMap(a as number, b as number, st[base + 2] as number, st[base + 3] as number, st[base + 4] as number)
    case B.STR_INT: return S.intToString(a as number, b as number, st[base + 2] as number)
    case B.STR_FLOAT: return formatFloat(a as number, b as number)
    case B.STRLEN: return (a as string).length
    default: return stringMethod(id, st, base, argc)
  }
}

function opt(st: Slot[], base: number, argc: number, i: number): number | undefined {
  return argc > i ? (st[base + i] as number) : undefined
}

function stringMethod(id: number, st: Slot[], base: number, argc: number): Slot {
  const s = st[base] as string
  const x = st[base + 1]
  switch (id) {
    case B.S_LENGTH: return s.length
    case B.S_CHARAT: {
      const i = (x as number) >>> 0
      return i < s.length ? S.charCode(s, i) : 0
    }
    case B.S_SUBSTRING: return S.substring(s, x as number, opt(st, base, argc, 2))
    case B.S_INDEXOF: return S.indexOf(s, x as number | string, opt(st, base, argc, 2))
    case B.S_LASTINDEXOF: return S.lastIndexOf(s, x as number | string, opt(st, base, argc, 2))
    case B.S_TOINT: return S.toInt(s)
    case B.S_TOFLOAT: return S.toFloat(s)
    case B.S_TODOUBLE: return S.toDouble(s)
    case B.S_TOUPPER: return S.upper(s)
    case B.S_TOLOWER: return S.lower(s)
    case B.S_TRIM: return S.trim(s)
    case B.S_EQUALS: return s === x ? 1 : 0
    case B.S_EQUALS_IC: return S.equalsIgnoreCase(s, x as string) ? 1 : 0
    case B.S_STARTSWITH: return S.startsWith(s, x as string, opt(st, base, argc, 2)) ? 1 : 0
    case B.S_ENDSWITH: return (x as string).length <= s.length && s.endsWith(x as string) ? 1 : 0
    case B.S_REPLACE: return S.replace(s, x as number | string, st[base + 2] as number | string)
    case B.S_REMOVE: return S.remove(s, x as number, opt(st, base, argc, 2))
    case B.S_SETCHARAT: return S.setCharAt(s, x as number, st[base + 2] as number)
    case B.S_COMPARETO: return S.compareTo(s, x as string)
    case B.S_ISEMPTY: return s.length === 0 ? 1 : 0
    case B.S_CONCAT: return S.checkLength(s + (x as string))
    case B.S_TOCHARARRAY:
      S.toCharArray(s, x as Slot[], st[base + 2] as number, opt(st, base, argc, 3) ?? 0)
      return 0
    default: throw new Error(`internal: unknown builtin ${id}`)
  }
}
