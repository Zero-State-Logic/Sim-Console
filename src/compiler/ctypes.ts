/* ============================================================
   C TYPES — the resolved type model, integer promotion and the
   usual arithmetic conversions, exactly as C++ defines them for
   a target whose `int` is 16 (AVR) or 32 bits wide.
   `long` is always 32-bit. `double` is 64-bit, except on AVR
   where avr-gcc makes it a 32-bit float.
   ============================================================ */

import type { ValueType } from './api'

export type PrimKind =
  | 'void' | 'bool' | 'char' | 'schar' | 'uchar' | 'short' | 'ushort'
  | 'int' | 'uint' | 'long' | 'ulong' | 'float' | 'double'
  /** Arduino String. */
  | 'string'
  /** const char* — string literals and char pointers. */
  | 'cstr'

export type CType =
  | { readonly t: 'prim'; readonly p: PrimKind }
  /** len -1: unsized array parameter (`int a[]`). */
  | { readonly t: 'array'; readonly elem: CType; readonly len: number }
  | { readonly t: 'struct'; readonly id: number; readonly name: string }
  /** Instance of a native class (Servo); the value is the host handle. */
  | { readonly t: 'native'; readonly cls: string }
  /** A native global object (Serial). Only usable for method calls and truthiness. */
  | { readonly t: 'object'; readonly name: string }
  /** Poison type after an error, so one mistake does not cascade. */
  | { readonly t: 'error' }

const cache = new Map<PrimKind, CType>()
export function prim(p: PrimKind): CType {
  let c = cache.get(p)
  if (!c) {
    c = { t: 'prim', p }
    cache.set(p, c)
  }
  return c
}

export const T = {
  void: prim('void'), bool: prim('bool'), char: prim('char'), schar: prim('schar'), uchar: prim('uchar'),
  short: prim('short'), ushort: prim('ushort'), int: prim('int'), uint: prim('uint'), long: prim('long'),
  ulong: prim('ulong'), float: prim('float'), double: prim('double'), string: prim('string'), cstr: prim('cstr'),
  error: { t: 'error' } as CType,
}

export function arrayOf(elem: CType, len: number): CType {
  return { t: 'array', elem, len }
}

export interface IntInfo {
  bits: number
  signed: boolean
}

/** Width and signedness of an integer kind (bool is 1 bit, char is signed 8). */
export function intInfo(p: PrimKind, intBits: number): IntInfo | null {
  switch (p) {
    case 'bool': return { bits: 1, signed: false }
    case 'char':
    case 'schar': return { bits: 8, signed: true }
    case 'uchar': return { bits: 8, signed: false }
    case 'short': return { bits: 16, signed: true }
    case 'ushort': return { bits: 16, signed: false }
    case 'int': return { bits: intBits, signed: true }
    case 'uint': return { bits: intBits, signed: false }
    case 'long': return { bits: 32, signed: true }
    case 'ulong': return { bits: 32, signed: false }
    default: return null
  }
}

export function primOf(ty: CType): PrimKind | null {
  return ty.t === 'prim' ? ty.p : null
}

export function isInteger(ty: CType): boolean {
  return ty.t === 'prim' && intInfo(ty.p, 32) !== null
}

export function isFloating(ty: CType): boolean {
  return ty.t === 'prim' && (ty.p === 'float' || ty.p === 'double')
}

export function isArithmetic(ty: CType): boolean {
  return isInteger(ty) || isFloating(ty)
}

export function isStringy(ty: CType): boolean {
  return ty.t === 'prim' && (ty.p === 'string' || ty.p === 'cstr')
}

export function isCharArray(ty: CType): boolean {
  return ty.t === 'array' && ty.elem.t === 'prim' && (ty.elem.p === 'char' || ty.elem.p === 'uchar' || ty.elem.p === 'schar')
}

export function isVoid(ty: CType): boolean {
  return ty.t === 'prim' && ty.p === 'void'
}

export function isError(ty: CType): boolean {
  return ty.t === 'error'
}

/** Does `float`/`double` of this kind round to 32 bits on the target? */
export function isF32(p: PrimKind, intBits: number): boolean {
  return p === 'float' || (p === 'double' && intBits === 16)
}

/** Integer promotion: anything narrower than int becomes int (or unsigned int if int cannot hold it). */
export function promote(ty: CType, intBits: number): CType {
  if (ty.t !== 'prim') return ty
  const info = intInfo(ty.p, intBits)
  if (!info) return ty
  if (ty.p === 'int' || ty.p === 'uint' || ty.p === 'long' || ty.p === 'ulong') return ty
  if (info.bits < intBits || (info.bits === intBits && info.signed)) return T.int
  return T.uint
}

function rank(p: PrimKind): number {
  return p === 'long' || p === 'ulong' ? 2 : 1
}

