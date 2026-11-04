/* ============================================================
   SEMA CONTEXT — symbol tables, scopes, slot allocation, type
   resolution and the native/builtin registries shared by the
   expression, call, statement and declaration checkers.
   ============================================================ */

import type { CompileOptions, NativeClassSig, NativeFnSig, ValueType } from '../api'
import type { Expr, FuncDecl, TypeSpec } from '../ast'
import type { NativeSite, Site } from '../bytecode'
import { arrayOf, prim, T, typeName, type CType, type PrimKind } from '../ctypes'
import { DiagBag, type Span } from '../diagnostics'
import { table } from '../tables'
import { BUILTIN_NAMES } from './macros'
import type { TGlobal, TStmt } from '../tir'

export interface VarSym {
  kind: 'var'
  name: string
  ty: CType
  storage: 'local' | 'global'
  /** Local frame slot or global index. */
  slot: number
  ref: boolean
  isConst: boolean
  /** Compile-time value of a const scalar with a constant initializer. */
  constValue: number | string | null
  span: Span
  isParam: boolean
  reads: number
  writes: number
}

export interface EnumConstSym {
  kind: 'enumConst'
  name: string
  value: number
  span: Span
}

export type Sym = VarSym | EnumConstSym

export class Scope {
  readonly vars = new Map<string, Sym>()
  constructor(readonly parent: Scope | null) {}

  lookup(name: string): Sym | null {
    for (let s: Scope | null = this; s; s = s.parent) {
      const v = s.vars.get(name)
      if (v) return v
    }
    return null
  }
}

export interface FnParamSym {
  name: string | null
  ty: CType
  ref: boolean
  isConst: boolean
  defaultValue: Expr | null
}

export interface FnSym {
  index: number
  name: string
  params: FnParamSym[]
  ret: CType
  span: Span
  defined: boolean
  used: boolean
  decl: FuncDecl
}

export interface StructInfo {
  id: number
  name: string
  fields: { name: string; ty: CType; init: Expr | null }[]
  span: Span
}

export interface EnumInfo {
  isClass: boolean
  members: Map<string, number>
}

export interface FnCtx {
  fn: FnSym
  slots: number
  loops: number
  breakables: number
}

const PRIM_BY_NAME: Readonly<Record<string, PrimKind>> = table({
  void: 'void', bool: 'bool', char: 'char', 'signed char': 'schar', 'unsigned char': 'uchar', byte: 'uchar',
  uint8_t: 'uchar', int8_t: 'schar', short: 'short', int16_t: 'short', 'unsigned short': 'ushort',
  uint16_t: 'ushort', word: 'ushort', int: 'int', 'unsigned int': 'uint', size_t: 'uint', long: 'long',
  'unsigned long': 'ulong', uint32_t: 'ulong', float: 'float', double: 'double', String: 'string',
})

const WIDE = new Map<string, PrimKind>([
  ['long long', 'long'], ['unsigned long long', 'ulong'], ['int64_t', 'long'], ['uint64_t', 'ulong'],
])

/** Arduino.h constants used when the host does not define them. */
const DEFAULT_CONSTANTS: Record<string, number> = {
  HIGH: 1, LOW: 0, INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2, LED_BUILTIN: 13, DEC: 10, HEX: 16, OCT: 8, BIN: 2,
  LSBFIRST: 0, MSBFIRST: 1, CHANGE: 1, FALLING: 2, RISING: 3,
}

/**
 * Cap on one array's values. Far above any real board's RAM, low enough that a typo
 * such as `int buf[100000000]` reports an error instead of exhausting the worker's memory.
 */
const MAX_ARRAY_CELLS = 1_000_000

export class Sema {
  readonly intBits: 16 | 32
  readonly global = new Scope(null)
  scope: Scope = this.global
  readonly structs: StructInfo[] = []
  readonly structByName = new Map<string, StructInfo>()
  readonly typedefs = new Map<string, CType>()
  readonly enums = new Map<string, EnumInfo>()
  readonly fns = new Map<string, FnSym[]>()
  readonly fnList: FnSym[] = []
  readonly globals: TGlobal[] = []
  readonly globalInits: TStmt[] = []
  readonly sites: Site[] = []
  readonly natives: NativeSite[] = []
  readonly classSites: string[] = []
  readonly nativeFns = new Map<string, NativeFnSig[]>()
  readonly classes = new Map<string, NativeClassSig>()
  readonly classMethods = new Map<string, Map<string, NativeFnSig[]>>()
  readonly objects = new Set<string>()
  readonly constants = new Map<string, number>()
  /** Global names declared further down the file (for "declared later" hints). */
  readonly laterGlobals = new Map<string, Span>()
  fx: FnCtx | null = null
  /** Set by the analyzer: folds an expression to an integer constant (or null). */
  evalConstInt: (e: Expr) => number | null = () => null
  private nativeKeys = new Map<string, number>()
  private labels = 0

