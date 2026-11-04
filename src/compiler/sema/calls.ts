/* ============================================================
   CALLS — resolves f(args) and obj.method(args) to a user function
   (with overloads, default arguments and reference parameters), a VM
   builtin, an Arduino macro (expanded like the real preprocessor),
   a native function, a native object method (Serial.println) or a
   native class method (servo.write). Also constructors.
   ============================================================ */

import type { NativeFnSig } from '../api'
import type { Call, Construct, Expr, Member } from '../ast'
import { B } from '../builtins'
import { fromValueType, isArithmetic, isCharArray, isFloating, isInteger, sameType, T, toValueType, typeName, type CType } from '../ctypes'
import { didYouMean, type Span } from '../diagnostics'
import type { TArg, TExpr } from '../tir'
import type { FnSym, Sema } from './context'
import { constNum, convertTo, numConvert, toStringExpr } from './convert'
import { checkExpr, checkLValue, errExpr, exprName } from './exprs'
import { aggregateExpr } from './init'
import { expandMacro, MATH, isMacroBuiltin } from './macros'
import { stringMethod } from './strings'

export function checkCall(cx: Sema, e: Call): TExpr {
  const callee = e.callee
  if (callee.kind === 'member') return memberCall(cx, callee, e.args, e.span)
  if (callee.kind !== 'ident') {
    const t = checkExpr(cx, callee)
    if (t.ty.t !== 'error') cx.error(callee.span, 'This expression cannot be called like a function')
    return errExpr(e.span)
  }
  const name = callee.name
  const sym = cx.lookup(name)
  if (sym && sym.kind === 'var') {
    cx.error(callee.span, `'${name}' is a variable of type '${typeName(sym.ty)}', not a function`)
    return errExpr(e.span)
  }
  const user = cx.fns.get(name)
  if (user) return userCall(cx, name, user, e.args, e.span, callee.span)
  const builtin = builtinCall(cx, name, e.args, e.span)
  if (builtin) return builtin
  const natives = cx.nativeFns.get(name)
  if (natives) return nativeCall(cx, name, natives, null, e.args, e.span)
  return unknownFunction(cx, name, callee.span, e.span)
}

function unknownFunction(cx: Sema, name: string, at: Span, span: Span): TExpr {
  if (cx.classes.has(name)) return checkConstruct(cx, { kind: 'construct', span, type: { span: at, name, named: true, isConst: false, isStatic: false, pointer: 0, inferred: false }, args: [] })
  const later = cx.declaredBelow(name)
  const hint = later ? ` It is declared later, on line ${later.line}.` : didYouMean(name, cx.visibleNames())
  cx.error(at, `'${name}' was not declared in this scope.${hint}`)
  return errExpr(span)
}

/* ---------------- user functions ---------------- */

/** Pass by address: non-const reference to a scalar or String (2 frame slots). */
export function byAddress(p: { ref: boolean; isConst: boolean; ty: CType }): boolean {
  return p.ref && !p.isConst && (isArithmetic(p.ty) || (p.ty.t === 'prim' && p.ty.p === 'string'))
}

function convScore(from: CType, to: CType): number {
  if (from.t === 'error' || to.t === 'error') return 1
  if (sameType(from, to)) return 3
  if (isArithmetic(from) && isArithmetic(to)) return isFloating(from) === isFloating(to) ? 2 : 1
  if (to.t === 'prim' && (to.p === 'string' || to.p === 'cstr')) {
    return (from.t === 'prim' && (from.p === 'cstr' || from.p === 'string')) || isCharArray(from) ? 2 : -1
  }
  if (from.t === 'array' && to.t === 'array') return sameType(from.elem, to.elem) ? 2 : -1
  return -1
}

function pickOverload(cands: FnSym[], args: TExpr[]): FnSym | null {
  let best: FnSym | null = null
  let bestScore = -1
  for (const f of cands) {
    const required = f.params.filter((p) => !p.defaultValue).length
    if (args.length < required || args.length > f.params.length) continue
    let score = 0
    for (let i = 0; i < args.length && score >= 0; i++) {
      const s = convScore(args[i].ty, f.params[i].ty)
      score = s < 0 ? -1 : score + s
    }
    if (score > bestScore) {
      best = f
      bestScore = score
    }
  }
  return best
}

function signature(f: FnSym): string {
  const ps = f.params.map((p) => `${p.isConst ? 'const ' : ''}${typeName(p.ty)}${p.ref ? '&' : ''}`).join(', ')
  return `${typeName(f.ret)} ${f.name}(${ps})`
}

