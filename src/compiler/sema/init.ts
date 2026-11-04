/* ============================================================
   INITIALIZERS — `= expr`, `= { ... }` with C brace elision
   (`int m[2][3] = {1,2,3,4,5,6}` works), `char s[] = "hi"`,
   `Servo s(9)`, `int x(5)`, struct default member initialisers,
   and folding of constant tables into one constant (a gait
   table becomes a single CLONE_K at run time).
   ============================================================ */

import type { Expr, InitListExpr } from '../ast'
import type { ConstValue } from '../bytecode'
import { arrayOf, isCharArray, T, typeName, type CType } from '../ctypes'
import type { Span } from '../diagnostics'
import type { TExpr, TInit } from '../tir'
import type { Sema } from './context'
import { convertTo } from './convert'
import { checkExpr, errExpr } from './exprs'
import { nativeCtor } from './calls'

interface Cursor {
  items: Expr[]
  i: number
}

export interface InitResult {
  init: TInit
  /** The declared type with an unsized first dimension completed. */
  ty: CType
}

function isAggregate(ty: CType): boolean {
  return ty.t === 'array' || ty.t === 'struct'
}

export function checkInit(cx: Sema, ty: CType, init: Expr | null, ctorArgs: Expr[] | null, span: Span, name: string): InitResult {
  if (ty.t === 'error') return { init: { k: 'default', ty }, ty }
  if (ty.t === 'native') return { init: nativeInit(cx, ty.cls, init, ctorArgs, span, name), ty }
  if (ctorArgs) {
    if (isAggregate(ty)) {
      cx.error(span, `'${name}' cannot be initialised with ( ... ); use = { ... }`)
      return { init: { k: 'default', ty }, ty }
    }
    if (ctorArgs.length !== 1) {
      cx.error(span, `'${name}' needs exactly one initial value`)
      return { init: { k: 'default', ty }, ty }
    }
    return { init: exprInit(cx, ty, ctorArgs[0]), ty }
  }
  if (!init) {
    if (ty.t === 'array' && ty.len < 0) {
      cx.error(span, `Array '${name}' needs a size or an initializer list`)
      return { init: { k: 'default', ty: T.error }, ty: T.error }
    }
    return { init: defaultInit(cx, ty), ty }
  }
  if (ty.t === 'array') return arrayInit(cx, ty, init, name)
  if (init.kind === 'initList') return { init: braceInit(cx, ty, init), ty }
  return { init: exprInit(cx, ty, init), ty }
}

function nativeInit(cx: Sema, cls: string, init: Expr | null, ctorArgs: Expr[] | null, span: Span, name: string): TInit {
  if (ctorArgs && ctorArgs.length === 0) {
    cx.warning(span, `'${cls} ${name}()' is read as an object here, but in standard C++ it declares a function. Write '${cls} ${name};'`)
  }
  if (init && init.kind !== 'initList') {
    const e = checkExpr(cx, init)
    if (e.ty.t === 'error') return { k: 'default', ty: T.error }
    return { k: 'expr', e: convertTo(cx, e, { t: 'native', cls }, init.span, 'init') }
  }
  const args = init && init.kind === 'initList' ? init.items : ctorArgs ?? []
  const c = nativeCtor(cx, cls, args, span)
  if (c.k !== 'construct') return { k: 'default', ty: T.error }
  return { k: 'ctor', ty: c.ty, cls: c.cls, args: c.args }
}

function exprInit(cx: Sema, ty: CType, e: Expr): TInit {
  const v = checkExpr(cx, e)
  if (v.ty.t === 'error') return { k: 'default', ty }
  return { k: 'expr', e: convertTo(cx, v, ty, e.span, 'init') }
}

/** Zero / empty value, honouring struct default member initialisers. */
export function defaultInit(cx: Sema, ty: CType): TInit {
  if (ty.t === 'struct') {
    const info = cx.structs[ty.id]
    if (info.fields.some((f) => f.init)) {
      return { k: 'list', ty, items: info.fields.map((f) => (f.init ? fieldDefault(cx, f.ty, f.init) : defaultInit(cx, f.ty))) }
    }
  }
  return { k: 'default', ty }
}

function fieldDefault(cx: Sema, ty: CType, init: Expr): TInit {
  if (init.kind === 'initList') return braceInit(cx, ty, init)
  if (ty.t === 'array' && init.kind === 'string') return charsInit(cx, ty, init.value, init.span)
  return exprInit(cx, ty, init)
}

function arrayInit(cx: Sema, ty: CType & { t: 'array' }, init: Expr, name: string): InitResult {
  if (init.kind === 'string' && isCharArray(ty)) {
    const len = ty.len < 0 ? init.value.length + 1 : ty.len
    const full = arrayOf(ty.elem, len)
    return { init: charsInit(cx, full as CType & { t: 'array' }, init.value, init.span), ty: full }
  }
  if (init.kind !== 'initList') {
    const e = checkExpr(cx, init)
    if (e.ty.t !== 'error') cx.error(init.span, `Array '${name}' must be initialised with a brace list { ... }, not with '${typeName(e.ty)}'`)
    return { init: { k: 'default', ty }, ty }
  }
  const items = listItems(cx, ty, init)
  const full = ty.len < 0 ? arrayOf(ty.elem, Math.max(items.length, 1)) : ty
  if (ty.len < 0 && items.length === 0) cx.error(init.span, `Array '${name}' with an empty initializer needs an explicit size`)
  return { init: finish(cx, full, items), ty: full }
}

