/* ============================================================
   BINARY OPERATORS — typing by the usual arithmetic conversions,
   String concatenation and comparison, pointer arithmetic on a
   string literal (with a warning), and constant folding with
   C semantics (including signed-overflow warnings, which matter
   on 16-bit AVR where 1000 * 1000 silently wraps).
   ============================================================ */

import { arith, type ArithOp } from '../arith'
import { commonType, intInfo, isArithmetic, isCharArray, isFloating, isInteger, promote, T, typeName, type CType } from '../ctypes'
import type { Binary } from '../ast'
import type { Span } from '../diagnostics'
import type { CmpOp, TExpr } from '../tir'
import type { Sema } from './context'
import { constNum, numConvert, toCondition, toStringExpr } from './convert'

const CMP = new Set(['<', '<=', '>', '>=', '==', '!='])

export function checkBinaryOp(cx: Sema, e: Binary, l: TExpr, r: TExpr): TExpr {
  const op = e.op
  if (l.ty.t === 'error' || r.ty.t === 'error') return { k: 'const', ty: T.error, value: 0, span: e.span }
  if (op === '&&' || op === '||') return logic(cx, op, l, r, e.span)
  if (CMP.has(op)) return compare(cx, op as CmpOp, l, r, e)
  if (op === '+' && (isStringT(l.ty) || isStringT(r.ty))) return concat(cx, l, r, e.span)
  if ((op === '+' || op === '-') && (isTextPtr(l.ty) || isTextPtr(r.ty))) return pointerArith(cx, op, l, r, e)
  return arithmetic(cx, op as ArithOp, l, r, e)
}

function isStringT(ty: CType): boolean {
  return ty.t === 'prim' && ty.p === 'string'
}

function isTextPtr(ty: CType): boolean {
  return (ty.t === 'prim' && ty.p === 'cstr') || isCharArray(ty)
}

function logic(cx: Sema, op: '&&' | '||', l: TExpr, r: TExpr, span: Span): TExpr {
  const a = toCondition(cx, l, l.span)
  const b = toCondition(cx, r, r.span)
  if (a.k === 'const' && typeof a.value === 'number') {
    const short = op === '&&' ? a.value === 0 : a.value !== 0
    if (short) return constNum(T.bool, a.value === 0 ? 0 : 1, span)
    if (b.k === 'const') return b
  }
  return { k: 'logic', ty: T.bool, op, l: a, r: b, span }
}

function compare(cx: Sema, op: CmpOp, l: TExpr, r: TExpr, e: Binary): TExpr {
  if (isStringT(l.ty) || isStringT(r.ty) || (isTextPtr(l.ty) && isTextPtr(r.ty))) {
    if (!isStringT(l.ty) && !isStringT(r.ty)) {
      cx.warning(e.opSpan, "Comparing two C strings with '" + op + "' compares addresses in C++; the simulator compares the text. Use String or strcmp()")
    }
    const a = toStringExpr(cx, l, l.span)
    const b = toStringExpr(cx, r, r.span)
    if (a.ty.t === 'error' || b.ty.t === 'error') return constNum(T.error, 0, e.span)
    if (!isTextish(l.ty) || !isTextish(r.ty)) {
      cx.error(e.opSpan, `Cannot compare '${typeName(l.ty)}' with '${typeName(r.ty)}'`)
      return constNum(T.error, 0, e.span)
    }
    return { k: 'cmp', ty: T.bool, op, opTy: T.string, l: a, r: b, span: e.span }
  }
  if (!isArithmetic(l.ty) || !isArithmetic(r.ty)) {
    const charVsText = (isArithmetic(l.ty) && isTextPtr(r.ty)) || (isArithmetic(r.ty) && isTextPtr(l.ty))
    const hint = charVsText ? ". For a single character use single quotes, e.g. 'a'" : ''
    cx.error(e.opSpan, `Cannot compare '${typeName(l.ty)}' with '${typeName(r.ty)}' using '${op}'${hint}`)
    return constNum(T.error, 0, e.span)
  }
  const ty = commonType(l.ty, r.ty, cx.intBits)
  const a = numConvert(cx, l, ty)
  const b = numConvert(cx, r, ty)
  unsignedZeroWarning(cx, op, l, b, e)
  if (a.k === 'const' && b.k === 'const' && typeof a.value === 'number' && typeof b.value === 'number') {
    return constNum(T.bool, cmpValues(op, a.value, b.value) ? 1 : 0, e.span)
  }
  return { k: 'cmp', ty: T.bool, op, opTy: ty, l: a, r: b, span: e.span }
}

/** `u >= 0` is always true and `u < 0` always false for unsigned u (a classic count-down bug). */
function unsignedZeroWarning(cx: Sema, op: CmpOp, left: TExpr, zero: TExpr, e: Binary): void {
  const info = left.ty.t === 'prim' && left.ty.p !== 'bool' ? intInfo(left.ty.p, cx.intBits) : null
  if (!info || info.signed || left.k === 'const' || zero.k !== 'const' || zero.value !== 0) return
  if (op === '>=') cx.warning(e.opSpan, "This comparison is always true: an unsigned value is never negative (a loop counting down with 'i >= 0' never ends). Use a signed type")
  else if (op === '<') cx.warning(e.opSpan, 'This comparison is always false: an unsigned value is never negative')
}

function isTextish(ty: CType): boolean {
  return (ty.t === 'prim' && (ty.p === 'string' || ty.p === 'cstr' || ty.p === 'char')) || isCharArray(ty)
}

