import type { ValueType, VMValue } from '../../compiler/api'

/* ============================================================
   ARDUINO PRINT FORMATTING — byte-for-byte what Print.cpp does,
   driven by the static argument type the compiler reports, so
   Serial.print(3) is "3" but Serial.print(3.0) is "3.00".
   ============================================================ */

export const DEC = 10
export const HEX = 16
export const OCT = 8
export const BIN = 2

/** Print::printNumber: unsigned digits in any base >= 2 (base < 2 means 10). Upper-case hex. */
export function printNumber(n: number, base = DEC): string {
  const b = Number.isInteger(base) && base >= 2 ? Math.min(base, 36) : DEC
  return (Math.trunc(n) >>> 0).toString(b).toUpperCase()
}

/** Print::print(long, base): signed in base 10, 32-bit two's complement in any other base. */
export function printLong(n: number, base = DEC): string {
  const v = Math.trunc(n) | 0
  if (base === 0) return String.fromCharCode(v & 0xff)
  if (base === DEC || !(base >= 2)) return String(v)
  return printNumber(v >>> 0, base)
}

const OVF = 4294967040.0

/** Print::printFloat, including its "nan" / "inf" / "ovf" and round-half-up quirks. */
export function printFloat(x: number, digits = 2): string {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return 'inf'
  if (x > OVF || x < -OVF) return 'ovf'
  let d = Math.max(0, Math.min(Math.trunc(digits) & 0xff, 20))
  let out = ''
  let num = x
  if (num < 0) {
    out = '-'
    num = -num
  }
  let rounding = 0.5
  for (let i = 0; i < d; i++) rounding /= 10
  num += rounding
  const intPart = Math.floor(num)
  let rem = num - intPart
  out += String(intPart >>> 0)
  if (d > 0) out += '.'
  while (d-- > 0) {
    rem *= 10
    const digit = Math.floor(rem)
    out += String(digit)
    rem -= digit
  }
  return out
}

function isIntegral(t: ValueType): boolean {
  return t === 'int' || t === 'long' || t === 'unsigned'
}

/** Text for one VM value of a non-numeric shape (arrays / structs) — not Arduino, but readable. */
function printComposite(v: VMValue): string {
  if (Array.isArray(v)) return `[${v.map(printComposite).join(', ')}]`
  if (typeof v === 'object' && v !== null) {
    return `{${Object.entries(v).map(([k, x]) => `${k}: ${printComposite(x)}`).join(', ')}}`
  }
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : printFloat(v)
  return String(v)
}

function toNum(v: VMValue): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') return v.length > 0 ? v.charCodeAt(0) : 0
  return 0
}

/**
 * Serial.print(value[, fmt]) text. `type` is the static type of `value`; `fmt` is the
 * base for integers (DEC/HEX/OCT/BIN) or the digit count for floats.
 * 'any' falls back to the runtime value: integers print as int, others as float.
 */
export function formatPrint(value: VMValue, type: ValueType, fmt?: number): string {
  const hasFmt = typeof fmt === 'number' && Number.isFinite(fmt)
  let t = type
  if (t === 'any' || t === 'void') {
    if (typeof value === 'string') t = 'string'
    else if (typeof value === 'boolean') t = 'bool'
    else if (typeof value === 'number') t = Number.isInteger(value) ? 'long' : 'double'
    else return printComposite(value)
  }
  switch (t) {
    case 'string':
      return typeof value === 'string' ? value : printComposite(value)
    case 'char':
      return hasFmt ? printLong(toNum(value), fmt) : String.fromCharCode(toNum(value) & 0xff)
    case 'bool':
      return hasFmt ? printLong(toNum(value), fmt) : toNum(value) !== 0 ? '1' : '0'
    case 'float':
    case 'double':
      return printFloat(toNum(value), hasFmt ? fmt : 2)
    case 'unsigned':
      // Print::print(unsigned long, base): base 0 writes the byte
      return hasFmt && fmt === 0 ? String.fromCharCode(toNum(value) & 0xff) : printNumber(toNum(value), hasFmt ? fmt : DEC)
    default:
      return isIntegral(t) ? printLong(toNum(value), hasFmt ? fmt : DEC) : printComposite(value)
  }
}

/* ---------------- printf subset ---------------- */

interface Spec {
  flags: string
  width: number
  prec: number | null
  conv: string
}

const SPEC = /%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d*))?(hh|h|ll|l|z|j|t|L)?([diuxXocsfFeEgGp%])/g

/** `zeroPad`: the '0' flag applies (C ignores it for integers with a precision, never for floats). */
function pad(body: string, s: Spec, zeroPad: boolean): string {
  if (body.length >= s.width) return body
  if (s.flags.includes('-')) return body.padEnd(s.width, ' ')
  if (zeroPad && s.flags.includes('0')) {
    const sign = /^[+\- ]/.test(body) ? body[0] : ''
    const prefix = /^[+\- ]?0[xX]/.test(body) ? body.slice(sign.length, sign.length + 2) : ''
    const digits = body.slice(sign.length + prefix.length)
    return sign + prefix + digits.padStart(s.width - sign.length - prefix.length, '0')
  }
  return body.padStart(s.width, ' ')
}