function charsInit(cx: Sema, ty: CType & { t: 'array' }, text: string, span: Span): TInit {
  if (text.length + 1 > ty.len) {
    if (text.length > ty.len) cx.error(span, `String "${text}" is too long for 'char[${ty.len}]' (it needs ${text.length + 1} with the terminating zero)`)
  }
  const codes: ConstValue[] = []
  for (let i = 0; i < ty.len; i++) codes.push(i < text.length ? signedChar(text.charCodeAt(i), ty.elem) : 0)
  return { k: 'const', ty, value: codes }
}

function signedChar(code: number, elem: CType): number {
  const c = code & 0xff
  return elem.t === 'prim' && elem.p !== 'uchar' && c > 127 ? c - 256 : c
}

/** `{ ... }` for any type. Scalars accept `{v}` or `{}`. */
function braceInit(cx: Sema, ty: CType, list: InitListExpr): TInit {
  if (!isAggregate(ty)) {
    if (list.items.length > 1) cx.error(list.span, `Too many values in braces for '${typeName(ty)}'`)
    if (list.items.length === 0) return defaultInit(cx, ty)
    const item = list.items[0]
    return item.kind === 'initList' ? braceInit(cx, ty, item) : exprInit(cx, ty, item)
  }
  return finish(cx, ty, listItems(cx, ty, list))
}

function listItems(cx: Sema, ty: CType, list: InitListExpr): TInit[] {
  const cur: Cursor = { items: list.items, i: 0 }
  const items = fill(cx, ty, cur)
  if (cur.i < list.items.length) {
    cx.error(list.items[cur.i].span, `Too many initializers for '${typeName(ty)}'`)
  }
  return items
}

/** Fills one aggregate from the cursor (used both with explicit braces and with elided ones). */
function fill(cx: Sema, ty: CType, cur: Cursor): TInit[] {
  const out: TInit[] = []
  if (ty.t === 'array') {
    while (cur.i < cur.items.length && (ty.len < 0 || out.length < ty.len)) out.push(element(cx, ty.elem, cur))
  } else if (ty.t === 'struct') {
    for (const f of cx.structs[ty.id].fields) {
      if (cur.i >= cur.items.length) break
      out.push(element(cx, f.ty, cur))
    }
  }
  return out
}

function element(cx: Sema, ty: CType, cur: Cursor): TInit {
  const item = cur.items[cur.i]
  if (item.kind === 'initList') {
    cur.i++
    return braceInit(cx, ty, item)
  }
  if (ty.t === 'array' && isCharArray(ty) && item.kind === 'string') {
    cur.i++
    return charsInit(cx, ty, item.value, item.span)
  }
  if (isAggregate(ty)) return finish(cx, ty, fill(cx, ty, cur))
  cur.i++
  if (ty.t === 'native') {
    const e = checkExpr(cx, item)
    return { k: 'expr', e: convertTo(cx, e, ty, item.span, 'init') }
  }
  return exprInit(cx, ty, item)
}

/** Wraps list items, folding to a constant when every leaf is constant. */
function finish(cx: Sema, ty: CType, items: TInit[]): TInit {
  const padded = pad(cx, ty, items)
  const value = constOf(cx, ty, padded)
  return value !== null ? { k: 'const', ty, value } : { k: 'list', ty, items: padded }
}

/** Missing trailing elements / fields get their default (struct member initialisers included). */
function pad(cx: Sema, ty: CType, items: TInit[]): TInit[] {
  if (ty.t === 'struct') {
    const fields = cx.structs[ty.id].fields
    return fields.map((f, i) => items[i] ?? (f.init ? fieldDefault(cx, f.ty, f.init) : defaultInit(cx, f.ty)))
  }
  return items
}

function constOf(cx: Sema, ty: CType, items: TInit[]): ConstValue | null {
  const out: ConstValue[] = []
  const len = ty.t === 'array' ? ty.len : items.length
  for (let i = 0; i < len; i++) {
    const it = items[i]
    const elemTy = ty.t === 'array' ? ty.elem : ty.t === 'struct' ? cx.structs[ty.id].fields[i].ty : T.error
    const v = it ? leafConst(cx, it) : zeroConst(cx, elemTy)
    if (v === null) return null
    out.push(v)
  }
  return out
}

function leafConst(cx: Sema, it: TInit): ConstValue | null {
  if (it.k === 'const') return it.value
  if (it.k === 'expr') return it.e.k === 'const' && it.e.ty.t === 'prim' && it.e.ty.p !== 'void' ? it.e.value : null
  if (it.k === 'default') return zeroConst(cx, it.ty)
  return null
}

/** The zero value of a type as a constant, or null when it needs run-time construction (natives). */
export function zeroConst(cx: Sema, ty: CType): ConstValue | null {
  switch (ty.t) {
    case 'prim': return ty.p === 'string' || ty.p === 'cstr' ? '' : 0
    case 'array': {
      const out: ConstValue[] = []
      for (let i = 0; i < ty.len; i++) {
        const v = zeroConst(cx, ty.elem)
        if (v === null) return null
        out.push(v)
      }
      return out
    }
    case 'struct': {
      const info = cx.structs[ty.id]
      if (info.fields.some((f) => f.init)) return null
      const out: ConstValue[] = []
      for (const f of info.fields) {
        const v = zeroConst(cx, f.ty)
        if (v === null) return null
        out.push(v)
      }
      return out
    }
    default: return null
  }
}

/** `Point{1, 2}` as an expression. */
export function aggregateExpr(cx: Sema, ty: CType, args: Expr[], span: Span): TExpr {
  if (ty.t !== 'struct') return errExpr(span)
  const init = braceInit(cx, ty, { kind: 'initList', span, items: args })
  return { k: 'aggregate', ty, init, span }
}
