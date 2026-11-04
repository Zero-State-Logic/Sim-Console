/* ============================================================
   EXPRESSIONS — typing, name resolution, lvalues, literals,
   unary / assignment / ternary / index / member / cast / sizeof.
   Calls live in calls.ts and binary operators in binary.ts.
   ============================================================ */

import type { Assign, Cast, Expr, Index, Member, Sizeof, Ternary } from '../ast'
import { convertNumber, type ArithOp } from '../arith'
import { commonType, isArithmetic, isCharArray, isFloating, isInteger, promote, sameType, sizeOf, T, typeName, type CType } from '../ctypes'
import { didYouMean, type Span } from '../diagnostics'
import { table } from '../tables'
import type { TExpr, TLValue } from '../tir'
import { checkBinaryOp } from './binary'
import { checkCall, checkConstruct } from './calls'
import { BUILTIN_NAMES } from './macros'
import type { Sema, VarSym } from './context'
import { constNum, constStr, convertTo, numConvert, toCondition, toStringExpr } from './convert'

const MATH_CONSTANTS: Readonly<Record<string, number>> = table({
  PI: Math.PI, HALF_PI: Math.PI / 2, TWO_PI: Math.PI * 2, DEG_TO_RAD: Math.PI / 180, RAD_TO_DEG: 180 / Math.PI,
  EULER: Math.E, M_PI: Math.PI, M_E: Math.E, M_SQRT2: Math.SQRT2,
})

const BINARY_LITERAL = /^B[01]{1,8}$/

const ERR: CType = T.error

export function errExpr(span: Span): TExpr {
  return { k: 'const', ty: ERR, value: 0, span }
}

export function checkExpr(cx: Sema, e: Expr): TExpr {
  switch (e.kind) {
    case 'int': return intLiteral(cx, e.value, e.unsigned, e.long, e.radix, e.span)
    case 'float': return constNum(e.f32 ? T.float : T.double, e.f32 || cx.intBits === 16 ? Math.fround(e.value) : e.value, e.span)
    case 'char': return constNum(T.char, e.value, e.span)
    case 'bool': return constNum(T.bool, e.value ? 1 : 0, e.span)
    case 'string': return constStr(e.value, e.span)
    case 'ident': return identifier(cx, e.name, e.span)
    case 'scope': return scopeName(cx, e.scope, e.name, e.span)
    case 'unary': return unary(cx, e)
    case 'postfix': return incDec(cx, e.expr, e.op === '++' ? 1 : -1, false, e.span)
    case 'binary': return checkBinaryOp(cx, e, checkExpr(cx, e.left), checkExpr(cx, e.right))
    case 'assign': return assign(cx, e)
    case 'ternary': return ternary(cx, e)
    case 'call': return checkCall(cx, e)
    case 'index':
    case 'member': return rvalueOf(cx, e)
    case 'cast': return cast(cx, e)
    case 'construct': return checkConstruct(cx, e)
    case 'sizeof': return sizeofExpr(cx, e)
    case 'comma': {
      const a = checkExpr(cx, e.left)
      const b = checkExpr(cx, e.right)
      return { k: 'comma', ty: b.ty, a, b, span: e.span }
    }
    case 'initList':
      cx.error(e.span, 'A brace list { ... } can only initialise a variable (or be assigned to an array element or struct in its declaration)')
      return errExpr(e.span)
  }
}

export function checkCond(cx: Sema, e: Expr): TExpr {
  if (e.kind === 'assign' && e.op === '=') {
    cx.warning(e.opSpan, "Assignment '=' used as a condition: did you mean the comparison '=='?")
  }
  return toCondition(cx, checkExpr(cx, e), e.span)
}

/** Folds an integer constant expression (array sizes, case labels, enum values). */
export function constIntOf(cx: Sema, e: Expr): number | null {
  const t = checkExpr(cx, e)
  if (t.ty.t === 'error') return null
  if (t.k !== 'const' || typeof t.value !== 'number' || !isInteger(t.ty)) return null
  return t.value
}

