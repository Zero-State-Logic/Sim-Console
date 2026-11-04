/* ============================================================
   EXPRESSION CODEGEN — typed IR → stack code. `keep` says
   whether the value must stay on the stack. Locals and globals
   get direct opcodes; every other place goes through an
   address pair (container, index), which also implements
   reference parameters.
   ============================================================ */

import { B } from '../builtins'
import { Op } from '../bytecode'
import { isFloating, type CType } from '../ctypes'
import type { TExpr, TInit, TLValue } from '../tir'
import type { Emitter } from './emitter'

/** No bounds error can happen on this access (an address made by the compiler). */
const NO_SITE = -1

export class ExprGen {
  constructor(readonly em: Emitter) {}

  gen(e: TExpr, keep: boolean): void {
    const em = this.em
    switch (e.k) {
      case 'const': return keep ? this.constant(e.ty, e.value) : undefined
      case 'load': return this.load(e.lv, keep)
      case 'unary':
        this.gen(e.e, keep)
        if (!keep) return
        if (e.op === 'not') return em.op(Op.NOT)
        em.op(e.op === 'neg' ? Op.NEG : Op.BNOT)
        return em.wrap(e.ty)
      case 'binary': return this.binary(e, keep)
      case 'cmp':
        this.gen(e.l, keep)
        this.gen(e.r, keep)
        if (keep) em.op(CMP_OPS[e.op])
        return
      case 'logic': return this.logic(e, keep)
      case 'convert':
        if (e.ty.t === 'prim' && e.ty.p === 'void') return this.gen(e.e, false)
        this.gen(e.e, keep)
        if (keep) em.convert(e.from, e.ty)
        return
      case 'assign': return this.assign(e.lv, e.value, keep)
      case 'compound': return this.compound(e, keep)
      case 'incdec': return this.incdec(e.lv, e.delta, e.prefix, keep)
      case 'cond': return this.cond(e, keep)
      case 'call': return this.call(e, keep)
      case 'builtin': return this.builtin(e, keep)
      case 'native': return this.native(e, keep)
      case 'construct':
        em.mark(e.span)
        for (const a of e.args) this.gen(a, true)
        em.op(Op.NEWN, e.cls, e.args.length)
        return keep ? undefined : em.op(Op.POP)
      case 'concat':
      case 'tostr':
      case 'chars2str':
      case 'strIdx':
      case 'ptrAdd': return this.text(e, keep)
      case 'strMutate': return this.strMutate(e, keep)
      case 'comma':
        this.gen(e.a, false)
        return this.gen(e.b, keep)
      case 'copy':
        this.gen(e.e, keep)
        return keep ? em.op(Op.COPY) : undefined
      case 'sleep':
      case 'yield': return this.timing(e)
      case 'newobj': return keep ? em.op(Op.NEWOBJ, em.typeIndex(e.ty)) : undefined
      case 'aggregate':
        this.initValue(e.init)
        return keep ? undefined : em.op(Op.POP)
    }
  }

  /** String-producing and String-indexing nodes. */
  private text(e: Extract<TExpr, { k: 'concat' | 'tostr' | 'chars2str' | 'strIdx' | 'ptrAdd' }>, keep: boolean): void {
    const em = this.em
    switch (e.k) {
      case 'concat':
        this.gen(e.l, keep)
        this.gen(e.r, keep)
        return keep ? em.op(Op.CONCAT) : undefined
      case 'tostr':
        this.gen(e.e, keep)
        return keep ? em.op(Op.TOSTR, e.kind) : undefined
      case 'chars2str':
        this.gen(e.e, keep)
        return keep ? em.op(Op.CHARS2STR) : undefined
      case 'strIdx':
        this.gen(e.s, true)
        this.gen(e.idx, true)
        em.mark(e.span)
        em.op(Op.STR_INDEX, e.site)
        return keep ? undefined : em.op(Op.POP)
      case 'ptrAdd':
        this.gen(e.s, true)
        this.gen(e.n, true)
        em.mark(e.span)
        em.op(Op.PTR_ADD, e.site)
        return keep ? undefined : em.op(Op.POP)
    }
  }

