/* ============================================================
   SEMANTIC ANALYSIS ENTRY — walks the translation unit:
   types and globals in source order, every function signature
   hoisted (Arduino generates prototypes, so a function can be
   called above its definition), then each body. Produces the
   typed program for the bytecode generator.
   ============================================================ */

import type { CompileOptions } from '../api'
import type { Block, FuncDecl, Param, TopLevel, TranslationUnit, VarDecl } from '../ast'
import { sameType, T, typeName, type CType } from '../ctypes'
import type { DiagBag } from '../diagnostics'
import type { TFunction, TParam, TProgram, TStmt } from '../tir'
import { byAddress } from './calls'
import { Sema, type FnSym } from './context'
import { constIntOf } from './exprs'
import { checkBlockBody, declType, setConstValue } from './stmts'
import { declareEnum, declareStruct, declareTypedef } from './typedecls'

export function analyze(tu: TranslationUnit, opts: CompileOptions, diags: DiagBag): TProgram {
  const cx = new Sema(opts, diags)
  cx.evalConstInt = (e) => constIntOf(cx, e)
  for (const item of tu.items) prescanGlobal(cx, item)
  const simpleFns = tu.items.filter((i): i is FuncDecl => i.kind === 'func' && usesOnlyBuiltinTypes(i))
  for (const f of simpleFns) declareFunction(cx, f)
  for (const item of tu.items) topLevel(cx, item, simpleFns)
  const bodies = checkBodies(cx, tu)
  return assemble(cx, bodies)
}

function prescanGlobal(cx: Sema, item: TopLevel): void {
  if (item.kind !== 'var') return
  for (const d of item.decls) if (!cx.laterGlobals.has(d.name)) cx.laterGlobals.set(d.name, d.nameSpan)
}

/** Signatures without struct / typedef / enum names can be resolved before any type is declared. */
function usesOnlyBuiltinTypes(f: FuncDecl): boolean {
  return !f.ret.named && !f.ret.inferred && f.params.every((p) => !p.spec.named && !p.spec.inferred && p.dims.every((d) => d === null || d.kind === 'int'))
}

function topLevel(cx: Sema, item: TopLevel, hoisted: FuncDecl[]): void {
  switch (item.kind) {
    case 'struct': return declareStruct(cx, item)
    case 'enum': return declareEnum(cx, item)
    case 'typedef': return declareTypedef(cx, item)
    case 'var': return globalVar(cx, item)
    case 'func':
      if (!hoisted.includes(item)) declareFunction(cx, item)
  }
}

/* ---------------- globals ---------------- */

function globalVar(cx: Sema, d: VarDecl): void {
  for (const decl of d.decls) {
    cx.laterGlobals.delete(decl.name)
    if (decl.isRef) {
      cx.error(decl.nameSpan, `Reference variable '${decl.name}' must be a function parameter`)
      continue
    }
    if (cx.fns.has(decl.name)) {
      cx.error(decl.nameSpan, `'${decl.name}' is already a function name`)
      continue
    }
    const r = declType(cx, d, decl)
    if (!r) continue
    const sym = cx.declareGlobal(decl.name, r.ty, decl.nameSpan, d.spec.isConst)
    setConstValue(sym, r.init)
    cx.globalInits.push({ k: 'init', lv: { k: 'global', ty: r.ty, index: sym.slot, name: decl.name }, init: r.init, span: decl.span })
  }
}

/* ---------------- functions ---------------- */

function paramType(cx: Sema, p: Param): CType {
  if (p.spec.inferred) {
    cx.error(p.span, `Parameter '${p.name ?? ''}' needs an explicit type`)
    return T.error
  }
  const ty = cx.resolveType(p.spec, 0, p.dims, true)
  if (ty.t === 'prim' && ty.p === 'void') {
    cx.error(p.span, `Parameter '${p.name ?? ''}' cannot be void`)
    return T.error
  }
  if (p.isRef && ty.t === 'array') {
    cx.error(p.span, 'References to arrays are not supported; arrays are always passed by reference anyway: use int a[]')
    return T.error
  }
  return ty
}

function declareFunction(cx: Sema, f: FuncDecl): void {
  const ret = f.ret.inferred ? T.error : cx.resolveType(f.ret, 0, [], false)
  if (f.ret.inferred) cx.error(f.ret.span, `Function '${f.name}' needs an explicit return type`)
  if (ret.t === 'array') cx.error(f.ret.span, 'Functions cannot return arrays')
  const params = f.params.map((p) => ({ name: p.name, ty: paramType(cx, p), ref: p.isRef, isConst: p.spec.isConst, defaultValue: p.defaultValue }))
  const list = cx.fns.get(f.name) ?? []
  const same = list.find((g) => g.params.length === params.length && g.params.every((p, i) => sameType(p.ty, params[i].ty) && p.ref === params[i].ref))
  if (same) return mergeDeclaration(cx, same, f, ret, params)
  if (cx.global.vars.has(f.name)) cx.error(f.nameSpan, `'${f.name}' is already declared as a variable`)
  checkDefaults(cx, f)
  const sym: FnSym = { index: cx.fnList.length, name: f.name, params, ret, span: f.nameSpan, defined: f.body !== null, used: false, decl: f }
  cx.fnList.push(sym)
  cx.fns.set(f.name, [...list, sym])
}