function userCall(cx: Sema, name: string, cands: FnSym[], argExprs: Expr[], span: Span, at: Span): TExpr {
  const args = argExprs.map((a) => (a.kind === 'initList' ? errInit(cx, a.span) : checkExpr(cx, a)))
  if (args.some((a) => a.ty.t === 'error')) return errExpr(span)
  const fn = pickOverload(cands, args)
  if (!fn) {
    reportBadCall(cx, name, cands, args, at)
    return errExpr(span)
  }
  fn.used = true
  const targs: TArg[] = []
  for (let i = 0; i < fn.params.length; i++) {
    const p = fn.params[i]
    if (i >= args.length) {
      const d = checkExpr(cx, p.defaultValue as Expr)
      targs.push({ k: 'val', e: convertTo(cx, d, p.ty, span, 'arg') })
      continue
    }
    const arg = passArg(cx, p, args[i], argExprs[i])
    if (!arg) return errExpr(span)
    targs.push(arg)
  }
  return { k: 'call', ty: fn.ret, fn: fn.index, args: targs, span }
}

function errInit(cx: Sema, span: Span): TExpr {
  cx.error(span, 'A brace list cannot be passed as an argument; declare a variable first')
  return errExpr(span)
}

function passArg(cx: Sema, p: FnSym['params'][number], a: TExpr, src: Expr): TArg | null {
  if (byAddress(p)) {
    if (a.k !== 'load' || a.lv.k === 'strIndex') {
      const why = constRoot(cx, src) ? `'${exprName(src)}' is const` : 'it must be a variable'
      cx.error(src.span, `Cannot pass this to the '${typeName(p.ty)}&' parameter '${p.name ?? ''}': ${why} (it is passed by reference)`)
      return null
    }
    const lv = a.lv
    if (!sameType(a.ty, p.ty)) {
      cx.error(src.span, `Cannot pass '${typeName(a.ty)}' variable '${exprName(src)}' to a '${typeName(p.ty)}&' parameter: a reference needs exactly the same type`)
      return null
    }
    if (constRoot(cx, src)) {
      cx.error(src.span, `Cannot pass const '${exprName(src)}' to a non-const reference parameter`)
      return null
    }
    markWritten(cx, src)
    return { k: 'ref', lv }
  }
  if (p.ref && (a.ty.t === 'struct' || a.ty.t === 'native')) {
    if (!sameType(a.ty, p.ty)) {
      cx.error(src.span, `Cannot pass '${typeName(a.ty)}' to a '${typeName(p.ty)}&' parameter`)
      return null
    }
    if (!p.isConst && constRoot(cx, src)) {
      cx.error(src.span, `Cannot pass const '${exprName(src)}' to a non-const reference parameter`)
      return null
    }
    return { k: 'val', e: a }
  }
  const v = convertTo(cx, a, p.ty, src.span, 'arg')
  return v.ty.t === 'error' ? null : { k: 'val', e: v }
}

function constRoot(cx: Sema, e: Expr): boolean {
  let root = e
  while (root.kind === 'index' || root.kind === 'member') root = root.obj
  if (root.kind !== 'ident') return false
  const s = cx.lookup(root.name)
  return !!s && s.kind === 'var' && s.isConst
}

function markWritten(cx: Sema, e: Expr): void {
  if (e.kind !== 'ident') return
  const s = cx.lookup(e.name)
  if (s && s.kind === 'var') s.writes++
}

function reportBadCall(cx: Sema, name: string, cands: FnSym[], args: TExpr[], at: Span): void {
  const f = cands[0]
  if (cands.length === 1) {
    const required = f.params.filter((p) => !p.defaultValue).length
    if (args.length < required) return cx.error(at, `Too few arguments to function '${signature(f)}': expected ${required}, got ${args.length}`)
    if (args.length > f.params.length) return cx.error(at, `Too many arguments to function '${signature(f)}': expected ${f.params.length}, got ${args.length}`)
    const bad = args.findIndex((a, i) => convScore(a.ty, f.params[i].ty) < 0)
    return cx.error(at, `Argument ${bad + 1} of '${signature(f)}': cannot convert '${typeName(args[bad].ty)}' to '${typeName(f.params[bad].ty)}'`)
  }
  const got = args.map((a) => typeName(a.ty)).join(', ')
  cx.error(at, `No version of '${name}' takes (${got}). Candidates: ${cands.map(signature).join('; ')}`)
}

/* ---------------- builtins ---------------- */

