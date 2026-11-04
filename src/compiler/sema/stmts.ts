/* ============================================================
   STATEMENTS — function bodies: scopes, local and static
   variables, control flow, switch (with C fallthrough and the
   "jump crosses initialization" rule), range-for, break/continue
   placement and return types.
   ============================================================ */

import type { Declarator, Expr, ForRange, Stmt, Switch, VarDecl } from '../ast'
import { isArithmetic, isInteger, promote, sameType, T, typeName, type CType } from '../ctypes'
import type { Span } from '../diagnostics'
import type { TExpr, TInit, TLValue, TStmt } from '../tir'
import { byAddress } from './calls'
import type { Sema, VarSym } from './context'
import { constNum, convertTo, numConvert } from './convert'
import { checkCond, checkExpr, constIntOf, errExpr } from './exprs'
import { checkInit } from './init'
import { declareEnum, declareStruct, declareTypedef } from './typedecls'

export function checkBlockBody(cx: Sema, body: Stmt[]): TStmt[] {
  const out: TStmt[] = []
  for (const s of body) {
    const t = stmt(cx, s)
    if (t) out.push(t)
  }
  return out
}

function scoped(cx: Sema, s: Stmt): TStmt {
  cx.pushScope()
  const t = stmt(cx, s) ?? { k: 'block', body: [] }
  cx.popScope()
  return t
}

function stmt(cx: Sema, s: Stmt): TStmt | null {
  switch (s.kind) {
    case 'block': {
      cx.pushScope()
      const body = checkBlockBody(cx, s.body)
      cx.popScope()
      return { k: 'block', body }
    }
    case 'var': return { k: 'block', body: localDecl(cx, s) }
    case 'expr': return { k: 'expr', e: checkExpr(cx, s.expr), span: s.span }
    case 'if': {
      const c = checkCond(cx, s.cond)
      const t = scoped(cx, s.then)
      const e = s.else ? scoped(cx, s.else) : null
      return { k: 'if', c, t, e, span: s.span }
    }
    case 'while': return loop(cx, 'while', s.cond, null, s.body, s.span)
    case 'do': return loop(cx, 'do', s.cond, null, s.body, s.span)
    case 'for': return forStmt(cx, s)
    case 'forRange': return rangeFor(cx, s)
    case 'switch': return switchStmt(cx, s)
    case 'case':
    case 'default':
      cx.error(s.span, `'${s.kind}' label is only allowed directly inside a switch body`)
      return null
    case 'break':
      if (!cx.fx || cx.fx.breakables === 0) cx.error(s.span, "'break' is only allowed inside a loop or a switch")
      return { k: 'break', span: s.span }
    case 'continue':
      if (!cx.fx || cx.fx.loops === 0) cx.error(s.span, "'continue' is only allowed inside a loop")
      return { k: 'continue', span: s.span }
    case 'return': return returnStmt(cx, s.value, s.span)
    case 'empty': return null
    case 'localType': return localType(cx, s)
  }
}

function localType(cx: Sema, s: Extract<Stmt, { kind: 'localType' }>): TStmt | null {
  const d = s.decl
  if (d.kind === 'struct') declareStruct(cx, d)
  else if (d.kind === 'enum') declareEnum(cx, d)
  else declareTypedef(cx, d)
  return s.vars ? { k: 'block', body: localDecl(cx, s.vars) } : null
}

/* ---------------- loops ---------------- */

function enterLoop(cx: Sema, isLoop: boolean): void {
  if (!cx.fx) return
  if (isLoop) cx.fx.loops++
  cx.fx.breakables++
}

function leaveLoop(cx: Sema, isLoop: boolean): void {
  if (!cx.fx) return
  if (isLoop) cx.fx.loops--
  cx.fx.breakables--
}

function loop(cx: Sema, form: 'while' | 'do', cond: Expr, step: null, body: Stmt, span: Span): TStmt {
  const c = checkCond(cx, cond)
  enterLoop(cx, true)
  const b = scoped(cx, body)
  leaveLoop(cx, true)
  return { k: 'loop', form, c, step, body: b, span }
}