/** Usual arithmetic conversions: the common type of a binary arithmetic operation. */
export function commonType(a: CType, b: CType, intBits: number): CType {
  if (a.t === 'error' || b.t === 'error') return T.error
  if (a.t !== 'prim' || b.t !== 'prim') return T.error
  if (a.p === 'double' || b.p === 'double') return T.double
  if (a.p === 'float' || b.p === 'float') return T.float
  const pa = promote(a, intBits) as { t: 'prim'; p: PrimKind }
  const pb = promote(b, intBits) as { t: 'prim'; p: PrimKind }
  if (pa.p === pb.p) return pa
  const ia = intInfo(pa.p, intBits) as IntInfo
  const ib = intInfo(pb.p, intBits) as IntInfo
  if (ia.signed === ib.signed) return rank(pa.p) >= rank(pb.p) ? pa : pb
  const [u, s, iu, is] = ia.signed ? [pb, pa, ib, ia] : [pa, pb, ia, ib]
  if (rank(u.p) >= rank(s.p)) return u
  if (is.bits > iu.bits) return s
  return s.p === 'long' ? T.ulong : T.uint
}

/** Static type as the host sees it in VMHost.callNative argTypes. */
export function toValueType(ty: CType): ValueType {
  if (ty.t !== 'prim') return 'any'
  switch (ty.p) {
    case 'bool': return 'bool'
    case 'char': return 'char'
    case 'schar':
    case 'short':
    case 'int': return 'int'
    case 'long': return 'long'
    case 'uchar':
    case 'ushort':
    case 'uint':
    case 'ulong': return 'unsigned'
    case 'float': return 'float'
    case 'double': return 'double'
    case 'string':
    case 'cstr': return 'string'
    default: return 'void'
  }
}

export function fromValueType(v: ValueType): CType {
  switch (v) {
    case 'void': return T.void
    case 'int': return T.int
    case 'long': return T.long
    case 'unsigned': return T.ulong
    case 'float': return T.float
    case 'double': return T.double
    case 'bool': return T.bool
    case 'char': return T.char
    case 'string': return T.string
    default: return T.double
  }
}

const PRIM_NAMES: Record<PrimKind, string> = {
  void: 'void', bool: 'bool', char: 'char', schar: 'signed char', uchar: 'byte', short: 'short',
  ushort: 'unsigned short', int: 'int', uint: 'unsigned int', long: 'long', ulong: 'unsigned long',
  float: 'float', double: 'double', string: 'String', cstr: 'const char*',
}

export function typeName(ty: CType): string {
  switch (ty.t) {
    case 'prim': return PRIM_NAMES[ty.p]
    case 'array': {
      let base: CType = ty
      let dims = ''
      while (base.t === 'array') {
        dims += base.len >= 0 ? `[${base.len}]` : '[]'
        base = base.elem
      }
      return `${typeName(base)}${dims}`
    }
    case 'struct': return `struct ${ty.name}`
    case 'native': return ty.cls
    case 'object': return ty.name
    default: return '<error>'
  }
}

export function sameType(a: CType, b: CType): boolean {
  if (a.t !== b.t) return false
  switch (a.t) {
    case 'prim': return a.p === (b as typeof a).p
    case 'array': {
      const bb = b as typeof a
      return (a.len === bb.len || a.len < 0 || bb.len < 0) && sameType(a.elem, bb.elem)
    }
    case 'struct': return a.id === (b as typeof a).id
    case 'native': return a.cls === (b as typeof a).cls
    case 'object': return a.name === (b as typeof a).name
    default: return true
  }
}

export interface SizeCtx {
  intBits: number
  structFields(id: number): CType[]
}

/** sizeof in bytes. AVR packs structs; 32-bit targets align fields naturally. */
export function sizeOf(ty: CType, ctx: SizeCtx): number {
  const ptr = ctx.intBits === 16 ? 2 : 4
  switch (ty.t) {
    case 'prim':
      switch (ty.p) {
        case 'bool': case 'char': case 'schar': case 'uchar': return 1
        case 'short': case 'ushort': return 2
        case 'int': case 'uint': return ctx.intBits / 8
        case 'long': case 'ulong': case 'float': return 4
        case 'double': return ctx.intBits === 16 ? 4 : 8
        case 'string': return ctx.intBits === 16 ? 6 : 12
        case 'cstr': return ptr
        default: return 1
      }
    case 'array': return ty.len < 0 ? ptr : ty.len * sizeOf(ty.elem, ctx)
    case 'struct': return structLayout(ctx.structFields(ty.id), ctx).size
    case 'native': return ptr
    default: return 0
  }
}

function alignOf(ty: CType, ctx: SizeCtx): number {
  if (ctx.intBits === 16) return 1
  if (ty.t === 'array') return alignOf(ty.elem, ctx)
  if (ty.t === 'struct') return Math.max(1, ...ctx.structFields(ty.id).map((f) => alignOf(f, ctx)))
  return Math.min(8, Math.max(1, sizeOf(ty, ctx)))
}

function structLayout(fields: CType[], ctx: SizeCtx): { size: number } {
  let off = 0
  let maxAlign = 1
  for (const f of fields) {
    const a = alignOf(f, ctx)
    maxAlign = Math.max(maxAlign, a)
    off = Math.ceil(off / a) * a + sizeOf(f, ctx)
  }
  return { size: Math.ceil(off / maxAlign) * maxAlign }
}
