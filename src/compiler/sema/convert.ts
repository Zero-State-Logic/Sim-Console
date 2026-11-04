/* ============================================================
   CONVERSIONS — implicit and explicit C++ conversions as typed-IR
   nodes. Numeric conversions fold on constants. String rules follow
   Arduino's WString.h: const char* → String is implicit, number →
   String needs an explicit String(x) (its constructors are explicit).
   ============================================================ */

import { convertNumber, formatFloat } from '../arith'
import { StrKind } from '../bytecode'
import { isArithmetic, isCharArray, isFloating, isInteger, sameType, T, typeName, type CType } from '../ctypes'
import type { Span } from '../diagnostics'
import type { TExpr } from '../tir'
import type { Sema } from './context'

export type ConvCtx = 'assign' | 'init' | 'arg' | 'return' | 'cast'

export function constNum(ty: CType, value: number, span: Span): TExpr {
  return { k: 'const', ty, value, span }
}

export function constStr(value: string, span: Span, ty: CType = T.cstr): TExpr {
  return { k: 'const', ty, value, span }
}

/** A value that is already a fresh object (no copy needed to keep value semantics). */
function isFresh(e: TExpr): boolean {
  return e.k === 'call' || e.k === 'copy' || e.k === 'newobj' || e.k === 'native' || e.k === 'aggregate'
}

export function copyIfNeeded(e: TExpr): TExpr {
  if (e.ty.t !== 'struct' || isFresh(e)) return e
  return { k: 'copy', ty: e.ty, e, span: e.span }
}

/** Numeric conversion node (folded when the operand is a constant). */
export function numConvert(cx: Sema, e: TExpr, to: CType): TExpr {
  if (sameType(e.ty, to)) return e
  if (e.k === 'const' && typeof e.value === 'number' && to.t === 'prim') {
    return constNum(to, convertNumber(e.value, to.p, cx.intBits, isFloating(e.ty)), e.span)
  }
  return { k: 'convert', ty: to, from: e.ty, e, span: e.span }
}

export function strKind(ty: CType): number {
  if (ty.t !== 'prim') return StrKind.INT
  if (ty.p === 'char') return StrKind.CHAR
  if (ty.p === 'float' || ty.p === 'double') return StrKind.FLOAT
  if (ty.p === 'bool' || ty.p === 'uchar' || ty.p === 'ushort' || ty.p === 'uint' || ty.p === 'ulong') return StrKind.UINT
  return StrKind.INT
}

/** Any printable value to a String (the String + x and String(x) rules). */
export function toStringExpr(cx: Sema, e: TExpr, span: Span): TExpr {
  if (e.ty.t === 'error') return e
  if (e.ty.t === 'prim' && (e.ty.p === 'string' || e.ty.p === 'cstr')) return retypeString(e)
  if (isCharArray(e.ty)) return { k: 'chars2str', ty: T.string, e, span }
  if (isArithmetic(e.ty)) {
    if (e.k === 'const' && typeof e.value === 'number') {
      return { k: 'const', ty: T.string, value: formatConst(e.value, strKind(e.ty)), span }
    }
    return { k: 'tostr', ty: T.string, kind: strKind(e.ty), e, span }
  }
  cx.error(span, `Cannot convert '${typeName(e.ty)}' to String`)
  return { ...e, ty: T.error } as TExpr
}

function formatConst(v: number, kind: number): string {
  if (kind === StrKind.CHAR) return String.fromCharCode(v & 0xff)
  if (kind === StrKind.FLOAT) return formatFloat(v, 2)
  return String(v)
}

function retypeString(e: TExpr): TExpr {
  if (e.ty.t === 'prim' && e.ty.p === 'string') return e
  if (e.k === 'const') return { ...e, ty: T.string }
  return { k: 'convert', ty: T.string, from: e.ty, e, span: e.span }
}