function builtinCall(cx: Sema, name: string, args: Expr[], span: Span): TExpr | null {
  if (isMacroBuiltin(name, cx.intBits)) {
    const expanded = expandMacro(cx, name, args, span)
    return expanded ? checkExpr(cx, expanded) : errExpr(span)
  }
  const arity = (n: number, m = n): boolean => {
    if (args.length >= n && args.length <= m) return true
    cx.error(span, `${name}() takes ${n === m ? n : `${n} or ${m}`} argument${m === 1 ? '' : 's'}, got ${args.length}`)
    return false
  }
  const num = (i: number, ty: CType): TExpr => numericArg(cx, name, args[i], ty)
  switch (name) {
    case 'delay': return arity(1) ? { k: 'sleep', ty: T.void, ms: num(0, T.ulong), micro: false, span } : errExpr(span)
    case 'delayMicroseconds': return arity(1) ? { k: 'sleep', ty: T.void, ms: num(0, T.uint), micro: true, span } : errExpr(span)
    case 'yield': return arity(0) ? { k: 'yield', ty: T.void, span } : errExpr(span)
    case 'millis': return arity(0) ? bi(cx, B.MILLIS, T.ulong, [], span) : errExpr(span)
    case 'micros': return arity(0) ? bi(cx, B.MICROS, T.ulong, [], span) : errExpr(span)
    case 'random':
      if (!arity(1, 2)) return errExpr(span)
      return bi(cx, args.length === 1 ? B.RANDOM1 : B.RANDOM2, T.long, args.map((_, i) => num(i, T.long)), span)
    case 'randomSeed': return arity(1) ? bi(cx, B.RANDOM_SEED, T.void, [num(0, T.ulong)], span) : errExpr(span)
    case 'map': return arity(5) ? bi(cx, B.MAP, T.long, args.map((_, i) => num(i, T.long)), span) : errExpr(span)
    case 'isnan':
    case 'isinf': return arity(1) ? bi(cx, name === 'isnan' ? B.ISNAN : B.ISINF, T.bool, [num(0, T.double)], span) : errExpr(span)
    case 'strlen': return arity(1) ? bi(cx, B.STRLEN, T.uint, [textArg(cx, args[0])], span) : errExpr(span)
    case 'F':
      return arity(1) ? checkExpr(cx, args[0]) : errExpr(span)
    default:
      break
  }
  const math = MATH[name]
  if (math) {
    if (!arity(math.argc)) return errExpr(span)
    const ret = math.ret === 'bool' ? T.bool : math.ret === 'int' ? T.int : T.double
    return bi(cx, math.id, ret, args.map((_, i) => num(i, math.param === 'int' ? T.int : T.double)), span)
  }
  return null
}

function bi(cx: Sema, id: number, ty: CType, args: TExpr[], span: Span): TExpr {
  if (args.some((a) => a.ty.t === 'error')) return errExpr(span)
  return { k: 'builtin', ty, id, args, site: cx.site(span), span }
}

function numericArg(cx: Sema, fname: string, e: Expr, ty: CType): TExpr {
  const v = checkExpr(cx, e)
  if (v.ty.t === 'error') return v
  if (!isArithmetic(v.ty)) {
    cx.error(e.span, `${fname}() needs a number here, got '${typeName(v.ty)}'`)
    return errExpr(e.span)
  }
  return numConvert(cx, v, ty)
}

function textArg(cx: Sema, e: Expr): TExpr {
  const v = checkExpr(cx, e)
  return convertTo(cx, v, T.string, e.span, 'arg')
}

/* ---------------- natives ---------------- */

function pickNative(sigs: NativeFnSig[], args: TExpr[]): NativeFnSig | null {
  let best: NativeFnSig | null = null
  let fallback: NativeFnSig | null = null
  let bestScore = -1
  for (const s of sigs) {
    const min = s.params.length - (s.optional ?? 0)
    if (args.length < min || args.length > s.params.length) continue
    fallback = fallback ?? s
    let score = 0
    for (let i = 0; i < args.length && score >= 0; i++) {
      const p = s.params[i]
      const sc = p === 'any' ? (args[i].ty.t === 'prim' && (args[i].ty as { p: string }).p === 'void' ? -1 : 1) : convScore(args[i].ty, fromValueType(p))
      score = sc < 0 ? -1 : score + sc
    }
    if (score > bestScore) {
      best = s
      bestScore = score
    }
  }
  // no exact fit: the first sig with the right arity reports the precise conversion error
  return best ?? fallback
}

