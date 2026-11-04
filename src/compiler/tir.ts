/* ============================================================
   TYPED IR — the output of semantic analysis and the input of
   the bytecode generator. Every implicit C conversion is explicit
   here ('convert' / 'tostr' / 'copy' nodes), names are resolved
   to storage, and calls are resolved to user / builtin / native.
   ============================================================ */

import type { ArithOp } from './arith'
import type { ConstValue, NativeSite, Site } from './bytecode'
import type { CType } from './ctypes'
import type { Span } from './diagnostics'

export type CmpOp = '<' | '<=' | '>' | '>=' | '==' | '!='

export type TLValue =
  | { k: 'local'; ty: CType; slot: number; ref: boolean; name: string }
  | { k: 'global'; ty: CType; index: number; name: string }
  | { k: 'index'; ty: CType; arr: TExpr; idx: TExpr; site: number }
  | { k: 'field'; ty: CType; obj: TExpr; field: number }
  /** s[i] on a String variable (reads give the char, writes rebuild the String). */
  | { k: 'strIndex'; ty: CType; str: TLValue; idx: TExpr; site: number }

export type TExpr =
  | { k: 'const'; ty: CType; value: number | string; span: Span }
  | { k: 'load'; ty: CType; lv: TLValue; span: Span }
  | { k: 'unary'; ty: CType; op: 'neg' | 'bnot' | 'not'; e: TExpr; span: Span }
  | { k: 'binary'; ty: CType; op: ArithOp; l: TExpr; r: TExpr; site: number; span: Span }
  /** Operands already converted to their common type `opTy`. */
  | { k: 'cmp'; ty: CType; op: CmpOp; opTy: CType; l: TExpr; r: TExpr; span: Span }
  | { k: 'logic'; ty: CType; op: '&&' | '||'; l: TExpr; r: TExpr; span: Span }
  | { k: 'convert'; ty: CType; from: CType; e: TExpr; span: Span }
  /** Value already converted to lv.ty. */
  | { k: 'assign'; ty: CType; lv: TLValue; value: TExpr; span: Span }
  /** lv = (lv.ty)((opTy)lv op value). `concat` is String +=. */
  | { k: 'compound'; ty: CType; lv: TLValue; op: ArithOp | 'concat'; opTy: CType; value: TExpr; site: number; span: Span }
  | { k: 'incdec'; ty: CType; lv: TLValue; delta: 1 | -1; prefix: boolean; span: Span }
  | { k: 'cond'; ty: CType; c: TExpr; a: TExpr; b: TExpr; span: Span }
  | { k: 'call'; ty: CType; fn: number; args: TArg[]; span: Span }
  | { k: 'builtin'; ty: CType; id: number; args: TExpr[]; site: number; span: Span }
  | { k: 'native'; ty: CType; site: number; self: TExpr | null; args: TExpr[]; span: Span }
  | { k: 'construct'; ty: CType; cls: number; args: TExpr[]; span: Span }
  /** Both sides already Strings. */
  | { k: 'concat'; ty: CType; l: TExpr; r: TExpr; span: Span }
  | { k: 'tostr'; ty: CType; kind: number; e: TExpr; span: Span }
  | { k: 'chars2str'; ty: CType; e: TExpr; span: Span }
  /** In-place String method (toUpperCase, trim, concat, ...): lv = method(lv, args). */
  | { k: 'strMutate'; ty: CType; lv: TLValue; id: number; args: TExpr[]; result: 'void' | 'true'; span: Span }
  | { k: 'strIdx'; ty: CType; s: TExpr; idx: TExpr; site: number; span: Span }
  | { k: 'ptrAdd'; ty: CType; s: TExpr; n: TExpr; site: number; span: Span }
  | { k: 'comma'; ty: CType; a: TExpr; b: TExpr; span: Span }
  /** Deep copy of a struct value (C++ value semantics). */
  | { k: 'copy'; ty: CType; e: TExpr; span: Span }
  /** Timing builtins that suspend the VM: delay(ms), delayMicroseconds(us), yield(). */
  | { k: 'sleep'; ty: CType; ms: TExpr; micro: boolean; span: Span }
  | { k: 'yield'; ty: CType; span: Span }
  /** A freshly default-constructed aggregate (arrays, structs). */
  | { k: 'newobj'; ty: CType; span: Span }
  /** A temporary built from an initializer: Point{1, 2}. */
  | { k: 'aggregate'; ty: CType; init: TInit; span: Span }

export type TArg = { k: 'val'; e: TExpr } | { k: 'ref'; lv: TLValue }

export type TInit =
  | { k: 'expr'; e: TExpr }
  | { k: 'default'; ty: CType }
  /** Aggregate: items fill elements / fields in order; the rest stay zero. */
  | { k: 'list'; ty: CType; items: TInit[] }
  /** Folded constant aggregate (a lookup table). */
  | { k: 'const'; ty: CType; value: ConstValue }
  | { k: 'ctor'; ty: CType; cls: number; args: TExpr[] }

export type TStmt =
  | { k: 'expr'; e: TExpr; span: Span }
  | { k: 'init'; lv: TLValue; init: TInit; span: Span }
  /** Static local: initialised once, guarded by a hidden global flag. */
  | { k: 'staticInit'; guard: number; lv: TLValue; init: TInit; span: Span }
  | { k: 'block'; body: TStmt[] }
  | { k: 'if'; c: TExpr; t: TStmt; e: TStmt | null; span: Span }
  | { k: 'loop'; form: 'while' | 'do' | 'for'; c: TExpr | null; step: TExpr | null; body: TStmt; span: Span }
  | { k: 'switch'; slot: number; e: TExpr; cases: { value: number; label: number }[]; defaultLabel: number; body: TStmt[]; span: Span }
  | { k: 'label'; id: number }
  | { k: 'break'; span: Span }
  | { k: 'continue'; span: Span }
  | { k: 'return'; e: TExpr | null; span: Span }

export interface TParam {
  name: string
  ty: CType
  ref: boolean
  slot: number
}

export interface TFunction {
  name: string
  params: TParam[]
  ret: CType
  paramSlots: number
  frameSlots: number
  body: TStmt[]
  span: Span
  defined: boolean
}

export interface TGlobal {
  name: string
  ty: CType
  hidden: boolean
}

export interface TStruct {
  name: string
  fields: { name: string; ty: CType }[]
}

export interface TProgram {
  intBits: 16 | 32
  functions: TFunction[]
  globals: TGlobal[]
  /** Global initialisation in declaration order (runs before setup()). */
  globalInits: TStmt[]
  structs: TStruct[]
  natives: NativeSite[]
  classes: string[]
  sites: Site[]
  setup: number
  loop: number
}