function forStmt(cx: Sema, s: Extract<Stmt, { kind: 'for' }>): TStmt {
  cx.pushScope()
  const init: TStmt[] = []
  if (s.init?.kind === 'var') init.push(...localDecl(cx, s.init))
  else if (s.init) init.push({ k: 'expr', e: checkExpr(cx, s.init.expr), span: s.init.span })
  const c = s.cond ? checkCond(cx, s.cond) : null
  const step = s.step ? checkExpr(cx, s.step) : null
  enterLoop(cx, true)
  const body = scoped(cx, s.body)
  leaveLoop(cx, true)
  cx.popScope()
  return { k: 'block', body: [...init, { k: 'loop', form: 'for', c, step, body, span: s.span }] }
}

/** for (T x : arr) → hidden index loop over a fixed-size array. */
function rangeFor(cx: Sema, s: ForRange): TStmt {
  const range = checkExpr(cx, s.range)
  if (range.ty.t === 'error') return { k: 'block', body: [] }
  if (range.ty.t !== 'array' || range.ty.len < 0) {
    cx.error(s.range.span, `A range-for needs an array with a known size, not '${typeName(range.ty)}'`)
    return { k: 'block', body: [] }
  }
  const arrTy = range.ty
  cx.pushScope()
  const arrSlot = cx.allocSlots(1)
  const idxSlot = cx.allocSlots(1)
  const arrLv: TLValue = { k: 'local', ty: arrTy, slot: arrSlot, ref: false, name: '__range' }
  const idxLv: TLValue = { k: 'local', ty: T.int, slot: idxSlot, ref: false, name: '__i' }
  const load = (lv: TLValue): TExpr => ({ k: 'load', ty: lv.ty, lv, span: s.span })
  const elemLv: TLValue = { k: 'index', ty: arrTy.elem, arr: load(arrLv), idx: numConvert(cx, load(idxLv), T.long), site: cx.site(s.range.span, 'range') }
  const elemTy = s.spec.inferred ? arrTy.elem : cx.resolveType(s.spec, 0, [], false)
  cx.pushScope()
  const v = cx.declareLocal(s.name, elemTy, s.nameSpan, s.isRef && byAddress({ ref: true, isConst: s.spec.isConst, ty: elemTy }), s.spec.isConst, false)
  v.reads++
  const bind: TStmt = v.ref
    ? { k: 'init', lv: { k: 'local', ty: elemTy, slot: v.slot, ref: true, name: s.name }, init: { k: 'expr', e: { k: 'load', ty: elemTy, lv: elemLv, span: s.span } }, span: s.span }
    : { k: 'init', lv: { k: 'local', ty: elemTy, slot: v.slot, ref: false, name: s.name }, init: { k: 'expr', e: convertTo(cx, load(elemLv), elemTy, s.span, s.isRef ? 'assign' : 'init') }, span: s.span }
  if (s.isRef && !sameType(elemTy, arrTy.elem)) cx.error(s.nameSpan, `Reference '${s.name}' must have the array's element type '${typeName(arrTy.elem)}'`)
  enterLoop(cx, true)
  const body = stmt(cx, s.body)
  leaveLoop(cx, true)
  cx.popScope()
  cx.popScope()
  const cond: TExpr = { k: 'cmp', ty: T.bool, op: '<', opTy: T.int, l: load(idxLv), r: constNum(T.int, arrTy.len, s.span), span: s.span }
  const step: TExpr = { k: 'incdec', ty: T.int, lv: idxLv, delta: 1, prefix: true, span: s.span }
  return {
    k: 'block',
    body: [
      { k: 'init', lv: arrLv, init: { k: 'expr', e: range }, span: s.span },
      { k: 'init', lv: idxLv, init: { k: 'expr', e: constNum(T.int, 0, s.span) }, span: s.span },
      { k: 'loop', form: 'for', c: cond, step, body: { k: 'block', body: [bind, ...(body ? [body] : [])] }, span: s.span },
    ],
  }
}

/* ---------------- switch ---------------- */

