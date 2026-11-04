/* ============================================================
   PROGRAM CODEGEN — statements, functions and the program
   driver: global initialisers, setup() once, then loop() forever
   with a LOOPDONE marker after each iteration so the VM can
   yield to the host between loops.
   ============================================================ */

import { Op, PROGRAM_VERSION, type BytecodeProgram, type FnDesc } from '../bytecode'
import type { TFunction, TInit, TLValue, TProgram, TStmt } from '../tir'
import { Emitter } from './emitter'
import { ExprGen, isVoidTy } from './expr'

interface LoopLabels {
  brk: number
  cont: number
}

export function generate(p: TProgram): BytecodeProgram {
  return new ProgramGen(p).run()
}

class ProgramGen {
  private readonly em: Emitter
  private readonly ex: ExprGen
  private readonly loops: LoopLabels[] = []

  constructor(private readonly p: TProgram) {
    this.em = new Emitter(p.intBits, (id) => p.structs[id]?.fields.map((f) => f.ty) ?? [])
    this.ex = new ExprGen(this.em)
  }

  run(): BytecodeProgram {
    const { em, p } = this
    const entry = em.pc
    for (const s of p.globalInits) this.stmt(s)
    if (p.setup >= 0) em.op(Op.CALL, p.setup)
    if (p.loop >= 0) {
      const top = em.newLabel()
      em.place(top)
      em.op(Op.CALL, p.loop)
      em.op(Op.LOOPDONE)
      em.jump(Op.JMP, top)
    }
    em.op(Op.HALT)
    const functions: FnDesc[] = p.functions.map((f) => this.fn(f))
    em.link()
    return {
      kind: 'kiyo-bytecode', version: PROGRAM_VERSION, hasSetup: p.setup >= 0, hasLoop: p.loop >= 0, intBits: p.intBits,
      code: em.code, consts: em.consts, functions,
      globals: p.globals.map((g) => ({ name: g.name, type: em.typeIndex(g.ty), hidden: g.hidden })),
      types: em.types,
      structs: p.structs.map((s) => ({ name: s.name, fields: s.fields.map((f) => ({ name: f.name, type: em.typeIndex(f.ty) })) })),
      sites: p.sites, natives: p.natives, classes: p.classes,
      linePcs: em.linePcs, lineNos: em.lineNos, colNos: em.colNos, entry,
    }
  }

  private fn(f: TFunction): FnDesc {
    const em = this.em
    const entry = em.pc
    if (!f.defined) return { name: f.name, entry: -1, paramSlots: 0, frameSlots: 0, line: f.span.line }
    em.mark(f.span)
    for (const s of f.body) this.stmt(s)
    // falling off the end: void returns, anything else returns its zero value
    if (isVoidTy(f.ret)) em.op(Op.RET)
    else {
      this.ex.defaultValue(f.ret)
      em.op(Op.RETV)
    }
    return { name: f.name, entry, paramSlots: f.paramSlots, frameSlots: f.frameSlots, line: f.span.line }
  }

  private stmt(s: TStmt): void {
    const { em, ex } = this
    switch (s.k) {
      case 'expr':
        em.mark(s.span)
        return ex.gen(s.e, false)
      case 'init':
        em.mark(s.span)
        return this.init(s.lv, s.init)
      case 'staticInit': {
        em.mark(s.span)
        const done = em.newLabel()
        em.op(Op.LOAD_G, s.guard)
        em.jump(Op.JNZ, done)
        this.init(s.lv, s.init)
        em.op(Op.PUSH_I, 1)
        em.op(Op.STORE_G, s.guard)
        return em.place(done)
      }
      case 'block':
        for (const b of s.body) this.stmt(b)
        return
      case 'if': return this.ifStmt(s)
      case 'loop': return this.loop(s)
      case 'switch': return this.switchStmt(s)
      case 'label': return // placed by switchStmt, which owns every case label
      case 'break':
        em.mark(s.span)
        return em.jump(Op.JMP, this.loops[this.loops.length - 1].brk)
      case 'continue': {
        em.mark(s.span)
        const target = [...this.loops].reverse().find((l) => l.cont >= 0)
        return em.jump(Op.JMP, target ? target.cont : this.loops[this.loops.length - 1].brk)
      }
      case 'return':
        em.mark(s.span)
        if (!s.e) return em.op(Op.RET)
        ex.gen(s.e, true)
        return em.op(Op.RETV)
    }
  }

