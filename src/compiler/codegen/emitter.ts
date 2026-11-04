/* ============================================================
   EMITTER — code buffer with forward labels, the pc → line
   table, the constant pool and runtime type descriptors.
   Also picks the wrap / conversion opcodes for a C type.
   ============================================================ */

import { Op, type ConstValue, type TypeDesc } from '../bytecode'
import { intInfo, isF32, type CType } from '../ctypes'
import type { Span } from '../diagnostics'

export class Emitter {
  readonly code: number[] = []
  readonly consts: ConstValue[] = []
  readonly types: TypeDesc[] = []
  readonly linePcs: number[] = []
  readonly lineNos: number[] = []
  readonly colNos: number[] = []
  private readonly labelPos: number[] = []
  private readonly fixups: { at: number; label: number }[] = []
  private readonly constKeys = new Map<string, number>()
  private readonly typeKeys = new Map<string, number>()

  constructor(readonly intBits: 16 | 32, private readonly structFields: (id: number) => CType[]) {}

  get pc(): number {
    return this.code.length
  }

  op(code: number, ...args: number[]): void {
    this.code.push(code, ...args)
  }

  /** Records the source position of the next instruction (deduplicated). */
  mark(span: Span): void {
    const n = this.linePcs.length
    if (n > 0 && this.lineNos[n - 1] === span.line && this.colNos[n - 1] === span.col) return
    if (n > 0 && this.linePcs[n - 1] === this.pc) {
      this.lineNos[n - 1] = span.line
      this.colNos[n - 1] = span.col
      return
    }
    this.linePcs.push(this.pc)
    this.lineNos.push(span.line)
    this.colNos.push(span.col)
  }

  newLabel(): number {
    this.labelPos.push(-1)
    return this.labelPos.length - 1
  }

  place(label: number): void {
    this.labelPos[label] = this.pc
  }

  jump(code: number, label: number): void {
    this.code.push(code, 0)
    this.fixups.push({ at: this.pc - 1, label })
  }

  /** Resolves every forward jump. */
  link(): void {
    for (const f of this.fixups) {
      const target = this.labelPos[f.label]
      if (target < 0) throw new Error(`internal: unplaced label ${f.label}`)
      this.code[f.at] = target
    }
  }

  constIndex(v: ConstValue): number {
    const key = typeof v === 'number' ? `n${Object.is(v, -0) ? '-0' : v}` : typeof v === 'string' ? `s${v}` : `a${JSON.stringify(v)}`
    const hit = this.constKeys.get(key)
    if (hit !== undefined) return hit
    this.consts.push(v)
    this.constKeys.set(key, this.consts.length - 1)
    return this.consts.length - 1
  }

  pushNumber(v: number): void {
    if (Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff && !Object.is(v, -0)) this.op(Op.PUSH_I, v)
    else this.op(Op.PUSH_K, this.constIndex(v))
  }

  typeIndex(ty: CType): number {
    const desc = this.describe(ty)
    const key = JSON.stringify(desc)
    const hit = this.typeKeys.get(key)
    if (hit !== undefined) return hit
    this.types.push(desc)
    this.typeKeys.set(key, this.types.length - 1)
    return this.types.length - 1
  }

  private describe(ty: CType): TypeDesc {
    switch (ty.t) {
      case 'prim':
        if (ty.p === 'string' || ty.p === 'cstr') return { k: 'str' }
        if (ty.p === 'char') return { k: 'num', char: true }
        if (ty.p === 'bool') return { k: 'num', bool: true }
        return { k: 'num' }
      case 'array': return { k: 'array', elem: this.typeIndex(ty.elem), len: Math.max(0, ty.len) }
      case 'struct': {
        this.structFields(ty.id).forEach((f) => this.typeIndex(f))
        return { k: 'struct', id: ty.id }
      }
      case 'native': return { k: 'native', cls: ty.cls }
      default: return { k: 'num' }
    }
  }

  /** Wrap opcode that brings any integral JS number into `ty`'s range (null = no-op). */
  wrapOp(ty: CType): number | null {
    if (ty.t !== 'prim') return null
    if (ty.p === 'float' || ty.p === 'double') return isF32(ty.p, this.intBits) ? Op.FROUND : null
    const info = intInfo(ty.p, this.intBits)
    if (!info) return null
    if (info.bits === 1) return Op.TOBOOL
    if (info.bits === 8) return info.signed ? Op.W8 : Op.WU8
    if (info.bits === 16) return info.signed ? Op.W16 : Op.WU16
    return info.signed ? Op.W32 : Op.WU32
  }

  wrap(ty: CType): void {
    const w = this.wrapOp(ty)
    if (w !== null) this.op(w)
  }

  /** Numeric conversion `from` → `to` as opcodes (C rules, see arith.convertNumber). */
  convert(from: CType, to: CType): void {
    if (from.t !== 'prim' || to.t !== 'prim') return
    const fromFloat = from.p === 'float' || from.p === 'double'
    const toFloat = to.p === 'float' || to.p === 'double'
    if (toFloat) {
      if (isF32(to.p, this.intBits) && !(fromFloat && isF32(from.p, this.intBits))) this.op(Op.FROUND)
      return
    }
    const ti = intInfo(to.p, this.intBits)
    if (!ti) return
    if (ti.bits === 1) {
      if (from.p !== 'bool') this.op(Op.TOBOOL)
      return
    }
    if (fromFloat) {
      this.op(ti.signed || ti.bits < 32 ? Op.F2I : Op.F2U)
      if (ti.bits < 32) this.wrap(to)
      return
    }
    const fi = intInfo(from.p, this.intBits)
    if (!fi) return
    const fits = fi.bits === 1 || (fi.signed === ti.signed && fi.bits <= ti.bits) || (!fi.signed && ti.signed && fi.bits < ti.bits)
    if (!fits) this.wrap(to)
  }
}