function switchStmt(cx: Sema, s: Switch): TStmt {
  const raw = checkExpr(cx, s.expr)
  let e: TExpr = raw
  if (raw.ty.t !== 'error' && !isInteger(raw.ty)) {
    cx.error(s.expr.span, `switch needs an integer, char or enum value, not '${typeName(raw.ty)}'${isArithmetic(raw.ty) ? '. Convert it with (int)' : ''}`)
    e = errExpr(s.expr.span)
  }
  const ty: CType = e.ty.t === 'error' ? T.int : promote(e.ty, cx.intBits)
  e = numConvert(cx, e, ty)
  const slot = cx.allocSlots(1)
  if (s.body.kind !== 'block') {
    cx.error(s.body.span, 'The body of a switch must be a block { ... }')
    return { k: 'expr', e, span: s.span }
  }
  const cases: { value: number; label: number }[] = []
  let defaultLabel = -1
  const body: TStmt[] = []
  let crossed: { name: string; span: Span } | null = null
  cx.pushScope()
  enterLoop(cx, false)
  for (const item of s.body.body) {
    if (item.kind === 'case' || item.kind === 'default') {
      if (crossed) {
        cx.error(item.span, `Jumping to this ${item.kind === 'case' ? 'case' : 'default'} label skips the initialisation of '${crossed.name}' (line ${crossed.span.line}). Put that case's statements in braces { ... }`)
        crossed = null
      }
      const label = cx.newLabel()
      body.push({ k: 'label', id: label })
      if (item.kind === 'default') {
        if (defaultLabel >= 0) cx.error(item.span, "Multiple 'default' labels in one switch")
        defaultLabel = label
        continue
      }
      const v = caseValue(cx, item.value, ty)
      if (v === null) continue
      if (cases.some((c) => c.value === v)) cx.error(item.value.span, `Duplicate case value ${v}`)
      cases.push({ value: v, label })
      continue
    }
    if (item.kind === 'var') crossed = initializedName(item) ?? crossed
    const t = stmt(cx, item)
    if (t) body.push(t)
  }
  leaveLoop(cx, false)
  cx.popScope()
  return { k: 'switch', slot, e, cases, defaultLabel, body, span: s.span }
}

function initializedName(d: VarDecl): { name: string; span: Span } | null {
  const hit = d.decls.find((x) => x.init || x.ctorArgs)
  return hit ? { name: hit.name, span: hit.nameSpan } : null
}

function caseValue(cx: Sema, e: Expr, ty: CType): number | null {
  const v = constIntOf(cx, e)
  if (v === null) {
    cx.error(e.span, 'A case label must be an integer constant (a number, a char like \'a\', an enum member or a const int)')
    return null
  }
  const c = numConvert(cx, constNum(T.long, v, e.span), ty)
  return c.k === 'const' && typeof c.value === 'number' ? c.value : v
}

/* ---------------- return ---------------- */

function returnStmt(cx: Sema, value: Expr | null, span: Span): TStmt {
  const fn = cx.fx?.fn
  if (!fn) return { k: 'return', e: null, span }
  const isVoid = fn.ret.t === 'prim' && fn.ret.p === 'void'
  if (!value) {
    if (!isVoid && fn.ret.t !== 'error') cx.error(span, `'${fn.name}' must return a value of type '${typeName(fn.ret)}'`)
    return { k: 'return', e: null, span }
  }
  const v = checkExpr(cx, value)
  if (isVoid) {
    if (v.ty.t === 'prim' && v.ty.p === 'void') return { k: 'block', body: [{ k: 'expr', e: v, span }, { k: 'return', e: null, span }] }
    if (v.ty.t !== 'error') cx.error(value.span, `'${fn.name}' is void and cannot return a value`)
    return { k: 'return', e: null, span }
  }
  return { k: 'return', e: convertTo(cx, v, fn.ret, value.span, 'return'), span }
}

/* ---------------- declarations ---------------- */

/** Local (or static local) variable declaration → init statements. */
export function localDecl(cx: Sema, d: VarDecl): TStmt[] {
  const out: TStmt[] = []
  for (const decl of d.decls) {
    if (decl.isRef) {
      cx.error(decl.nameSpan, `Reference variables ('${decl.name}') are only supported as function parameters`)
      continue
    }
    const r = declType(cx, d, decl)
    if (!r) continue
    if (d.spec.isStatic) out.push(staticLocal(cx, d, decl, r.ty, r.init))
    else out.push(declareLocalVar(cx, d, decl, r.ty, r.init))
  }
  return out
}