  /** delay() / delayMicroseconds() / yield(): suspension points. */
  private timing(e: Extract<TExpr, { k: 'sleep' | 'yield' }>): void {
    const em = this.em
    em.mark(e.span)
    if (e.k === 'yield') return em.op(Op.YIELD)
    this.gen(e.ms, true)
    if (e.micro) {
      em.pushNumber(1000)
      em.op(Op.DIV)
    }
    em.op(Op.SLEEP)
  }

  constant(ty: CType, v: number | string): void {
    if (typeof v === 'string') this.em.op(Op.PUSH_K, this.em.constIndex(v))
    else if (ty.t === 'object') this.em.op(Op.PUSH_I, 1)
    else this.em.pushNumber(v)
  }

  /** Pushes the zero value of a type. */
  defaultValue(ty: CType): void {
    if (ty.t === 'array' || ty.t === 'struct') this.em.op(Op.NEWOBJ, this.em.typeIndex(ty))
    else if (ty.t === 'prim' && (ty.p === 'string' || ty.p === 'cstr')) this.em.op(Op.PUSH_K, this.em.constIndex(''))
    else this.em.op(Op.PUSH_I, 0)
  }

  /** Pushes the value of an initializer. */
  initValue(init: TInit): void {
    const em = this.em
    switch (init.k) {
      case 'expr': return this.gen(init.e, true)
      case 'default': return this.defaultValue(init.ty)
      case 'const':
        if (Array.isArray(init.value)) return em.op(Op.CLONE_K, em.constIndex(init.value))
        return this.constant(init.ty, init.value)
      case 'ctor':
        for (const a of init.args) this.gen(a, true)
        return em.op(Op.NEWN, init.cls, init.args.length)
      case 'list':
        em.op(Op.NEWOBJ, em.typeIndex(init.ty))
        init.items.forEach((item, i) => {
          // NEWOBJ already holds zero values (and constructed natives)
          if (item.k === 'default') return
          em.op(Op.DUP)
          em.op(Op.PUSH_I, i)
          this.initValue(item)
          em.op(Op.STORE_IDX, NO_SITE)
        })
    }
  }

  /* ---------------- places ---------------- */

  load(lv: TLValue, keep: boolean): void {
    const em = this.em
    switch (lv.k) {
      case 'local':
        if (keep) em.op(lv.ref ? Op.LOAD_R : Op.LOAD_L, lv.slot)
        return
      case 'global':
        if (keep) em.op(Op.LOAD_G, lv.index)
        return
      case 'index':
        this.gen(lv.arr, true)
        this.gen(lv.idx, true)
        em.op(Op.LOAD_IDX, lv.site)
        return keep ? undefined : em.op(Op.POP)
      case 'field':
        this.gen(lv.obj, keep)
        return keep ? em.op(Op.LOAD_FIELD, lv.field) : undefined
      case 'strIndex':
        this.load(lv.str, true)
        this.gen(lv.idx, true)
        em.op(Op.STR_INDEX, lv.site)
        return keep ? undefined : em.op(Op.POP)
    }
  }

  /** Pushes (container, index) for a place. */
  address(lv: TLValue): void {
    const em = this.em
    switch (lv.k) {
      case 'local': return em.op(lv.ref ? Op.ADDR_R : Op.ADDR_L, lv.slot)
      case 'global': return em.op(Op.ADDR_G, lv.index)
      case 'index':
        this.gen(lv.arr, true)
        this.gen(lv.idx, true)
        return em.op(Op.CHECK_IDX, lv.site)
      case 'field':
        this.gen(lv.obj, true)
        return em.op(Op.PUSH_I, lv.field)
      case 'strIndex':
        throw new Error('internal: address of a String character')
    }
  }

  /** Direct load/store opcodes for locals and globals (fast path), or null. */
  private direct(lv: TLValue): { load: number; store: number; arg: number } | null {
    if (lv.k === 'local') return { load: lv.ref ? Op.LOAD_R : Op.LOAD_L, store: lv.ref ? Op.STORE_R : Op.STORE_L, arg: lv.slot }
    if (lv.k === 'global') return { load: Op.LOAD_G, store: Op.STORE_G, arg: lv.index }
    return null
  }

