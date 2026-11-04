/* ============================================================
   ARDUINO MACROS AND MATH TABLE — min/max/abs/constrain/sq/
   radians/degrees/bit* (bitToggle too) / highByte / lowByte (and round on AVR)
   are macros in Arduino.h, so they expand into ordinary
   expressions here: the result type and double evaluation of
   arguments match the real board.
   ============================================================ */

import type { Expr } from '../ast'
import { B } from '../builtins'
import type { Span } from '../diagnostics'
import { typeSpecOf } from '../parser/expr'
import { table } from '../tables'
import type { Sema } from './context'

export interface MathDef {
  id: number
  argc: number
  param: 'double' | 'int'
  ret: 'double' | 'bool' | 'int'
}

const m = (id: number, argc: number, param: MathDef['param'] = 'double', ret: MathDef['ret'] = 'double'): MathDef => ({ id, argc, param, ret })

export const MATH: Readonly<Record<string, MathDef>> = table({
  sqrt: m(B.SQRT, 1), pow: m(B.POW, 2), sin: m(B.SIN, 1), cos: m(B.COS, 1), tan: m(B.TAN, 1),
  asin: m(B.ASIN, 1), acos: m(B.ACOS, 1), atan: m(B.ATAN, 1), atan2: m(B.ATAN2, 2), exp: m(B.EXP, 1),
  log: m(B.LOG, 1), log10: m(B.LOG10, 1), floor: m(B.FLOOR, 1), ceil: m(B.CEIL, 1), round: m(B.ROUND, 1),
  fabs: m(B.FABS, 1), fmod: m(B.FMOD, 2), hypot: m(B.HYPOT, 2), trunc: m(B.TRUNC, 1), fmin: m(B.FMIN, 2),
  fmax: m(B.FMAX, 2), cbrt: m(B.CBRT, 1),
  sqrtf: m(B.SQRT, 1), sinf: m(B.SIN, 1), cosf: m(B.COS, 1), atan2f: m(B.ATAN2, 2), fabsf: m(B.FABS, 1),
  isDigit: m(B.C_ISDIGIT, 1, 'int', 'bool'), isAlpha: m(B.C_ISALPHA, 1, 'int', 'bool'),
  isAlphaNumeric: m(B.C_ISALNUM, 1, 'int', 'bool'), isSpace: m(B.C_ISSPACE, 1, 'int', 'bool'),
  isWhitespace: m(B.C_ISWHITESPACE, 1, 'int', 'bool'), isUpperCase: m(B.C_ISUPPER, 1, 'int', 'bool'),
  isLowerCase: m(B.C_ISLOWER, 1, 'int', 'bool'), isPunct: m(B.C_ISPUNCT, 1, 'int', 'bool'),
  isHexadecimalDigit: m(B.C_ISXDIGIT, 1, 'int', 'bool'), isPrintable: m(B.C_ISPRINT, 1, 'int', 'bool'),
  isControl: m(B.C_ISCONTROL, 1, 'int', 'bool'), isAscii: m(B.C_ISASCII, 1, 'int', 'bool'),
  isGraph: m(B.C_ISGRAPH, 1, 'int', 'bool'), toUpperCase: m(B.C_TOUPPER, 1, 'int', 'int'),
  toLowerCase: m(B.C_TOLOWER, 1, 'int', 'int'), toupper: m(B.C_TOUPPER, 1, 'int', 'int'),
  tolower: m(B.C_TOLOWER, 1, 'int', 'int'), isdigit: m(B.C_ISDIGIT, 1, 'int', 'int'),
  isalpha: m(B.C_ISALPHA, 1, 'int', 'int'), isspace: m(B.C_ISSPACE, 1, 'int', 'int'),
  isupper: m(B.C_ISUPPER, 1, 'int', 'int'), islower: m(B.C_ISLOWER, 1, 'int', 'int'),
  isxdigit: m(B.C_ISXDIGIT, 1, 'int', 'int'), isalnum: m(B.C_ISALNUM, 1, 'int', 'int'),
})