  private init(lv: TLValue, init: TInit): void {
    const { em, ex } = this
    if (lv.k === 'local' && lv.ref) {
      // bind a reference local (range-for over scalars): store the element's address pair
      if (init.k !== 'expr' || init.e.k !== 'load') throw new Error('internal: reference binding needs a place')
      ex.address(init.e.lv)
      em.op(Op.STORE_L, lv.slot + 1)
      return em.op(Op.STORE_L, lv.slot)
    }
    ex.initValue(init)
    if (lv.k === 'local') em.op(Op.STORE_L, lv.slot)
    else if (lv.k === 'global') em.op(Op.STORE_G, lv.index)
    else throw new Error('internal: initialising a non-variable')
  }

  private ifStmt(s: Extract<TStmt, { k: 'if' }>): void {
    const { em, ex } = this
    em.mark(s.span)
    if (s.c.k === 'const') return this.stmt(s.c.value ? s.t : s.e ?? { k: 'block', body: [] })
    const other = em.newLabel()
    ex.gen(s.c, true)
    em.jump(Op.JZ, other)
    this.stmt(s.t)
    if (!s.e) return em.place(other)
    const end = em.newLabel()
    em.jump(Op.JMP, end)
    em.place(other)
    this.stmt(s.e)
    em.place(end)
  }

  private loop(s: Extract<TStmt, { k: 'loop' }>): void {
    const { em, ex } = this
    const top = em.newLabel()
    const cont = em.newLabel()
    const brk = em.newLabel()
    const always = s.c === null || (s.c.k === 'const' && s.c.value !== 0)
    const never = s.c !== null && s.c.k === 'const' && s.c.value === 0
    if (never && s.form !== 'do') return
    em.place(top)
    if (s.form !== 'do' && !always && s.c) {
      em.mark(s.span)
      ex.gen(s.c, true)
      em.jump(Op.JZ, brk)
    }
    this.loops.push({ brk, cont })
    this.stmt(s.body)
    this.loops.pop()
    em.place(cont)
    if (s.step) {
      em.mark(s.span)
      ex.gen(s.step, false)
    }
    if (s.form === 'do' && !always) {
      if (s.c && !never) {
        em.mark(s.span)
        ex.gen(s.c, true)
        em.jump(Op.JNZ, top)
      }
    } else {
      em.jump(Op.JMP, top)
    }
    em.place(brk)
  }

  private switchStmt(s: Extract<TStmt, { k: 'switch' }>): void {
    const { em, ex } = this
    em.mark(s.span)
    ex.gen(s.e, true)
    em.op(Op.STORE_L, s.slot)
    const brk = em.newLabel()
    // sema label ids map onto emitter labels allocated per switch
    const ids = s.body.filter((b): b is Extract<TStmt, { k: 'label' }> => b.k === 'label').map((b) => b.id)
    const map = new Map<number, number>(ids.map((id) => [id, em.newLabel()]))
    for (const c of s.cases) {
      em.op(Op.LOAD_L, s.slot)
      em.pushNumber(c.value)
      em.op(Op.EQ)
      em.jump(Op.JNZ, map.get(c.label) as number)
    }
    em.jump(Op.JMP, s.defaultLabel >= 0 ? (map.get(s.defaultLabel) as number) : brk)
    this.loops.push({ brk, cont: -1 })
    for (const b of s.body) {
      if (b.k === 'label') em.place(map.get(b.id) as number)
      else this.stmt(b)
    }
    this.loops.pop()
    em.place(brk)
  }
}