  assign(lv: TLValue, value: TExpr, keep: boolean): void {
    const em = this.em
    if (lv.ty.t === 'struct') {
      this.load(lv, true)
      this.gen(value, true)
      em.op(Op.COPY_INTO)
      if (keep) this.load(lv, true)
      return
    }
    const d = this.direct(lv)
    if (d) {
      this.gen(value, true)
      if (keep) em.op(Op.DUP)
      return em.op(d.store, d.arg)
    }
    if (lv.k === 'index') {
      this.gen(lv.arr, true)
      this.gen(lv.idx, true)
      this.gen(value, true)
      return em.op(keep ? Op.STORE_IDX_K : Op.STORE_IDX, lv.site)
    }
    if (lv.k === 'field') {
      this.gen(lv.obj, true)
      this.gen(value, true)
      return em.op(keep ? Op.STORE_FIELD_K : Op.STORE_FIELD, lv.field)
    }
    // s[i] = c → s = s.setCharAt(i, c)
    const s = lv as Extract<TLValue, { k: 'strIndex' }>
    this.address(s.str)
    em.op(Op.DUP2)
    em.op(Op.LOAD_IDX, NO_SITE)
    this.gen(s.idx, true)
    this.gen(value, true)
    em.op(Op.CALLB, B.S_SETCHARAT, 3, s.site)
    em.op(Op.STORE_IDX, NO_SITE)
    if (keep) this.gen(value, true)
  }

  private compound(e: Extract<TExpr, { k: 'compound' }>, keep: boolean): void {
    const em = this.em
    const d = this.direct(e.lv)
    if (d) em.op(d.load, d.arg)
    else {
      this.address(e.lv)
      em.op(Op.DUP2)
      em.op(Op.LOAD_IDX, NO_SITE)
    }
    if (e.op === 'concat') {
      this.gen(e.value, true)
      em.op(Op.CONCAT)
    } else {
      em.convert(e.lv.ty, e.opTy)
      this.gen(e.value, true)
      this.arith(e.op, e.opTy, e.site)
      em.convert(e.opTy, e.lv.ty)
    }
    if (d) {
      if (keep) em.op(Op.DUP)
      em.op(d.store, d.arg)
    } else {
      em.op(keep ? Op.STORE_IDX_K : Op.STORE_IDX, NO_SITE)
    }
  }

  private incdec(lv: TLValue, delta: 1 | -1, prefix: boolean, keep: boolean): void {
    const em = this.em
    const d = this.direct(lv)
    const step = (): void => {
      em.op(Op.PUSH_I, 1)
      em.op(delta > 0 ? Op.ADD : Op.SUB)
      em.wrap(lv.ty)
    }
    if (d) {
      em.op(d.load, d.arg)
      if (keep && !prefix) em.op(Op.DUP)
      step()
      if (keep && prefix) em.op(Op.DUP)
      return em.op(d.store, d.arg)
    }
    this.address(lv)
    em.op(Op.DUP2)
    em.op(Op.LOAD_IDX, NO_SITE)
    if (keep && !prefix) em.op(Op.DUP_X2)
    step()
    em.op(keep && prefix ? Op.STORE_IDX_K : Op.STORE_IDX, NO_SITE)
  }

  private strMutate(e: Extract<TExpr, { k: 'strMutate' }>, keep: boolean): void {
    const em = this.em
    em.mark(e.span)
    this.address(e.lv)
    em.op(Op.DUP2)
    em.op(Op.LOAD_IDX, NO_SITE)
    for (const a of e.args) this.gen(a, true)
    em.op(Op.CALLB, e.id, e.args.length + 1, NO_SITE)
    em.op(Op.STORE_IDX, NO_SITE)
    if (keep && e.result === 'true') em.op(Op.PUSH_I, 1)
  }

  /* ---------------- operators ---------------- */

  private binary(e: Extract<TExpr, { k: 'binary' }>, keep: boolean): void {
    this.gen(e.l, true)
    this.gen(e.r, true)
    if (e.site >= 0) this.em.mark(e.span)
    this.arith(e.op, e.ty, e.site)
    if (!keep) this.em.op(Op.POP)
  }