/* ---------------- literals and names ---------------- */

export function intLiteral(cx: Sema, v: number, unsigned: boolean, long: boolean, radix: number, span: Span): TExpr {
  const intMax = cx.intBits === 16 ? 0x7fff : 0x7fffffff
  const uintMax = cx.intBits === 16 ? 0xffff : 0xffffffff
  const decimal = radix === 10
  let ty: CType
  if (unsigned) ty = !long && v <= uintMax ? T.uint : T.ulong
  else if (long) ty = v <= 0x7fffffff ? T.long : T.ulong
  else if (v <= intMax) ty = T.int
  else if (!decimal && v <= uintMax) ty = T.uint
  else if (v <= 0x7fffffff) ty = T.long
  else ty = T.ulong
  return constNum(ty, v, span)
}

/** A `double` constant: on AVR double is a 32-bit float, so the value is rounded like the board stores it. */
function doubleConst(cx: Sema, v: number, span: Span): TExpr {
  return constNum(T.double, cx.intBits === 16 ? Math.fround(v) : v, span)
}

function numericConstant(cx: Sema, v: number, span: Span): TExpr {
  if (!Number.isInteger(v)) return doubleConst(cx, v, span)
  if (v < 0) return constNum(v >= (cx.intBits === 16 ? -0x8000 : -0x80000000) ? T.int : T.long, v, span)
  return intLiteral(cx, v, false, false, 10, span)
}

function identifier(cx: Sema, name: string, span: Span): TExpr {
  const sym = cx.lookup(name)
  if (sym) {
    if (sym.kind === 'enumConst') return constNum(T.int, sym.value, span)
    sym.reads++
    if (sym.constValue !== null) {
      return typeof sym.constValue === 'number' ? constNum(sym.ty, sym.constValue, span) : constStr(sym.constValue, span, sym.ty)
    }
    return { k: 'load', ty: sym.ty, lv: varLValue(sym), span }
  }
  const c = cx.constants.get(name)
  if (c !== undefined) return numericConstant(cx, c, span)
  const m = MATH_CONSTANTS[name]
  if (m !== undefined) return doubleConst(cx, m, span)
  if (cx.objects.has(name)) return { k: 'const', ty: { t: 'object', name }, value: 0, span }
  if (BINARY_LITERAL.test(name)) return constNum(T.int, parseInt(name.slice(1), 2), span)
  return unknownName(cx, name, span)
}

function unknownName(cx: Sema, name: string, span: Span): TExpr {
  if (cx.fns.has(name) || cx.nativeFns.has(name) || BUILTIN_NAMES.includes(name)) {
    cx.error(span, `'${name}' is a function: call it with parentheses, ${name}(...)`)
  } else if (cx.classes.has(name) || cx.structByName.has(name) || cx.typedefs.has(name)) {
    cx.error(span, `'${name}' is a type, not a value. Declare a variable first, e.g. '${name} my${name};'`)
  } else {
    const later = cx.declaredBelow(name)
    if (later) {
      cx.error(span, `'${name}' was not declared in this scope: it is declared later, on line ${later.line}. Move the declaration above its first use`)
    } else {
      cx.error(span, `'${name}' was not declared in this scope.${didYouMean(name, cx.visibleNames())}`)
    }
  }
  return errExpr(span)
}

function scopeName(cx: Sema, scope: string, name: string, span: Span): TExpr {
  const en = cx.enums.get(scope)
  if (!en) {
    cx.error(span, `'${scope}' is not an enum (only Enum::Member scoping is supported)`)
    return errExpr(span)
  }
  const v = en.members.get(name)
  if (v === undefined) {
    cx.error(span, `'${name}' is not a member of enum '${scope}'.${didYouMean(name, en.members.keys())}`)
    return errExpr(span)
  }
  return constNum(T.int, v, span)
}