function nativeArg(cx: Sema, p: NativeFnSig['params'][number], a: TExpr, span: Span): TExpr {
  if (p !== 'any') return convertTo(cx, a, fromValueType(p), span, 'arg')
  if (isCharArray(a.ty)) return { k: 'chars2str', ty: T.string, e: a, span }
  if (a.ty.t === 'object') {
    cx.error(span, `'${typeName(a.ty)}' cannot be passed as a value`)
    return errExpr(span)
  }
  if (a.ty.t === 'prim' && a.ty.p === 'void') return convertTo(cx, a, T.int, span, 'arg')
  return a
}

export function nativeCall(cx: Sema, name: string, sigs: NativeFnSig[], self: TExpr | null, argExprs: Expr[], span: Span): TExpr {
  const args = argExprs.map((a) => (a.kind === 'initList' ? errInit(cx, a.span) : checkExpr(cx, a)))
  if (args.some((a) => a.ty.t === 'error')) return errExpr(span)
  const sig = pickNative(sigs, args)
  if (!sig) {
    const s = sigs[0]
    const min = s.params.length - (s.optional ?? 0)
    const want = min === s.params.length ? `${min}` : `${min} to ${s.params.length}`
    cx.error(span, `${name}() takes ${want} argument${s.params.length === 1 ? '' : 's'} (${s.params.join(', ') || 'none'}), got ${args.length}`)
    return errExpr(span)
  }
  const conv = args.map((a, i) => nativeArg(cx, sig.params[i], a, argExprs[i].span))
  if (conv.some((a) => a.ty.t === 'error')) return errExpr(span)
  const argTypes = conv.map((a) => (a.ty.t === 'prim' ? toValueType(a.ty) : 'any'))
  const ret = sig.returns === 'any' ? 'double' : sig.returns
  const site = cx.nativeSite(name, argTypes, self !== null, ret)
  return { k: 'native', ty: fromValueType(ret), site, self, args: conv, span }
}

/* ---------------- member calls ---------------- */

function memberCall(cx: Sema, m: Member, args: Expr[], span: Span): TExpr {
  if (m.obj.kind === 'ident' && !cx.lookup(m.obj.name)) {
    const owner = m.obj.name
    if (cx.objects.has(owner)) return objectMethod(cx, owner, m, args, span)
    if (cx.classes.has(owner)) {
      cx.error(m.obj.span, `'${owner}' is a type, not an object. Declare one first ('${owner} my${owner};'), then call my${owner}.${m.name}(...)`)
      return errExpr(span)
    }
  }
  if (m.arrow) {
    cx.error(m.span, `'->' needs a pointer; use '.' instead: ${exprName(m.obj)}.${m.name}(...)`)
    return errExpr(span)
  }
  const isPlace = m.obj.kind === 'ident' || m.obj.kind === 'index' || m.obj.kind === 'member'
  const lv = isPlace ? checkLValue(cx, m.obj, 'read') : null
  const recv: TExpr = lv ? { k: 'load', ty: lv.ty, lv, span: m.obj.span } : isPlace ? errExpr(m.obj.span) : checkExpr(cx, m.obj)
  const ty = recv.ty
  if (ty.t === 'error') return errExpr(span)
  if (ty.t === 'native') return classMethod(cx, ty.cls, recv, m, args, span)
  if (ty.t === 'prim' && ty.p === 'string') {
    if (lv && m.obj.kind === 'ident') writeIfMutating(cx, m.obj.name, m.name)
    return stringMethod(cx, recv, lv, m.name, args, span)
  }
  if (ty.t === 'prim' && ty.p === 'cstr') {
    cx.error(m.nameSpan, `A 'const char*' has no methods. Wrap it in a String first: String(${exprName(m.obj)}).${m.name}(...)`)
  } else if (ty.t === 'array') {
    cx.error(m.nameSpan, `Arrays have no methods${m.name === 'length' || m.name === 'size' ? '; use sizeof(arr) / sizeof(arr[0]) for the element count' : ''}`)
  } else if (ty.t === 'struct') {
    cx.error(m.nameSpan, `Structs have no member functions ('${m.name}'). Write a plain function that takes 'struct ${ty.name} &' instead`)
  } else {
    cx.error(m.nameSpan, `'${typeName(ty)}' has no methods`)
  }
  return errExpr(span)
}

function writeIfMutating(cx: Sema, name: string, method: string): void {
  const s = cx.lookup(name)
  if (!s || s.kind !== 'var') return
  if (['toUpperCase', 'toLowerCase', 'trim', 'concat', 'replace', 'remove', 'setCharAt'].includes(method)) {
    if (s.isConst) cx.error(s.span, `'${name}' is const, so ${method}() cannot change it`)
    s.writes++
  }
}