  constructor(readonly opts: CompileOptions, readonly diags: DiagBag) {
    this.intBits = opts.intBits === 16 ? 16 : 32
    for (const [k, v] of Object.entries(DEFAULT_CONSTANTS)) this.constants.set(k, v)
    for (const [k, v] of Object.entries(opts.constants)) this.constants.set(k, v)
    for (const o of opts.objects) this.objects.add(o.name)
    for (const c of opts.classes) {
      this.classes.set(c.name, c)
      const m = new Map<string, NativeFnSig[]>()
      for (const sig of c.methods) pushMap(m, sig.name, sig)
      this.classMethods.set(c.name, m)
    }
    for (const f of opts.functions) {
      const dot = f.name.indexOf('.')
      const owner = dot > 0 ? f.name.slice(0, dot) : ''
      const cm = this.classMethods.get(owner)
      if (cm && !this.objects.has(owner)) pushMap(cm, f.name.slice(dot + 1), f)
      else pushMap(this.nativeFns, f.name, f)
    }
  }

  error(span: Span, msg: string): void {
    this.diags.error(span, msg)
  }

  warning(span: Span, msg: string): void {
    this.diags.warning(span, msg)
  }

  site(span: Span, name = ''): number {
    this.sites.push({ line: span.line, col: span.col, endLine: span.endLine, endCol: span.endCol, name })
    return this.sites.length - 1
  }

  nativeSite(name: string, argTypes: ValueType[], hasSelf: boolean, ret: ValueType): number {
    const key = `${name}|${argTypes.join(',')}|${hasSelf}|${ret}`
    const hit = this.nativeKeys.get(key)
    if (hit !== undefined) return hit
    this.natives.push({ name, argTypes, hasSelf, ret })
    this.nativeKeys.set(key, this.natives.length - 1)
    return this.natives.length - 1
  }

  classSite(cls: string): number {
    const i = this.classSites.indexOf(cls)
    if (i >= 0) return i
    this.classSites.push(cls)
    return this.classSites.length - 1
  }

  newLabel(): number {
    return this.labels++
  }

  /* ---------------- scopes and storage ---------------- */

  /**
   * Name lookup with C++ declaration order: inside a function, a global declared
   * below that function is not visible yet (only functions are hoisted).
   */
  lookup(name: string): Sym | null {
    const sym = this.scope.lookup(name)
    if (!sym || !this.fx || this.global.vars.get(name) !== sym) return sym
    return isAfter(sym.span, this.fx.fn.decl.span) ? null : sym
  }

  /** A global with this name declared below the current function, if any. */
  declaredBelow(name: string): Span | null {
    const sym = this.global.vars.get(name)
    if (!sym || !this.fx) return this.laterGlobals.get(name) ?? null
    return isAfter(sym.span, this.fx.fn.decl.span) ? sym.span : null
  }

  pushScope(): void {
    this.scope = new Scope(this.scope)
  }

  popScope(): void {
    for (const s of this.scope.vars.values()) if (s.kind === 'var') this.unusedCheck(s)
    this.scope = this.scope.parent ?? this.global
  }

  private unusedCheck(v: VarSym): void {
    if (v.storage !== 'local' || v.isParam || v.reads > 0 || v.name.startsWith('__')) return
    if (v.ty.t === 'native' || (v.ty.t === 'prim' && v.ty.p === 'string')) return
    const span = v.span
    if (v.writes > 0) this.warning(span, `Variable '${v.name}' is set but never used`)
    else this.warning(span, `Unused variable '${v.name}'`)
  }

  allocSlots(n: number): number {
    const fx = this.fx
    if (!fx) throw new Error('slot allocation outside a function')
    const s = fx.slots
    fx.slots += n
    return s
  }

  declare(sym: Sym, span: Span): void {
    const prev = this.scope.vars.get(sym.name)
    if (prev) {
      const where = prev.span.line !== span.line || prev.span.col !== span.col ? ` (first declared on line ${prev.span.line})` : ''
      this.error(span, `Redeclaration of '${sym.name}'${where}`)
      return
    }
    this.scope.vars.set(sym.name, sym)
  }

  declareLocal(name: string, ty: CType, span: Span, ref: boolean, isConst: boolean, isParam: boolean): VarSym {
    const slot = this.allocSlots(ref ? 2 : 1)
    const v: VarSym = { kind: 'var', name, ty, storage: 'local', slot, ref, isConst, constValue: null, span, isParam, reads: 0, writes: 0 }
    this.declare(v, span)
    return v
  }

  addGlobal(name: string, ty: CType, hidden: boolean): number {
    this.globals.push({ name, ty, hidden })
    return this.globals.length - 1
  }