export function varLValue(sym: VarSym): TLValue {
  return sym.storage === 'local'
    ? { k: 'local', ty: sym.ty, slot: sym.slot, ref: sym.ref, name: sym.name }
    : { k: 'global', ty: sym.ty, index: sym.slot, name: sym.name }
}

/* ---------------- lvalues ---------------- */

export type LvPurpose = 'write' | 'ref' | 'read'

/** Resolves an expression that names storage. Reports a friendly error and returns null otherwise. */
export function checkLValue(cx: Sema, e: Expr, purpose: LvPurpose): TLValue | null {
  switch (e.kind) {
    case 'ident': return identLValue(cx, e.name, e.span, purpose)
    case 'index': return indexLValue(cx, e, purpose)
    case 'member': return memberLValue(cx, e, purpose)
    default: {
      if (purpose !== 'read') {
        const t = checkExpr(cx, e)
        if (t.ty.t !== 'error') cx.error(e.span, purpose === 'ref' ? 'This argument must be a variable (it is passed by reference)' : 'The left side of an assignment must be a variable, an array element or a struct field')
      }
      return null
    }
  }
}

function identLValue(cx: Sema, name: string, span: Span, purpose: LvPurpose): TLValue | null {
  const sym = cx.lookup(name)
  if (!sym || sym.kind !== 'var') {
    const t = checkExpr(cx, { kind: 'ident', span, name })
    if (t.ty.t !== 'error' && purpose !== 'read') cx.error(span, `'${name}' is not a variable and cannot be assigned`)
    return null
  }
  if (purpose === 'write') {
    if (sym.isConst) {
      cx.error(span, `Cannot assign to '${name}': it is declared const (read-only)`)
      return null
    }
    sym.writes++
  } else {
    sym.reads++
  }
  return varLValue(sym)
}

function indexLValue(cx: Sema, e: Index, purpose: LvPurpose): TLValue | null {
  const base = baseLValueOrExpr(cx, e.obj, purpose)
  if (!base) return null
  const idx = indexValue(cx, e.index)
  const objTy = base.ty
  if (objTy.t === 'array') {
    boundsWarning(cx, idx, objTy.len, e)
    const arr = base.lv ? { k: 'load' as const, ty: objTy, lv: base.lv, span: e.obj.span } : base.ex as TExpr
    return { k: 'index', ty: objTy.elem, arr, idx, site: cx.site(e.index.span, exprName(e.obj)) }
  }
  if (objTy.t === 'prim' && objTy.p === 'string' && base.lv) {
    return { k: 'strIndex', ty: T.char, str: base.lv, idx, site: cx.site(e.index.span, exprName(e.obj)) }
  }
  if (objTy.t === 'prim' && objTy.p === 'cstr' && base.lv) {
    // msg[i] on a const char*: reading gives the char (0 at the terminator); the text itself is read-only
    if (purpose !== 'read') {
      cx.error(e.span, `The characters of '${exprName(e.obj)}' (a 'const char*') are read-only. Copy the text into a char array or a String to change it`)
      return null
    }
    return { k: 'strIndex', ty: T.char, str: base.lv, idx, site: cx.site(e.index.span, exprName(e.obj)) }
  }
  if (objTy.t !== 'error') cx.error(e.obj.span, `'${exprName(e.obj)}' is not an array (type '${typeName(objTy)}'), so it cannot be indexed with [ ]`)
  return null
}