export function cmpValues(op: CmpOp, a: number, b: number): boolean {
  switch (op) {
    case '<': return a < b
    case '<=': return a <= b
    case '>': return a > b
    case '>=': return a >= b
    case '==': return a === b
    default: return a !== b
  }
}

function concat(cx: Sema, l: TExpr, r: TExpr, span: Span): TExpr {
  const a = toStringExpr(cx, l, l.span)
  const b = toStringExpr(cx, r, r.span)
  if (a.ty.t === 'error' || b.ty.t === 'error') return constNum(T.error, 0, span)
  if (a.k === 'const' && b.k === 'const') return { k: 'const', ty: T.string, value: String(a.value) + String(b.value), span }
  return { k: 'concat', ty: T.string, l: a, r: b, span }
}

function pointerArith(cx: Sema, op: string, l: TExpr, r: TExpr, e: Binary): TExpr {
  const textLeft = isTextPtr(l.ty)
  const text = textLeft ? l : r
  const n = textLeft ? r : l
  if (isTextPtr(n.ty)) {
    cx.error(e.opSpan, `Cannot ${op === '+' ? 'add' : 'subtract'} two C strings. To join text use String: String("a") + "b"`)
    return constNum(T.error, 0, e.span)
  }
  if (!isInteger(n.ty) || (op === '-' && !textLeft)) {
    cx.error(e.opSpan, `Invalid operands to '${op}': '${typeName(l.ty)}' and '${typeName(r.ty)}'`)
    return constNum(T.error, 0, e.span)
  }
  cx.warning(e.opSpan, `'${op}' on a C string moves the pointer instead of joining text (the result skips characters). To join text, use String("text") + value`)
  const s = text.ty.t === 'prim' ? text : { k: 'chars2str' as const, ty: T.cstr, e: text, span: text.span }
  const count = numConvert(cx, n, T.int)
  const signed = op === '-' ? ({ k: 'unary', ty: T.int, op: 'neg', e: count, span: count.span } as TExpr) : count
  return { k: 'ptrAdd', ty: T.cstr, s, n: signed, site: cx.site(e.span, 'string'), span: e.span }
}

function arithmetic(cx: Sema, op: ArithOp, l: TExpr, r: TExpr, e: Binary): TExpr {
  if (!isArithmetic(l.ty) || !isArithmetic(r.ty)) {
    cx.error(e.opSpan, `Invalid operands to '${op}': '${typeName(l.ty)}' and '${typeName(r.ty)}'`)
    return constNum(T.error, 0, e.span)
  }
  const intOnly = op === '%' || op === '&' || op === '|' || op === '^' || op === '<<' || op === '>>'
  if (intOnly && (isFloating(l.ty) || isFloating(r.ty))) {
    const hint = op === '%' ? '. Use fmod(a, b) for floating-point remainder' : ''
    cx.error(e.opSpan, `Invalid operands to '${op}': it needs integers, got '${typeName(l.ty)}' and '${typeName(r.ty)}'${hint}`)
    return constNum(T.error, 0, e.span)
  }
  const shift = op === '<<' || op === '>>'
  const ty = shift ? promote(l.ty, cx.intBits) : commonType(l.ty, r.ty, cx.intBits)
  const a = numConvert(cx, l, ty)
  const b = numConvert(cx, r, shift ? promote(r.ty, cx.intBits) : ty)
  if (shift && b.k === 'const' && typeof b.value === 'number') shiftWarnings(cx, b.value, ty, e)
  const folded = foldArith(cx, op, a, b, ty, e)
  if (folded) return folded
  const needsSite = (op === '/' || op === '%') && isInteger(ty)
  return { k: 'binary', ty, op, l: a, r: b, site: needsSite ? cx.site(e.opSpan, op) : -1, span: e.span }
}

function shiftWarnings(cx: Sema, count: number, ty: CType, e: Binary): void {
  const info = ty.t === 'prim' ? intInfo(ty.p, cx.intBits) : null
  if (count < 0) cx.warning(e.opSpan, 'Shift count is negative')
  else if (info && count >= info.bits) cx.warning(e.opSpan, `Shift count ${count} >= width of '${typeName(ty)}' (${info.bits} bits)`)
}

function foldArith(cx: Sema, op: ArithOp, a: TExpr, b: TExpr, ty: CType, e: Binary): TExpr | null {
  if (a.k !== 'const' || b.k !== 'const' || typeof a.value !== 'number' || typeof b.value !== 'number') {
    if ((op === '/' || op === '%') && isInteger(ty) && b.k === 'const' && b.value === 0) cx.warning(e.opSpan, 'Division by zero')
    return null
  }
  const v = arith(op, a.value, b.value, ty, cx.intBits)
  if (v === null) {
    cx.warning(e.opSpan, 'Division by zero')
    return null
  }
  overflowWarning(cx, op, a.value, b.value, v, ty, e)
  return constNum(ty, v, e.span)
}

function overflowWarning(cx: Sema, op: ArithOp, a: number, b: number, v: number, ty: CType, e: Binary): void {
  if (ty.t !== 'prim' || (op !== '+' && op !== '-' && op !== '*' && op !== '<<')) return
  const info = intInfo(ty.p, cx.intBits)
  if (!info || !info.signed) return
  const exact = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a * 2 ** b
  if (exact === v) return
  const suffix = cx.intBits === 16 && ty.p === 'int' ? ' On a 16-bit board, write one operand as a long (e.g. 1000L)' : ''
  cx.warning(e.span, `Integer overflow: the result does not fit in ${info.bits}-bit '${typeName(ty)}' and wraps to ${v}.${suffix}`)
}