  declareGlobal(name: string, ty: CType, span: Span, isConst: boolean): VarSym {
    const v: VarSym = {
      kind: 'var', name, ty, storage: 'global', slot: this.addGlobal(name, ty, false), ref: false, isConst,
      constValue: null, span, isParam: false, reads: 0, writes: 0,
    }
    this.declare(v, span)
    return v
  }

  /** Every name visible here, for "did you mean" suggestions. */
  visibleNames(): string[] {
    const names = new Set<string>()
    for (let s: Scope | null = this.scope; s; s = s.parent) for (const k of s.vars.keys()) names.add(k)
    for (const k of this.fns.keys()) names.add(k)
    for (const k of this.nativeFns.keys()) if (!k.includes('.')) names.add(k)
    for (const k of this.constants.keys()) names.add(k)
    for (const k of this.objects) names.add(k)
    for (const k of BUILTIN_NAMES) names.add(k)
    return [...names]
  }

  /* ---------------- types ---------------- */

  /** Resolves a written type plus declarator pointer/array parts. */
  resolveType(spec: TypeSpec, extraPointer: number, dims: (Expr | null)[], allowUnsized: boolean): CType {
    let base = this.baseType(spec)
    const pointer = spec.pointer + extraPointer
    if (pointer > 0 && base.t !== 'error') base = this.pointerType(base, pointer, spec.span)
    return this.applyDims(base, dims, allowUnsized, spec.span)
  }

  applyDims(base: CType, dims: (Expr | null)[], allowUnsized: boolean, span: Span): CType {
    let ty = base
    for (let k = dims.length - 1; k >= 0; k--) {
      const d = dims[k]
      if (d === null) {
        if (k !== 0 || !allowUnsized) {
          this.error(span, 'Array size missing: only the first dimension may be left empty')
          return T.error
        }
        ty = arrayOf(ty, -1)
        continue
      }
      const n = this.evalConstInt(d)
      if (n === null) {
        this.error(d.span, 'Array size must be a constant (a number, a #define, or a const int)')
        return T.error
      }
      if (n <= 0) {
        this.error(d.span, `Array size must be positive (got ${n})`)
        return T.error
      }
      ty = arrayOf(ty, n)
      if (this.cellCount(ty) > MAX_ARRAY_CELLS) {
        this.error(d.span, `Array is too large (${this.cellCount(ty)} values): the simulator allows ${MAX_ARRAY_CELLS} per array. An Arduino Uno has 2 KB of RAM and an ESP32 about 320 KB`)
        return T.error
      }
    }
    if (ty.t === 'array' && base.t === 'prim' && base.p === 'void') {
      this.error(span, 'Arrays of void are not allowed')
      return T.error
    }
    return ty
  }

  private pointerType(base: CType, pointer: number, span: Span): CType {
    if (pointer === 1 && base.t === 'prim' && (base.p === 'char' || base.p === 'uchar' || base.p === 'schar')) return T.cstr
    this.error(span, `Pointers are not supported (only 'const char*' for text). Use an array, or a reference parameter like '${typeName(base)} &x'`)
    return T.error
  }

  baseType(spec: TypeSpec): CType {
    if (!spec.named) {
      const p = PRIM_BY_NAME[spec.name]
      if (p) return prim(p)
      const wide = WIDE.get(spec.name)
      if (wide) {
        this.warning(spec.span, `64-bit '${spec.name}' is not supported in the simulator; it is treated as 32-bit '${wide === 'long' ? 'long' : 'unsigned long'}'`)
        return prim(wide)
      }
      if (spec.name === 'int32_t') return this.intBits === 16 ? T.long : T.int
      this.error(spec.span, `Unknown type '${spec.name}'`)
      return T.error
    }
    const td = this.typedefs.get(spec.name)
    if (td) return td
    const st = this.structByName.get(spec.name)
    if (st) return { t: 'struct', id: st.id, name: st.name }
    if (this.enums.has(spec.name)) return T.int
    if (this.classes.has(spec.name)) return { t: 'native', cls: spec.name }
    this.error(spec.span, `Unknown type '${spec.name}'`)
    return T.error
  }

  structFields(id: number): CType[] {
    return this.structs[id]?.fields.map((f) => f.ty) ?? []
  }

  /** Scalar values a type holds at run time (each one is a VM slot). */
  cellCount(ty: CType): number {
    if (ty.t === 'array') return Math.max(0, ty.len) * this.cellCount(ty.elem)
    if (ty.t === 'struct') return this.structFields(ty.id).reduce((n, f) => n + this.cellCount(f), 0)
    return 1
  }
}

function isAfter(a: Span, b: Span): boolean {
  return a.line > b.line || (a.line === b.line && a.col > b.col)
}

function pushMap<V>(m: Map<string, V[]>, k: string, v: V): void {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}