function memberLValue(cx: Sema, e: Member, purpose: LvPurpose): TLValue | null {
  const base = baseLValueOrExpr(cx, e.obj, purpose)
  if (!base) return null
  const ty = base.ty
  if (e.arrow) {
    cx.error(e.span, `'->' needs a pointer; use '.' to reach a field: ${exprName(e.obj)}.${e.name}`)
    return null
  }
  if (ty.t === 'struct') {
    const info = cx.structs[ty.id]
    const field = info.fields.findIndex((f) => f.name === e.name)
    if (field < 0) {
      cx.error(e.nameSpan, `'struct ${info.name}' has no member named '${e.name}'.${didYouMean(e.name, info.fields.map((f) => f.name))}`)
      return null
    }
    const obj = base.lv ? { k: 'load' as const, ty, lv: base.lv, span: e.obj.span } : base.ex as TExpr
    return { k: 'field', ty: info.fields[field].ty, obj, field }
  }
  if (ty.t === 'object' || ty.t === 'native' || (ty.t === 'prim' && ty.p === 'string')) {
    cx.error(e.span, `'${e.name}' is a method of '${typeName(ty)}': call it with parentheses, ${exprName(e.obj)}.${e.name}(...)`)
    return null
  }
  if (ty.t !== 'error') cx.error(e.span, `'${exprName(e.obj)}' is a '${typeName(ty)}', which has no members (it is not a struct)`)
  return null
}

/** For a[i] / s.f: the base as an lvalue when it names storage, else as a value (e.g. a call result). */
function baseLValueOrExpr(cx: Sema, e: Expr, purpose: LvPurpose): { ty: CType; lv: TLValue | null; ex: TExpr | null } | null {
  if (e.kind === 'ident' || e.kind === 'index' || e.kind === 'member') {
    // writing an element modifies the array / struct, not its variable binding
    const lv = checkLValue(cx, e, purpose === 'write' ? 'ref' : purpose)
    if (lv && purpose === 'write' && isConstBase(cx, e)) {
      cx.error(e.span, `Cannot modify '${exprName(e)}': it is declared const`)
      return null
    }
    return lv ? { ty: lv.ty, lv, ex: null } : null
  }
  const ex = checkExpr(cx, e)
  return ex.ty.t === 'error' ? null : { ty: ex.ty, lv: null, ex }
}

function isConstBase(cx: Sema, e: Expr): boolean {
  let root: Expr = e
  while (root.kind === 'index' || root.kind === 'member') root = root.obj
  if (root.kind !== 'ident') return false
  const sym = cx.lookup(root.name)
  return !!sym && sym.kind === 'var' && sym.isConst
}

function indexValue(cx: Sema, e: Expr): TExpr {
  const idx = checkExpr(cx, e)
  if (idx.ty.t === 'error') return idx
  if (!isInteger(idx.ty)) {
    cx.error(e.span, `Array index must be an integer, got '${typeName(idx.ty)}'`)
    return errExpr(e.span)
  }
  return numConvert(cx, idx, T.long)
}

function boundsWarning(cx: Sema, idx: TExpr, len: number, e: Index): void {
  if (idx.k !== 'const' || typeof idx.value !== 'number' || len < 0) return
  if (idx.value < 0 || idx.value >= len) {
    cx.warning(e.index.span, `Index ${idx.value} is out of bounds for '${exprName(e.obj)}' (valid 0..${len - 1}); the program will stop here with an error`)
  }
}

export function exprName(e: Expr): string {
  switch (e.kind) {
    case 'ident': return e.name
    case 'index': return `${exprName(e.obj)}[]`
    case 'member': return `${exprName(e.obj)}.${e.name}`
    case 'call': return `${exprName(e.callee)}()`
    default: return 'expression'
  }
}

/** Reading a[i], s.f, s[i]. */
function rvalueOf(cx: Sema, e: Index | Member): TExpr {
  if (e.kind === 'index') {
    const obj = checkExprForIndex(cx, e)
    if (obj) return obj
  }
  const lv = checkLValue(cx, e, 'read')
  if (!lv) return errExpr(e.span)
  return { k: 'load', ty: lv.ty, lv, span: e.span }
}