const ARITY: Readonly<Record<string, number>> = table({
  min: 2, max: 2, abs: 1, constrain: 3, sq: 1, radians: 1, degrees: 1, round: 1,
  bitRead: 2, bitSet: 2, bitClear: 2, bitToggle: 2, bitWrite: 3, bit: 1, highByte: 1, lowByte: 1,
})

/** Every function name the VM or the macro expander provides (for messages and suggestions). */
export const BUILTIN_NAMES: readonly string[] = [
  ...Object.keys(MATH), ...Object.keys(ARITY),
  'delay', 'delayMicroseconds', 'yield', 'millis', 'micros', 'random', 'randomSeed', 'map', 'isnan', 'isinf', 'strlen', 'F',
]

export function isMacroBuiltin(name: string, intBits: number): boolean {
  if (name === 'round') return intBits === 16
  return ARITY[name] !== undefined
}

/** Builds the macro's expansion as AST (or reports an arity error and returns null). */
export function expandMacro(cx: Sema, name: string, a: Expr[], span: Span): Expr | null {
  const want = ARITY[name]
  if (a.length !== want) {
    cx.error(span, `${name}() takes ${want} argument${want === 1 ? '' : 's'}, got ${a.length}`)
    return null
  }
  const bin = (op: string, l: Expr, r: Expr): Expr => ({ kind: 'binary', span, op, left: l, right: r, opSpan: span })
  const tern = (c: Expr, x: Expr, y: Expr): Expr => ({ kind: 'ternary', span, cond: c, a: x, b: y })
  const int = (v: number, ul = false): Expr => ({ kind: 'int', span, value: v, unsigned: ul, long: ul, radix: 10 })
  const id = (n: string): Expr => ({ kind: 'ident', span, name: n })
  const cast = (type: string, e: Expr): Expr => ({ kind: 'cast', span, type: typeSpecOf(type, span, false), expr: e })
  const assign = (op: string, t: Expr, v: Expr): Expr => ({ kind: 'assign', span, op, target: t, value: v, opSpan: span })
  const bitMask = (b: Expr): Expr => bin('<<', int(1, true), b)
  switch (name) {
    case 'min': return tern(bin('<', a[0], a[1]), a[0], a[1])
    case 'max': return tern(bin('>', a[0], a[1]), a[0], a[1])
    case 'abs': return tern(bin('>', a[0], int(0)), a[0], { kind: 'unary', span, op: '-', expr: a[0] })
    case 'constrain': return tern(bin('<', a[0], a[1]), a[1], tern(bin('>', a[0], a[2]), a[2], a[0]))
    case 'sq': return bin('*', a[0], a[0])
    case 'radians': return bin('*', a[0], id('DEG_TO_RAD'))
    case 'degrees': return bin('*', a[0], id('RAD_TO_DEG'))
    case 'round': {
      const half: Expr = { kind: 'float', span, value: 0.5, f32: false }
      return tern(bin('>=', a[0], int(0)), cast('long', bin('+', a[0], half)), cast('long', bin('-', a[0], half)))
    }
    case 'bitRead': return bin('&', bin('>>', a[0], a[1]), int(1))
    case 'bitSet': return assign('|=', a[0], bitMask(a[1]))
    case 'bitClear': return assign('&=', a[0], { kind: 'unary', span, op: '~', expr: bitMask(a[1]) })
    case 'bitToggle': return assign('^=', a[0], bitMask(a[1]))
    case 'bitWrite': return tern(a[2], assign('|=', a[0], bitMask(a[1])), assign('&=', a[0], { kind: 'unary', span, op: '~', expr: bitMask(a[1]) }))
    case 'bit': return bitMask(a[0])
    case 'highByte': return cast('uint8_t', bin('>>', a[0], int(8)))
    case 'lowByte': return cast('uint8_t', bin('&', a[0], int(0xff)))
    default: return null
  }
}