function objectMethod(cx: Sema, owner: string, m: Member, args: Expr[], span: Span): TExpr {
  const full = `${owner}.${m.name}`
  const sigs = cx.nativeFns.get(full)
  if (sigs) return nativeCall(cx, full, sigs, null, args, span)
  const methods = [...cx.nativeFns.keys()].filter((k) => k.startsWith(`${owner}.`)).map((k) => k.slice(owner.length + 1))
  cx.error(m.nameSpan, `'${owner}' has no method named '${m.name}'.${didYouMean(m.name, methods)}`)
  return errExpr(span)
}

function classMethod(cx: Sema, cls: string, recv: TExpr, m: Member, args: Expr[], span: Span): TExpr {
  const methods = cx.classMethods.get(cls)
  const sigs = methods?.get(m.name)
  if (!sigs) {
    cx.error(m.nameSpan, `'${cls}' has no method named '${m.name}'.${didYouMean(m.name, methods?.keys() ?? [])}`)
    return errExpr(span)
  }
  return nativeCall(cx, `${cls}.${m.name}`, sigs, recv, args, span)
}

/* ---------------- constructors ---------------- */

export function checkConstruct(cx: Sema, e: Construct): TExpr {
  if (e.type.name === 'String' && !e.type.named) return stringCtor(cx, e)
  const ty = cx.resolveType(e.type, 0, [], false)
  if (ty.t === 'error') return errExpr(e.span)
  if (ty.t === 'native') return nativeCtor(cx, ty.cls, e.args, e.span)
  if (ty.t === 'struct') return aggregateExpr(cx, ty, e.args, e.span)
  if (isArithmetic(ty) && e.args.length === 1) return convertTo(cx, checkExpr(cx, e.args[0]), ty, e.span, 'cast')
  cx.error(e.span, `Cannot construct '${typeName(ty)}' this way`)
  return errExpr(e.span)
}

export function nativeCtor(cx: Sema, cls: string, argExprs: Expr[], span: Span): TExpr {
  const sig = cx.classes.get(cls)
  if (!sig) return errExpr(span)
  const min = sig.ctorParams.length - (sig.ctorOptional ?? 0)
  if (argExprs.length < min || argExprs.length > sig.ctorParams.length) {
    const want = min === sig.ctorParams.length ? `${min}` : `${min} to ${sig.ctorParams.length}`
    cx.error(span, `${cls}(...) takes ${want} constructor argument${sig.ctorParams.length === 1 ? '' : 's'}, got ${argExprs.length}`)
    return errExpr(span)
  }
  const args = argExprs.map((a, i) => nativeArg(cx, sig.ctorParams[i], checkExpr(cx, a), a.span))
  if (args.some((a) => a.ty.t === 'error')) return errExpr(span)
  return { k: 'construct', ty: { t: 'native', cls }, cls: cx.classSite(cls), args, span }
}

/** String(), String(x), String(n, HEX), String(f, digits). */
function stringCtor(cx: Sema, e: Construct): TExpr {
  const span = e.span
  if (e.args.length === 0) return { k: 'const', ty: T.string, value: '', span }
  if (e.args.length > 2) {
    cx.error(span, `String(...) takes 1 or 2 arguments, got ${e.args.length}`)
    return errExpr(span)
  }
  const v = checkExpr(cx, e.args[0])
  if (v.ty.t === 'error') return v
  if (e.args.length === 1) return toStringExpr(cx, v, span)
  const second = checkExpr(cx, e.args[1])
  if (second.ty.t === 'error') return second
  if (!isArithmetic(v.ty) || !isInteger(second.ty)) {
    cx.error(span, 'String(value, format) needs a number and an integer base (DEC, HEX, OCT, BIN) or decimal places')
    return errExpr(span)
  }
  const fmt = numConvert(cx, second, T.int)
  if (isFloating(v.ty)) return { k: 'builtin', ty: T.string, id: B.STR_FLOAT, args: [numConvert(cx, v, T.double), fmt], site: -1, span }
  const p = v.ty.t === 'prim' ? v.ty.p : 'int'
  // String(n, base) prints through itoa/ltoa: the value's promoted width decides the two's complement digits
  const bits = p === 'long' || p === 'ulong' ? 32 : cx.intBits
  return { k: 'builtin', ty: T.string, id: B.STR_INT, args: [v, fmt, constNum(T.int, bits, span)], site: -1, span }
}