/** Indexing a non-lvalue String / const char* (e.g. "abc"[1], name()[0]). */
function checkExprForIndex(cx: Sema, e: Index): TExpr | null {
  if (e.obj.kind === 'ident' || e.obj.kind === 'index' || e.obj.kind === 'member') return null
  const s = checkExpr(cx, e.obj)
  if (s.ty.t !== 'prim' || (s.ty.p !== 'string' && s.ty.p !== 'cstr')) {
    if (s.ty.t === 'array') {
      const idx = indexValue(cx, e.index)
      return { k: 'load', ty: s.ty.elem, lv: { k: 'index', ty: s.ty.elem, arr: s, idx, site: cx.site(e.index.span, exprName(e.obj)) }, span: e.span }
    }
    if (s.ty.t !== 'error') cx.error(e.obj.span, `Type '${typeName(s.ty)}' cannot be indexed with [ ]`)
    return errExpr(e.span)
  }
  const idx = indexValue(cx, e.index)
  return { k: 'strIdx', ty: T.char, s, idx, site: cx.site(e.index.span, 'string'), span: e.span }
}

/* ---------------- unary, ++/--, assignment ---------------- */

function unary(cx: Sema, e: Extract<Expr, { kind: 'unary' }>): TExpr {
  if (e.op === '++' || e.op === '--') return incDec(cx, e.expr, e.op === '++' ? 1 : -1, true, e.span)
  if (e.op === '&') {
    cx.error(e.span, "Pointers are not supported, so '&' (address-of) cannot be used here. To let a function change a variable, declare its parameter as a reference: void f(int &x)")
    return errExpr(e.span)
  }
  if (e.op === '*') {
    cx.error(e.span, "Pointers are not supported, so '*' (dereference) cannot be used here")
    return errExpr(e.span)
  }
  const v = checkExpr(cx, e.expr)
  if (v.ty.t === 'error') return v
  if (e.op === '!') {
    const c = toCondition(cx, v, e.expr.span)
    if (c.k === 'const' && typeof c.value === 'number') return constNum(T.bool, c.value ? 0 : 1, e.span)
    return { k: 'unary', ty: T.bool, op: 'not', e: c, span: e.span }
  }
  if (!isArithmetic(v.ty) || (e.op === '~' && !isInteger(v.ty))) {
    cx.error(e.span, `Invalid operand to unary '${e.op}': '${typeName(v.ty)}'`)
    return errExpr(e.span)
  }
  const ty = promote(v.ty, cx.intBits)
  const x = numConvert(cx, v, ty)
  if (e.op === '+') return x
  const op = e.op === '-' ? 'neg' : 'bnot'
  if (x.k === 'const' && typeof x.value === 'number') return foldUnary(cx, op, x.value, ty, e.span)
  return { k: 'unary', ty, op, e: x, span: e.span }
}

function foldUnary(cx: Sema, op: 'neg' | 'bnot', v: number, ty: CType, span: Span): TExpr {
  const raw = op === 'neg' ? -v : ~v
  return constNum(ty, ty.t === 'prim' ? convertNumber(raw, ty.p, cx.intBits, false) : raw, span)
}

const STRING_CHAR_EDIT = "Changing a String character this way is not supported; read it with s[i] and write it with s.setCharAt(i, c) or s[i] = c"

function incDec(cx: Sema, target: Expr, delta: 1 | -1, prefix: boolean, span: Span): TExpr {
  const lv = checkLValue(cx, target, 'write')
  if (!lv) return errExpr(span)
  if (lv.k === 'strIndex') {
    cx.error(span, STRING_CHAR_EDIT)
    return errExpr(span)
  }
  if (lv.k === 'local' || lv.k === 'global') bumpRead(cx, target)
  if (!isArithmetic(lv.ty)) {
    cx.error(span, `Cannot apply '${delta > 0 ? '++' : '--'}' to '${typeName(lv.ty)}'`)
    return errExpr(span)
  }
  if (lv.ty.t === 'prim' && lv.ty.p === 'bool' && delta < 0) {
    cx.error(span, "'--' on a bool is not allowed in C++")
    return errExpr(span)
  }
  return { k: 'incdec', ty: lv.ty, lv, delta, prefix, span }
}