  /** a op b (both on the stack, already in `ty`) → result in `ty`. */
  arith(op: string, ty: CType, site: number): void {
    const em = this.em
    if (isFloating(ty)) {
      em.op(op === '+' ? Op.ADD : op === '-' ? Op.SUB : op === '*' ? Op.MUL : Op.DIV)
      return em.wrap(ty)
    }
    const wide = ty.t === 'prim' && (ty.p === 'long' || ty.p === 'ulong' || (this.em.intBits === 32 && (ty.p === 'int' || ty.p === 'uint')))
    const unsigned = ty.t === 'prim' && (ty.p === 'uint' || ty.p === 'ulong' || ty.p === 'uchar' || ty.p === 'ushort' || ty.p === 'bool')
    switch (op) {
      case '+': em.op(Op.ADD); break
      case '-': em.op(Op.SUB); break
      case '*': em.op(wide ? Op.IMUL : Op.MUL); break
      case '/': em.op(Op.IDIV, site); break
      case '%': em.op(Op.IMOD, site); break
      case '&': em.op(Op.BAND); break
      case '|': em.op(Op.BOR); break
      case '^': em.op(Op.BXOR); break
      case '<<': em.op(Op.SHL); break
      default: em.op(unsigned ? Op.USHR : Op.SHR)
    }
    em.wrap(ty)
  }

  private logic(e: Extract<TExpr, { k: 'logic' }>, keep: boolean): void {
    const em = this.em
    const end = em.newLabel()
    this.gen(e.l, true)
    if (!keep) {
      em.jump(e.op === '&&' ? Op.JZ : Op.JNZ, end)
      this.gen(e.r, false)
      return em.place(end)
    }
    const short = em.newLabel()
    em.jump(e.op === '&&' ? Op.JZ : Op.JNZ, short)
    this.gen(e.r, true)
    em.jump(Op.JMP, end)
    em.place(short)
    em.op(Op.PUSH_I, e.op === '&&' ? 0 : 1)
    em.place(end)
  }

  private cond(e: Extract<TExpr, { k: 'cond' }>, keep: boolean): void {
    const em = this.em
    const other = em.newLabel()
    const end = em.newLabel()
    this.gen(e.c, true)
    em.jump(Op.JZ, other)
    this.gen(e.a, keep)
    em.jump(Op.JMP, end)
    em.place(other)
    this.gen(e.b, keep)
    em.place(end)
  }

  /* ---------------- calls ---------------- */

  private call(e: Extract<TExpr, { k: 'call' }>, keep: boolean): void {
    for (const a of e.args) {
      if (a.k === 'ref') this.address(a.lv)
      else this.gen(a.e, true)
    }
    this.em.mark(e.span)
    this.em.op(Op.CALL, e.fn)
    if (!isVoidTy(e.ty) && !keep) this.em.op(Op.POP)
  }

  private builtin(e: Extract<TExpr, { k: 'builtin' }>, keep: boolean): void {
    for (const a of e.args) this.gen(a, true)
    this.em.mark(e.span)
    this.em.op(Op.CALLB, e.id, e.args.length, e.site)
    if (!keep || isVoidTy(e.ty)) return this.em.op(Op.POP)
    // results come back in JS doubles: wrap to the C type (double rounds to 32 bits on AVR)
    if (e.ty.t === 'prim' && e.ty.p !== 'string' && e.ty.p !== 'cstr') this.em.wrap(e.ty)
  }

  private native(e: Extract<TExpr, { k: 'native' }>, keep: boolean): void {
    if (e.self) this.gen(e.self, true)
    for (const a of e.args) this.gen(a, true)
    this.em.mark(e.span)
    this.em.op(Op.CALLN, e.site, e.args.length)
    if (!isVoidTy(e.ty) && !keep) this.em.op(Op.POP)
  }
}

const CMP_OPS: Record<string, number> = { '<': Op.LT, '<=': Op.LE, '>': Op.GT, '>=': Op.GE, '==': Op.EQ, '!=': Op.NE }

export function isVoidTy(ty: CType): boolean {
  return ty.t === 'prim' && ty.p === 'void'
}