function signed(n: number, s: Spec): string {
  if (n < 0) return ''
  if (s.flags.includes('+')) return '+'
  if (s.flags.includes(' ')) return ' '
  return ''
}

function fmtInt(v: number, s: Spec): string {
  const isSigned = s.conv === 'd' || s.conv === 'i'
  const n = Math.trunc(v)
  const base = s.conv === 'x' || s.conv === 'X' ? 16 : s.conv === 'o' ? 8 : 10
  let digits = isSigned ? String(Math.abs(n | 0)) : (n >>> 0).toString(base)
  if (s.conv === 'X') digits = digits.toUpperCase()
  if (s.prec !== null) digits = s.prec === 0 && n === 0 ? '' : digits.padStart(s.prec, '0')
  let prefix = ''
  if (s.flags.includes('#') && n !== 0) prefix = s.conv === 'o' ? '0' : s.conv === 'x' ? '0x' : s.conv === 'X' ? '0X' : ''
  const sign = isSigned ? ((n | 0) < 0 ? '-' : signed(n, s)) : ''
  return pad(sign + prefix + digits, s, s.prec === null)
}

function fmtFloat(v: number, s: Spec): string {
  const p = s.prec ?? 6
  if (!Number.isFinite(v)) {
    const txt = Number.isNaN(v) ? 'nan' : v < 0 ? '-inf' : `${signed(1, s)}inf`
    return pad(s.conv === s.conv.toUpperCase() ? txt.toUpperCase() : txt, s, false)
  }
  let body: string
  const c = s.conv.toLowerCase()
  if (c === 'f') body = Math.abs(v).toFixed(Math.min(p, 100))
  else if (c === 'e') body = expForm(Math.abs(v), p)
  else body = gForm(Math.abs(v), p === 0 ? 1 : p, s.flags.includes('#'))
  if (s.conv === s.conv.toUpperCase()) body = body.toUpperCase()
  const sign = v < 0 || Object.is(v, -0) ? '-' : signed(v, s)
  return pad(sign + body, s, true)
}

/** C %e: mantissa, 'e', sign, at least two exponent digits. */
function expForm(v: number, p: number): string {
  const [m, e] = v.toExponential(Math.min(p, 100)).split('e')
  const exp = Number(e)
  return `${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
}

function gForm(v: number, p: number, keepZeros: boolean): string {
  if (v === 0) return keepZeros ? (0).toFixed(p - 1) : '0'
  // C picks the style from the exponent AFTER rounding to p digits (999999.5 -> 1e+06)
  const exp = Number(v.toExponential(Math.min(p - 1, 100)).split('e')[1])
  let out = exp < -4 || exp >= p ? expForm(v, p - 1) : v.toFixed(Math.max(p - 1 - exp, 0))
  if (!keepZeros) {
    out = out.includes('e')
      ? out.replace(/\.?0+e/, 'e')
      : out.includes('.') ? out.replace(/\.?0+$/, '') : out
  }
  return out
}

function argNum(v: VMValue | undefined): number {
  return v === undefined ? 0 : toNum(v)
}

function convert(s: Spec, arg: VMValue | undefined): string {
  switch (s.conv) {
    case 'd': case 'i': case 'u': case 'x': case 'X': case 'o':
      return fmtInt(argNum(arg), s)
    case 'c':
      return pad(typeof arg === 'string' ? arg.slice(0, 1) : String.fromCharCode(argNum(arg) & 0xff), s, false)
    case 's': {
      const txt = arg === undefined ? '(null)' : typeof arg === 'string' ? arg : printComposite(arg)
      return pad(s.prec === null ? txt : txt.slice(0, s.prec), s, false)
    }
    case 'p':
      return pad(`0x${(argNum(arg) >>> 0).toString(16)}`, s, false)
    default:
      return fmtFloat(argNum(arg), s)
  }
}

/** C printf subset: flags - + space 0 #, width and precision (also '*'), length modifiers ignored. */
export function formatPrintf(fmt: string, args: readonly VMValue[]): string {
  let i = 0
  const next = (): VMValue | undefined => args[i++]
  return fmt.replace(SPEC, (_m, flags: string, w: string | undefined, p: string | undefined, _len: string | undefined, conv: string) => {
    if (conv === '%') return '%'
    let width = w === '*' ? argNum(next()) : w ? Number(w) : 0
    let fl = flags
    if (width < 0) {
      fl += '-'
      width = -width
    }
    const prec = p === undefined ? null : p === '*' ? Math.max(0, argNum(next())) : Number(p || '0')
    return convert({ flags: fl, width: Math.min(width, 256), prec: prec === null ? null : Math.min(prec, 100), conv }, next())
  })
}