function bumpRead(cx: Sema, target: Expr): void {
  if (target.kind !== 'ident') return
  const sym = cx.lookup(target.name)
  if (sym && sym.kind === 'var') sym.reads++
}

const COMPOUND: Record<string, string> = {
  '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%', '&=': '&', '|=': '|', '^=': '^', '<<=': '<<', '>>=': '>>',
}

function assign(cx: Sema, e: Assign): TExpr {
  const lv = checkLValue(cx, e.target, 'write')
  if (e.value.kind === 'initList') {
    if (lv) cx.error(e.value.span, `Assigning a brace list is not supported; assign the ${lv.ty.t === 'struct' ? 'fields' : 'elements'} one by one`)
    return errExpr(e.span)
  }
  const value = checkExpr(cx, e.value)
  if (!lv || value.ty.t === 'error') return errExpr(e.span)
  if (lv.ty.t === 'array') {
    cx.error(e.opSpan, 'Arrays cannot be assigned as a whole; copy them element by element in a loop')
    return errExpr(e.span)
  }
  if (lv.ty.t === 'object') {
    cx.error(e.opSpan, `'${typeName(lv.ty)}' cannot be assigned`)
    return errExpr(e.span)
  }
  if (e.op === '=') {
    const v = convertTo(cx, value, lv.ty, e.value.span, 'assign')
    return { k: 'assign', ty: lv.ty, lv, value: v, span: e.span }
  }
  if (lv.k === 'strIndex') {
    cx.error(e.opSpan, STRING_CHAR_EDIT)
    return errExpr(e.span)
  }
  if (lv.k === 'local' || lv.k === 'global') bumpRead(cx, e.target)
  return compound(cx, lv, COMPOUND[e.op], value, e)
}

function compound(cx: Sema, lv: TLValue, op: string, value: TExpr, e: Assign): TExpr {
  const target = lv.ty
  if (target.t === 'prim' && target.p === 'string') {
    if (op !== '+') {
      cx.error(e.opSpan, `Operator '${e.op}' cannot be used on a String (only += appends)`)
      return errExpr(e.span)
    }
    return { k: 'compound', ty: target, lv, op: 'concat', opTy: T.string, value: toStringExpr(cx, value, e.value.span), site: -1, span: e.span }
  }
  if (!isArithmetic(target) || !isArithmetic(value.ty)) {
    cx.error(e.opSpan, `Invalid operands to '${e.op}': '${typeName(target)}' and '${typeName(value.ty)}'`)
    return errExpr(e.span)
  }
  const intOnly = op === '%' || op === '&' || op === '|' || op === '^' || op === '<<' || op === '>>'
  if (intOnly && (isFloating(target) || isFloating(value.ty))) {
    cx.error(e.opSpan, `Operator '${e.op}' needs integers, got '${typeName(target)}' and '${typeName(value.ty)}'`)
    return errExpr(e.span)
  }
  const shift = op === '<<' || op === '>>'
  const opTy = shift ? promote(target, cx.intBits) : commonType(target, value.ty, cx.intBits)
  const v = numConvert(cx, value, shift ? promote(value.ty, cx.intBits) : opTy)
  const site = (op === '/' || op === '%') && isInteger(opTy) ? cx.site(e.opSpan, op) : -1
  if ((op === '/' || op === '%') && isInteger(opTy) && v.k === 'const' && v.value === 0) cx.warning(e.opSpan, 'Division by zero')
  return { k: 'compound', ty: target, lv, op: op as ArithOp, opTy, value: v, site, span: e.span }
}

/* ---------------- ternary, cast, sizeof ---------------- */

