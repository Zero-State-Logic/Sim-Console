/* ============================================================
   AST — what the parser produces. Every node has a span.
   Types are kept as written (TypeSpec); semantic analysis
   resolves them to CType.
   ============================================================ */

import type { Span } from './diagnostics'

export interface TypeSpec {
  span: Span
  /** Canonical builtin spelling ('unsigned long', 'uint8_t', 'String') or a user/native type name. */
  name: string
  /** True for struct / enum / typedef / native class names. */
  named: boolean
  isConst: boolean
  isStatic: boolean
  /** Number of '*' (only `char*` / `const char*` are accepted later). */
  pointer: number
  /** 'auto', or the JS-flavoured 'let' / 'var' / bare 'const' (type inferred from the initializer). */
  inferred: boolean
  /** Inline definition, as in `struct P { int x; } p;` */
  structDef?: StructDecl
  enumDef?: EnumDecl
}

/* ---------------- expressions ---------------- */

export type Expr =
  | IntLit
  | FloatLit
  | CharLit
  | StringLit
  | BoolLit
  | Ident
  | ScopeName
  | Unary
  | Postfix
  | Binary
  | Assign
  | Ternary
  | Call
  | Index
  | Member
  | Cast
  | Construct
  | Sizeof
  | Comma
  | InitListExpr

export interface IntLit { kind: 'int'; span: Span; value: number; unsigned: boolean; long: boolean; radix: number }
export interface FloatLit { kind: 'float'; span: Span; value: number; f32: boolean }
export interface CharLit { kind: 'char'; span: Span; value: number }
export interface StringLit { kind: 'string'; span: Span; value: string }
export interface BoolLit { kind: 'bool'; span: Span; value: boolean }
export interface Ident { kind: 'ident'; span: Span; name: string }
/** `Enum::Member` */
export interface ScopeName { kind: 'scope'; span: Span; scope: string; name: string }
export interface Unary { kind: 'unary'; span: Span; op: '-' | '+' | '!' | '~' | '++' | '--' | '&' | '*'; expr: Expr }
export interface Postfix { kind: 'postfix'; span: Span; op: '++' | '--'; expr: Expr }
export interface Binary { kind: 'binary'; span: Span; op: string; left: Expr; right: Expr; opSpan: Span }
export interface Assign { kind: 'assign'; span: Span; op: string; target: Expr; value: Expr; opSpan: Span }
export interface Ternary { kind: 'ternary'; span: Span; cond: Expr; a: Expr; b: Expr }
export interface Call { kind: 'call'; span: Span; callee: Expr; args: Expr[] }
export interface Index { kind: 'index'; span: Span; obj: Expr; index: Expr }
export interface Member { kind: 'member'; span: Span; obj: Expr; name: string; nameSpan: Span; arrow: boolean }
/** (T)x and T(x). */
export interface Cast { kind: 'cast'; span: Span; type: TypeSpec; expr: Expr }
/** String(x, HEX), Servo(), Adafruit_PWMServoDriver(0x40), Point{...} */
export interface Construct { kind: 'construct'; span: Span; type: TypeSpec; args: Expr[] }
export interface Sizeof { kind: 'sizeof'; span: Span; type: TypeSpec | null; expr: Expr | null }
export interface Comma { kind: 'comma'; span: Span; left: Expr; right: Expr }
/** A braced list where an expression is expected (initializers, `p = {1, 2}`). */
export interface InitListExpr { kind: 'initList'; span: Span; items: Expr[] }

/* ---------------- declarations ---------------- */

export interface Declarator {
  span: Span
  name: string
  nameSpan: Span
  /** Array dimensions; null = `[]` (size from the initializer). */
  dims: (Expr | null)[]
  isRef: boolean
  /** '*' written on this declarator (`char *a, b;` points only `a`). */
  pointer: number
  init: Expr | null
  /** `Servo s(9)` / `int x(5)` direct initialization. */
  ctorArgs: Expr[] | null
}

export interface VarDecl { kind: 'var'; span: Span; spec: TypeSpec; decls: Declarator[] }

export interface Param {
  span: Span
  spec: TypeSpec
  name: string | null
  nameSpan: Span
  isRef: boolean
  dims: (Expr | null)[]
  defaultValue: Expr | null
}

export interface FuncDecl {
  kind: 'func'
  span: Span
  ret: TypeSpec
  name: string
  nameSpan: Span
  params: Param[]
  /** null for a prototype. */
  body: Block | null
}

export interface StructDecl { kind: 'struct'; span: Span; name: string; nameSpan: Span; fields: VarDecl[] }

export interface EnumMember { name: string; span: Span; value: Expr | null }
export interface EnumDecl { kind: 'enum'; span: Span; name: string | null; isClass: boolean; members: EnumMember[] }

export interface TypedefDecl { kind: 'typedef'; span: Span; spec: TypeSpec; name: string; nameSpan: Span; dims: (Expr | null)[] }

export type TopLevel = FuncDecl | VarDecl | StructDecl | EnumDecl | TypedefDecl

export interface TranslationUnit { items: TopLevel[] }

/* ---------------- statements ---------------- */

export type Stmt =
  | Block
  | VarDecl
  | ExprStmt
  | If
  | While
  | DoWhile
  | For
  | ForRange
  | Switch
  | CaseLabel
  | DefaultLabel
  | Break
  | Continue
  | Return
  | Empty
  | LocalTypeDecl

export interface Block { kind: 'block'; span: Span; body: Stmt[] }
export interface ExprStmt { kind: 'expr'; span: Span; expr: Expr }
export interface If { kind: 'if'; span: Span; cond: Expr; then: Stmt; else: Stmt | null }
export interface While { kind: 'while'; span: Span; cond: Expr; body: Stmt }
export interface DoWhile { kind: 'do'; span: Span; body: Stmt; cond: Expr }
export interface For { kind: 'for'; span: Span; init: VarDecl | ExprStmt | null; cond: Expr | null; step: Expr | null; body: Stmt }
/** for (T x : array) */
export interface ForRange { kind: 'forRange'; span: Span; spec: TypeSpec; name: string; nameSpan: Span; isRef: boolean; range: Expr; body: Stmt }
export interface Switch { kind: 'switch'; span: Span; expr: Expr; body: Stmt }
export interface CaseLabel { kind: 'case'; span: Span; value: Expr }
export interface DefaultLabel { kind: 'default'; span: Span }
export interface Break { kind: 'break'; span: Span }
export interface Continue { kind: 'continue'; span: Span }
export interface Return { kind: 'return'; span: Span; value: Expr | null }
export interface Empty { kind: 'empty'; span: Span }
/** struct / enum / typedef inside a function body. */
export interface LocalTypeDecl { kind: 'localType'; span: Span; decl: StructDecl | EnumDecl | TypedefDecl; vars: VarDecl | null }
