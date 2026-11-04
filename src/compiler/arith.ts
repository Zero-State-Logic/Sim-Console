/* ============================================================
   C ARITHMETIC — the value semantics shared by constant folding
   (compile time) and the VM (run time): two's-complement wrap at
   8/16/32 bits, truncating division, C sign rules for %, float32
   rounding, and float → int conversion.
   ============================================================ */

import { intInfo, isF32, type CType, type PrimKind } from './ctypes'

/** Wraps an integral value to `bits` (two's complement when signed). */
export function wrapInt(v: number, bits: number, signed: boolean): number {
  switch (bits) {
    case 1: return v !== 0 ? 1 : 0
    case 8: return signed ? (v << 24) >> 24 : v & 0xff
    case 16: return signed ? (v << 16) >> 16 : v & 0xffff
    default: return signed ? v | 0 : v >>> 0
  }
}

/**
 * float → 32-bit integer: truncate toward zero, NaN → 0, saturate at the range
 * ends (what ARM and Xtensa FPUs do). Narrower targets then wrap the 32-bit result.
 */
export function floatToInt32(v: number, signed: boolean): number {
  if (v !== v) return 0
  const t = Math.trunc(v)
  if (signed) return t >= 2147483647 ? 2147483647 : t <= -2147483648 ? -2147483648 : t
  return t >= 4294967295 ? 4294967295 : t <= 0 ? 0 : t
}

/** Converts a numeric value between C arithmetic types (bool included). */
export function convertNumber(v: number, to: PrimKind, intBits: number, fromFloat: boolean): number {
  if (to === 'float' || to === 'double') return isF32(to, intBits) ? Math.fround(v) : v
  const info = intInfo(to, intBits)
  if (!info) return v
  if (info.bits === 1) return v !== 0 ? 1 : 0
  if (fromFloat) {
    const wide = floatToInt32(v, info.signed || info.bits < 32)
    return wrapInt(wide, info.bits, info.signed)
  }
  return wrapInt(v, info.bits, info.signed)
}

export type ArithOp = '+' | '-' | '*' | '/' | '%' | '&' | '|' | '^' | '<<' | '>>'

/**
 * a op b in the (already converted-to) operation type. Returns null for an integer
 * division by zero, which the VM reports as a runtime error.
 */
export function arith(op: ArithOp, a: number, b: number, ty: CType, intBits: number): number | null {
  if (ty.t !== 'prim') return null
  const p = ty.p
  if (p === 'float' || p === 'double') {
    const f32 = isF32(p, intBits)
    let r: number
    switch (op) {
      case '+': r = a + b; break
      case '-': r = a - b; break
      case '*': r = a * b; break
      case '/': r = a / b; break
      default: return null
    }
    return f32 ? Math.fround(r) : r
  }
  const info = intInfo(p, intBits)
  if (!info) return null
  const w = (x: number): number => wrapInt(x, info.bits, info.signed)
  switch (op) {
    case '+': return w(a + b)
    case '-': return w(a - b)
    case '*': return w(info.bits === 32 ? Math.imul(a, b) : a * b)
    case '/': return b === 0 ? null : w(Math.trunc(a / b))
    case '%': return b === 0 ? null : w(a % b)
    case '&': return w(a & b)
    case '|': return w(a | b)
    case '^': return w(a ^ b)
    case '<<': return w(a << (b & 31))
    case '>>': return w(info.signed ? a >> (b & 31) : a >>> (b & 31))
    default: return null
  }
}

/** Avr-libc's random(): Park–Miller "minimal standard" generator, seeded with 1. */
export function nextRandom(state: number): number {
  let x = state
  if (x === 0) x = 123459876
  const hi = Math.trunc(x / 127773)
  const lo = x % 127773
  x = 16807 * lo - 2836 * hi
  if (x < 0) x += 0x7fffffff
  return x
}

/** Arduino random(howbig) given the next raw value. */
export function randomBelow(raw: number, howbig: number): number {
  if (howbig === 0) return 0
  return raw % howbig
}

/** Arduino map() in 32-bit long arithmetic (integer truncation, as on the board). */
export function arduinoMap(x: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  const run = (inMax - inMin) | 0
  if (run === 0) return -1
  const rise = (outMax - outMin) | 0
  const delta = (x - inMin) | 0
  return (Math.trunc(Math.imul(delta, rise) / run) + outMin) | 0
}

/** Arduino String(float, digits): fixed decimals like dtostrf, "nan" / "inf" for the specials. */
export function formatFloat(v: number, digits: number): string {
  if (Number.isNaN(v)) return 'nan'
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf'
  // -0.001 prints "-0.00" on the board too (the sign is printed before rounding)
  return v.toFixed(Math.max(0, Math.min(20, Math.trunc(digits))))
}