function mergeDeclaration(cx: Sema, existing: FnSym, f: FuncDecl, ret: CType, params: FnSym['params']): void {
  if (!sameType(existing.ret, ret)) {
    cx.error(f.ret.span, `'${f.name}' was declared returning '${typeName(existing.ret)}' (line ${existing.span.line}) but here returns '${typeName(ret)}'`)
  }
  if (f.body) {
    if (existing.defined) {
      cx.error(f.nameSpan, `Redefinition of '${f.name}' (first defined on line ${existing.span.line})`)
      return
    }
    existing.defined = true
    existing.span = f.nameSpan
    // keep default arguments from the prototype, names from the definition
    existing.params = params.map((p, i) => ({ ...p, defaultValue: existing.params[i].defaultValue ?? p.defaultValue }))
    existing.decl = f
  }
}

function checkDefaults(cx: Sema, f: FuncDecl): void {
  let seen = false
  for (const p of f.params) {
    if (p.defaultValue) seen = true
    else if (seen) cx.error(p.span, `Parameter '${p.name ?? ''}' needs a default value because an earlier parameter has one`)
  }
}

function checkBodies(cx: Sema, tu: TranslationUnit): TFunction[] {
  const out: TFunction[] = cx.fnList.map((f) => ({
    name: f.name, params: [], ret: f.ret, paramSlots: 0, frameSlots: 0, body: [], span: f.span, defined: false,
  }))
  for (const item of tu.items) {
    if (item.kind !== 'func' || !item.body) continue
    const sym = (cx.fns.get(item.name) ?? []).find((s) => s.decl === item)
    if (sym) out[sym.index] = checkFunction(cx, sym, item.body)
  }
  return out
}

function checkFunction(cx: Sema, fn: FnSym, body: Block): TFunction {
  cx.fx = { fn, slots: 0, loops: 0, breakables: 0 }
  cx.pushScope()
  const params: TParam[] = []
  fn.params.forEach((p, i) => {
    const name = p.name ?? `__arg${i}`
    const addr = byAddress(p)
    const v = cx.declareLocal(name, p.ty, fn.decl.params[i]?.nameSpan ?? fn.span, addr, p.isConst, true)
    params.push({ name, ty: p.ty, ref: addr, slot: v.slot })
  })
  const paramSlots = cx.fx.slots
  const stmts = checkBlockBody(cx, body.body)
  cx.popScope()
  const isVoid = fn.ret.t === 'prim' && fn.ret.p === 'void'
  if (!isVoid && fn.ret.t !== 'error' && !terminates(stmts)) {
    cx.warning(fn.span, `Control can reach the end of '${fn.name}' without returning a value (it then returns 0)`)
  }
  const frameSlots = cx.fx.slots
  cx.fx = null
  return { name: fn.name, params, ret: fn.ret, paramSlots, frameSlots, body: stmts, span: fn.span, defined: true }
}

/** Can control fall off the end of this statement list? */
function terminates(list: TStmt[]): boolean {
  return list.some(stmtTerminates)
}

function stmtTerminates(s: TStmt): boolean {
  switch (s.k) {
    case 'return': return true
    case 'block': return terminates(s.body)
    case 'if': return s.e !== null && stmtTerminates(s.t) && stmtTerminates(s.e)
    case 'loop': return (s.c === null || (s.c.k === 'const' && s.c.value !== 0)) && s.form !== 'do' ? !hasBreak(s.body) : false
    case 'switch': return switchTerminates(s)
    default: return false
  }
}

/** With a default label and no break, control leaves a switch only by falling off its last statement. */
function switchTerminates(s: Extract<TStmt, { k: 'switch' }>): boolean {
  if (s.defaultLabel < 0 || s.body.some(hasBreak)) return false
  const last = [...s.body].reverse().find((b) => b.k !== 'label')
  return last !== undefined && s.body[s.body.length - 1].k !== 'label' && stmtTerminates(last)
}

function hasBreak(s: TStmt): boolean {
  switch (s.k) {
    case 'break': return true
    case 'block': return s.body.some(hasBreak)
    case 'if': return hasBreak(s.t) || (s.e !== null && hasBreak(s.e))
    default: return false
  }
}

/* ---------------- assembly ---------------- */

function assemble(cx: Sema, functions: TFunction[]): TProgram {
  for (const f of cx.fnList) {
    if (!f.defined && f.used) cx.error(f.span, `Function '${f.name}' is declared and called, but never defined (it has no body)`)
  }
  const find = (name: string): number => {
    const f = (cx.fns.get(name) ?? []).find((s) => s.params.length === 0)
    if (!f) return -1
    if (!f.defined) {
      cx.error(f.span, `${name}() is declared but never defined: give it a body, ${name}() { ... }`)
      return -1
    }
    if (!(f.ret.t === 'prim' && f.ret.p === 'void')) cx.warning(f.span, `${name}() should return void`)
    return f.index
  }
  const setup = find('setup')
  const loop = find('loop')
  const start = { line: 1, col: 1, endLine: 1, endCol: 1 }
  if (setup < 0 && loop < 0) cx.warning(start, 'No setup() or loop() found: there is nothing to run')
  else if (loop < 0) cx.warning(start, 'No loop() found: the program stops after setup()')
  return {
    intBits: cx.intBits,
    functions,
    globals: cx.globals,
    globalInits: cx.globalInits,
    structs: cx.structs.map((s) => ({ name: s.name, fields: s.fields.map((f) => ({ name: f.name, ty: f.ty })) })),
    natives: cx.natives,
    classes: cx.classSites,
    sites: cx.sites,
    setup,
    loop,
  }
}