function ternary(cx: Sema, e: Ternary): TExpr {
  const c = checkCond(cx, e.cond)
  let a = checkExpr(cx, e.a)
  let b = checkExpr(cx, e.b)
  if (a.ty.t === 'error' || b.ty.t === 'error' || c.ty.t === 'error') return errExpr(e.span)
  let ty: CType
  if (isArithmetic(a.ty) && isArithmetic(b.ty)) {
    ty = a.ty.t === 'prim' && b.ty.t === 'prim' && a.ty.p === 'bool' && b.ty.p === 'bool' ? T.bool : commonType(a.ty, b.ty, cx.intBits)
    a = numConvert(cx, a, ty)
    b = numConvert(cx, b, ty)
  } else if (isStringish(a.ty) && isStringish(b.ty)) {
    const anyString = isStringT(a.ty) || isStringT(b.ty)
    ty = anyString ? T.string : T.cstr
    a = convertTo(cx, a, ty, e.a.span, 'init')
    b = convertTo(cx, b, ty, e.b.span, 'init')
  } else if (sameType(a.ty, b.ty) && a.ty.t !== 'array') {
    ty = a.ty
  } else {
    cx.error(e.span, `The two results of '?:' have different types: '${typeName(a.ty)}' and '${typeName(b.ty)}'`)
    return errExpr(e.span)
  }
  if (c.k === 'const') return c.value ? a : b
  return { k: 'cond', ty, c, a, b, span: e.span }
}

function isStringT(ty: CType): boolean {
  return ty.t === 'prim' && ty.p === 'string'
}

function isStringish(ty: CType): boolean {
  return (ty.t === 'prim' && (ty.p === 'string' || ty.p === 'cstr')) || isCharArray(ty)
}

function cast(cx: Sema, e: Cast): TExpr {
  const to = cx.resolveType(e.type, 0, [], false)
  const v = checkExpr(cx, e.expr)
  if (to.t === 'error' || v.ty.t === 'error') return errExpr(e.span)
  if (to.t === 'prim' && to.p === 'void') return { k: 'convert', ty: T.void, from: v.ty, e: v, span: e.span }
  if (to.t === 'prim' && to.p === 'string') return toStringExpr(cx, v, e.span)
  if (isArithmetic(to) && !isArithmetic(v.ty)) {
    cx.error(e.span, `Cannot cast '${typeName(v.ty)}' to '${typeName(to)}'${isStringish(v.ty) ? '. Use .toInt() or .toFloat() on a String' : ''}`)
    return errExpr(e.span)
  }
  return convertTo(cx, v, to, e.span, 'cast')
}

function sizeofExpr(cx: Sema, e: Sizeof): TExpr {
  let ty: CType
  if (e.type) {
    ty = cx.resolveType(e.type, 0, [], false)
  } else {
    const inner = e.expr as Expr
    if (inner.kind === 'string') return constNum(T.uint, inner.value.length + 1, e.span)
    const t = checkExprNoSideEffects(cx, inner)
    ty = t.ty
    if (ty.t === 'array' && ty.len < 0) {
      cx.warning(e.span, `sizeof on array parameter '${exprName(inner)}' gives the size of a pointer, not of the array. Pass the length as a separate parameter`)
    }
  }
  if (ty.t === 'error') return errExpr(e.span)
  if (ty.t === 'prim' && ty.p === 'void') {
    cx.error(e.span, "sizeof cannot be applied to 'void'")
    return errExpr(e.span)
  }
  return constNum(T.uint, sizeOf(ty, { intBits: cx.intBits, structFields: (id) => cx.structFields(id) }), e.span)
}

/** sizeof does not evaluate its operand, so its reads must not count as uses. */
function checkExprNoSideEffects(cx: Sema, e: Expr): TExpr {
  const t = checkExpr(cx, e)
  if (e.kind === 'ident') {
    const sym = cx.lookup(e.name)
    if (sym && sym.kind === 'var') sym.reads = Math.max(1, sym.reads)
  }
  return t
}