/** Implicit (or explicit, ctx 'cast') conversion of `e` to `to`. Reports errors. */
export function convertTo(cx: Sema, e: TExpr, to: CType, span: Span, ctx: ConvCtx): TExpr {
  const from = e.ty
  if (from.t === 'error' || to.t === 'error') return e
  if (from.t === 'prim' && from.p === 'void') {
    cx.error(span, 'A void value cannot be used here (the function returns nothing)')
    return { ...e, ty: T.error } as TExpr
  }
  if (isArithmetic(from) && isArithmetic(to)) return numConvert(cx, e, to)
  if (to.t === 'prim' && to.p === 'string') return toStringTarget(cx, e, span, ctx)
  if (to.t === 'prim' && to.p === 'cstr') {
    if (from.t === 'prim' && from.p === 'cstr') return e
    if (isCharArray(from)) return { k: 'chars2str', ty: T.cstr, e, span }
    if (from.t === 'prim' && from.p === 'string') cx.error(span, "Cannot convert 'String' to 'const char*'. Use s.c_str()")
    else cx.error(span, `Cannot convert '${typeName(from)}' to 'const char*'`)
    return { ...e, ty: T.error } as TExpr
  }
  if (to.t === 'prim' && to.p === 'bool' && (from.t === 'object' || from.t === 'native')) return constNum(T.bool, 1, span)
  if (sameType(from, to) && from.t !== 'array') return ctx === 'cast' || ctx === 'assign' ? e : copyIfNeeded(e)
  if (from.t === 'array' && to.t === 'array') return arrayConvert(cx, e, to, span, ctx)
  convertError(cx, from, to, span, ctx)
  return { ...e, ty: T.error } as TExpr
}

function toStringTarget(cx: Sema, e: TExpr, span: Span, ctx: ConvCtx): TExpr {
  const from = e.ty
  if (from.t === 'prim' && (from.p === 'string' || from.p === 'cstr')) return retypeString(e)
  if (isCharArray(from)) return { k: 'chars2str', ty: T.string, e, span }
  if (isArithmetic(from)) {
    if (ctx === 'cast') return toStringExpr(cx, e, span)
    cx.error(span, `Cannot convert '${typeName(from)}' to 'String' implicitly (String's number constructors are explicit). Write String(value)`)
    return { ...e, ty: T.error } as TExpr
  }
  convertError(cx, from, T.string, span, ctx)
  return { ...e, ty: T.error } as TExpr
}

function arrayConvert(cx: Sema, e: TExpr, to: CType & { t: 'array' }, span: Span, ctx: ConvCtx): TExpr {
  const from = e.ty as CType & { t: 'array' }
  if (ctx !== 'arg') {
    cx.error(span, 'Arrays cannot be assigned or copied as a whole; copy them element by element in a loop')
    return { ...e, ty: T.error } as TExpr
  }
  // C ignores the outermost dimension of an array parameter; inner ones must match
  if (sameType(from.elem, to.elem) && (to.len < 0 || to.len === from.len)) return e
  if (sameType(from.elem, to.elem)) {
    cx.warning(span, `Passing '${typeName(from)}' to a '${typeName(to)}' parameter`)
    return e
  }
  cx.error(span, `Cannot pass '${typeName(from)}' as '${typeName(to)}' (element types differ)`)
  return { ...e, ty: T.error } as TExpr
}

function convertError(cx: Sema, from: CType, to: CType, span: Span, ctx: ConvCtx): void {
  const f = typeName(from)
  const t = typeName(to)
  if (from.t === 'prim' && (from.p === 'string' || from.p === 'cstr') && isArithmetic(to)) {
    cx.error(span, `Cannot convert '${f}' to '${t}'. Use .toInt() or .toFloat() on a String`)
  } else if (from.t === 'object') {
    cx.error(span, `'${f}' is a built-in object and cannot be used as a value of type '${t}'`)
  } else if (from.t === 'native' && to.t !== 'native') {
    cx.error(span, `Cannot use a '${f}' object as '${t}'`)
  } else {
    const verb = ctx === 'arg' ? 'pass' : ctx === 'return' ? 'return' : 'convert'
    cx.error(span, `Cannot ${verb} '${f}' as '${t}'`)
  }
}

/** Condition context (if / while / for / ! / && / || / ?:): anything scalar becomes bool. */
export function toCondition(cx: Sema, e: TExpr, span: Span): TExpr {
  const ty = e.ty
  if (ty.t === 'error') return e
  if (ty.t === 'prim' && ty.p === 'bool') return e
  if (isInteger(ty) || isFloating(ty)) return numConvert(cx, e, T.bool)
  if (ty.t === 'object' || (ty.t === 'prim' && (ty.p === 'cstr' || ty.p === 'string')) || ty.t === 'native') {
    return e.k === 'const' || e.k === 'load' ? constNum(T.bool, 1, span) : { k: 'comma', ty: T.bool, a: e, b: constNum(T.bool, 1, span), span }
  }
  if (ty.t === 'prim' && ty.p === 'void') cx.error(span, 'A void value cannot be used as a condition')
  else cx.error(span, `Cannot use '${typeName(ty)}' as a condition`)
  return { ...e, ty: T.error } as TExpr
}
