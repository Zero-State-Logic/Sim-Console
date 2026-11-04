/* ============================================================
   BYTECODE — opcodes and the compiled program layout.
   A stack machine: code is a flat number array of opcodes and
   inline operands. Everything here is plain data, so a program
   survives structuredClone / postMessage into the worker.
   ============================================================ */

import type { Program, ValueType } from './api'

/** Opcodes. Operand counts are listed in OP_ARGS. */
export const Op = {
  HALT: 0,
  PUSH_I: 1, // imm
  PUSH_K: 2, // const index
  POP: 3,
  DUP: 4,
  DUP2: 5,
  DUP_X1: 6, // a b -> b a b
  DUP_X2: 7, // a b c -> c a b c
  LOAD_L: 8, // slot
  STORE_L: 9, // slot
  LOAD_G: 10, // global
  STORE_G: 11, // global
  LOAD_R: 12, // slot (ref pair in slot, slot+1)
  STORE_R: 13, // slot
  ADDR_L: 14, // slot -> container index
  ADDR_G: 15, // global
  ADDR_R: 16, // slot
  LOAD_IDX: 17, // site
  STORE_IDX: 18, // site
  STORE_IDX_K: 19, // site (leaves the value)
  CHECK_IDX: 20, // site (a i -> a i, bounds-checked)
  LOAD_FIELD: 21, // field
  STORE_FIELD: 22, // field
  STORE_FIELD_K: 23, // field
  NEWOBJ: 24, // type index
  CLONE_K: 25, // const index (deep copy of a constant array)
  COPY: 26, // deep copy of an array / struct
  COPY_INTO: 27, // dst src -> (copies src into dst in place)
  ADD: 28,
  SUB: 29,
  MUL: 30,
  DIV: 31,
  IMUL: 32,
  IDIV: 33, // site
  IMOD: 34, // site
  NEG: 35,
  BAND: 36,
  BOR: 37,
  BXOR: 38,
  BNOT: 39,
  SHL: 40,
  SHR: 41,
  USHR: 42,
  NOT: 43,
  TOBOOL: 44,
  LT: 45,
  LE: 46,
  GT: 47,
  GE: 48,
  EQ: 49,
  NE: 50,
  W8: 51,
  WU8: 52,
  W16: 53,
  WU16: 54,
  W32: 55,
  WU32: 56,
  FROUND: 57,
  F2I: 58, // to signed int32, saturating
  F2U: 59, // to uint32, saturating
  CONCAT: 60,
  TOSTR: 61, // kind (StrKind)
  JMP: 62, // target
  JZ: 63, // target
  JNZ: 64, // target
  CALL: 65, // function index
  RET: 66,
  RETV: 67,
  CALLB: 68, // builtin id, argc, site
  CALLN: 69, // native site, argc
  NEWN: 70, // class site, argc
  SLEEP: 71, // ms on stack (fractional allowed)
  YIELD: 72,
  LOOPDONE: 73,
  STR_INDEX: 74, // site: s i -> char code
  CHARS2STR: 75, // char array -> String
  PTR_ADD: 76, // site: cstr n -> cstr (pointer arithmetic on a string literal)
} as const

export type OpCode = (typeof Op)[keyof typeof Op]

/** Number of inline operands per opcode (index = opcode). */
export const OP_ARGS: number[] = (() => {
  const a = new Array<number>(77).fill(0)
  const one = [
    Op.PUSH_I, Op.PUSH_K, Op.LOAD_L, Op.STORE_L, Op.LOAD_G, Op.STORE_G, Op.LOAD_R, Op.STORE_R, Op.ADDR_L,
    Op.ADDR_G, Op.ADDR_R, Op.LOAD_IDX, Op.STORE_IDX, Op.STORE_IDX_K, Op.CHECK_IDX, Op.LOAD_FIELD,
    Op.STORE_FIELD, Op.STORE_FIELD_K, Op.NEWOBJ, Op.CLONE_K, Op.IDIV, Op.IMOD, Op.TOSTR, Op.JMP, Op.JZ,
    Op.JNZ, Op.CALL, Op.STR_INDEX, Op.PTR_ADD,
  ]
  for (const o of one) a[o] = 1
  a[Op.CALLB] = 3
  a[Op.CALLN] = 2
  a[Op.NEWN] = 2
  return a
})()

/** How TOSTR renders a number (Arduino String(x) rules). */
export const StrKind = { INT: 0, UINT: 1, CHAR: 2, FLOAT: 3 } as const

/** Runtime type descriptors (plain data) for default values and the watch panel. */
export type TypeDesc =
  | { k: 'num'; char?: boolean; bool?: boolean }
  | { k: 'str' }
  | { k: 'array'; elem: number; len: number }
  | { k: 'struct'; id: number }
  | { k: 'native'; cls: string }

export interface StructDesc {
  name: string
  fields: { name: string; type: number }[]
}

/** Fault site: where a runtime error is reported. */
export interface Site {
  line: number
  col: number
  endLine: number
  endCol: number
  /** Array / variable name for messages. */
  name: string
}

export interface FnDesc {
  name: string
  entry: number
  /** Stack slots taken by the parameters (a reference parameter takes 2). */
  paramSlots: number
  /** Total frame slots (parameters + locals + temporaries). */
  frameSlots: number
  line: number
}

export interface NativeSite {
  name: string
  argTypes: ValueType[]
  hasSelf: boolean
  /** Declared return type: the VM converts the host's answer to it. */
  ret: ValueType
}

export interface GlobalDesc {
  name: string
  type: number
  /** Hidden globals (static-local guards) are not shown in the watch panel. */
  hidden: boolean
}

export type ConstValue = number | string | ConstValue[]

export interface BytecodeProgram extends Program {
  readonly kind: 'kiyo-bytecode'
  readonly version: number
  readonly hasSetup: boolean
  readonly hasLoop: boolean
  readonly intBits: 16 | 32
  readonly code: number[]
  readonly consts: ConstValue[]
  readonly functions: FnDesc[]
  readonly globals: GlobalDesc[]
  readonly types: TypeDesc[]
  readonly structs: StructDesc[]
  readonly sites: Site[]
  readonly natives: NativeSite[]
  readonly classes: string[]
  /** pc → source position, sorted by pc. */
  readonly linePcs: number[]
  readonly lineNos: number[]
  readonly colNos: number[]
  /** Global initializers, then setup(), then the loop() driver. */
  readonly entry: number
}

export const PROGRAM_VERSION = 1