function declareLocalVar(cx: Sema, d: VarDecl, decl: Declarator, ty: CType, init: TInit): TStmt {
  const sym = cx.declareLocal(decl.name, ty, decl.nameSpan, false, d.spec.isConst, false)
  setConstValue(sym, init)
  return { k: 'init', lv: { k: 'local', ty, slot: sym.slot, ref: false, name: decl.name }, init, span: decl.span }
}

function staticLocal(cx: Sema, d: VarDecl, decl: Declarator, ty: CType, init: TInit): TStmt {
  const owner = cx.fx?.fn.name ?? ''
  const index = cx.addGlobal(`${owner}::${decl.name}`, ty, false)
  const guard = cx.addGlobal(`__guard_${owner}_${decl.name}`, T.bool, true)
  const sym: VarSym = {
    kind: 'var', name: decl.name, ty, storage: 'global', slot: index, ref: false, isConst: d.spec.isConst,
    constValue: null, span: decl.nameSpan, isParam: false, reads: 0, writes: 0,
  }
  cx.declare(sym, decl.nameSpan)
  setConstValue(sym, init)
  return { k: 'staticInit', guard, lv: { k: 'global', ty, index, name: decl.name }, init, span: decl.span }
}

export function setConstValue(sym: VarSym, init: TInit): void {
  if (!sym.isConst || init.k !== 'expr' || init.e.k !== 'const' || sym.ty.t !== 'prim') return
  if (sym.ty.p === 'string') return
  sym.constValue = init.e.value
}

/** Type (with inference for auto / let / var) and initializer of one declarator. */
export function declType(cx: Sema, d: VarDecl, decl: Declarator): { ty: CType; init: TInit } | null {
  if (d.spec.inferred) return inferred(cx, d, decl)
  // an unsized first dimension is completed (or reported by name) by checkInit
  let ty = cx.resolveType(d.spec, decl.pointer, decl.dims, true)
  if (ty.t === 'prim' && ty.p === 'void') {
    cx.error(decl.nameSpan, `Variable '${decl.name}' cannot have type 'void'`)
    return null
  }
  if (d.spec.isConst && !decl.init && !decl.ctorArgs && ty.t !== 'native' && ty.t !== 'error') {
    cx.error(decl.nameSpan, `const '${decl.name}' must be given a value where it is declared`)
  }
  const r = checkInit(cx, ty, decl.init, decl.ctorArgs, decl.span, decl.name)
  ty = r.ty
  return { ty, init: r.init }
}

function inferred(cx: Sema, d: VarDecl, decl: Declarator): { ty: CType; init: TInit } | null {
  const word = d.spec.name === 'auto' ? 'auto' : 'let/var/const'
  if (!decl.init || decl.dims.length > 0) {
    cx.error(decl.nameSpan, `'${decl.name}' needs an initial value so its type can be inferred (${word}), or write the type, e.g. 'int ${decl.name} = 0;'`)
    return null
  }
  if (decl.init.kind === 'initList') {
    cx.error(decl.init.span, `Cannot infer a type from a brace list; write the array type, e.g. 'int ${decl.name}[] = { ... };'`)
    return null
  }
  const v = checkExpr(cx, decl.init)
  if (v.ty.t === 'error') return null
  if (v.ty.t === 'prim' && v.ty.p === 'void') {
    cx.error(decl.init.span, `Cannot infer the type of '${decl.name}' from a void value`)
    return null
  }
  if (v.ty.t === 'object' || v.ty.t === 'array') {
    cx.error(decl.init.span, `Cannot infer a variable type from '${typeName(v.ty)}'`)
    return null
  }
  // JS-flavoured declarations make text a String; C++ `auto` keeps const char*
  const textAsString = word !== 'auto' && v.ty.t === 'prim' && v.ty.p === 'cstr'
  const ty = textAsString ? T.string : v.ty
  return { ty, init: { k: 'expr', e: convertTo(cx, v, ty, decl.init.span, 'init') } }
}
