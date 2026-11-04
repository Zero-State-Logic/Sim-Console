/* ============================================================
   STRING METHODS — Arduino WString.h semantics. Mutating methods
   (toUpperCase, trim, concat, replace, remove, setCharAt) change
   the String in place, so they need a variable as receiver.
   ============================================================ */

import { B } from '../builtins'
import { isCharArray, isInteger, T, typeName, type CType } from '../ctypes'
import { didYouMean, type Span } from '../diagnostics'
import type { Expr } from '../ast'
import { table } from '../tables'
import type { TExpr, TLValue } from '../tir'
import type { Sema } from './context'
import { constNum, convertTo, numConvert, toStringExpr } from './convert'
import { checkExpr, errExpr } from './exprs'

interface MethodDef {
  id: number
  min: number
  max: number
  ret: CType
  /** How each argument is converted. */
  args: ('int' | 'str' | 'strOrChar' | 'any' | 'chars')[]
  mutate?: 'void' | 'true'
}

const METHODS: Readonly<Record<string, MethodDef>> = table({
  length: { id: B.S_LENGTH, min: 0, max: 0, ret: T.uint, args: [] },
  charAt: { id: B.S_CHARAT, min: 1, max: 1, ret: T.char, args: ['int'] },
  substring: { id: B.S_SUBSTRING, min: 1, max: 2, ret: T.string, args: ['int', 'int'] },
  indexOf: { id: B.S_INDEXOF, min: 1, max: 2, ret: T.int, args: ['strOrChar', 'int'] },
  lastIndexOf: { id: B.S_LASTINDEXOF, min: 1, max: 2, ret: T.int, args: ['strOrChar', 'int'] },
  toInt: { id: B.S_TOINT, min: 0, max: 0, ret: T.long, args: [] },
  toFloat: { id: B.S_TOFLOAT, min: 0, max: 0, ret: T.float, args: [] },
  toDouble: { id: B.S_TODOUBLE, min: 0, max: 0, ret: T.double, args: [] },
  equals: { id: B.S_EQUALS, min: 1, max: 1, ret: T.bool, args: ['str'] },
  equalsIgnoreCase: { id: B.S_EQUALS_IC, min: 1, max: 1, ret: T.bool, args: ['str'] },
  startsWith: { id: B.S_STARTSWITH, min: 1, max: 2, ret: T.bool, args: ['str', 'int'] },
  endsWith: { id: B.S_ENDSWITH, min: 1, max: 1, ret: T.bool, args: ['str'] },
  compareTo: { id: B.S_COMPARETO, min: 1, max: 1, ret: T.int, args: ['str'] },
  isEmpty: { id: B.S_ISEMPTY, min: 0, max: 0, ret: T.bool, args: [] },
  toCharArray: { id: B.S_TOCHARARRAY, min: 2, max: 3, ret: T.void, args: ['chars', 'int', 'int'] },
  getBytes: { id: B.S_TOCHARARRAY, min: 2, max: 3, ret: T.void, args: ['chars', 'int', 'int'] },
  toUpperCase: { id: B.S_TOUPPER, min: 0, max: 0, ret: T.void, args: [], mutate: 'void' },
  toLowerCase: { id: B.S_TOLOWER, min: 0, max: 0, ret: T.void, args: [], mutate: 'void' },
  trim: { id: B.S_TRIM, min: 0, max: 0, ret: T.void, args: [], mutate: 'void' },
  concat: { id: B.S_CONCAT, min: 1, max: 1, ret: T.bool, args: ['any'], mutate: 'true' },
  replace: { id: B.S_REPLACE, min: 2, max: 2, ret: T.void, args: ['strOrChar', 'strOrChar'], mutate: 'void' },
  remove: { id: B.S_REMOVE, min: 1, max: 2, ret: T.void, args: ['int', 'int'], mutate: 'void' },
  setCharAt: { id: B.S_SETCHARAT, min: 2, max: 2, ret: T.void, args: ['int', 'int'], mutate: 'void' },
})

export function stringMethod(cx: Sema, recv: TExpr, lv: TLValue | null, name: string, argExprs: Expr[], span: Span): TExpr {
  if (name === 'c_str') return { k: 'convert', ty: T.cstr, from: T.string, e: recv, span }
  if (name === 'reserve') {
    const n = argExprs[0] ? checkExpr(cx, argExprs[0]) : constNum(T.uint, 0, span)
    return { k: 'comma', ty: T.bool, a: n, b: constNum(T.bool, 1, span), span }
  }
  const def = METHODS[name]
  if (!def) {
    cx.error(span, `'String' has no method named '${name}'.${didYouMean(name, [...Object.keys(METHODS), 'c_str', 'reserve'])}`)
    return errExpr(span)
  }
  if (argExprs.length < def.min || argExprs.length > def.max) {
    const want = def.min === def.max ? `${def.min}` : `${def.min} to ${def.max}`
    cx.error(span, `String.${name}() takes ${want} argument${def.max === 1 ? '' : 's'}, got ${argExprs.length}`)
    return errExpr(span)
  }
  const args: TExpr[] = []
  for (let i = 0; i < argExprs.length; i++) {
    const a = methodArg(cx, def.args[i], checkExpr(cx, argExprs[i]), argExprs[i].span)
    if (a.ty.t === 'error') return errExpr(span)
    args.push(a)
  }
  if (def.mutate) {
    if (!lv) return { k: 'builtin', ty: def.mutate === 'true' ? T.bool : T.void, id: def.id, args: [recv, ...args], site: -1, span }
    return { k: 'strMutate', ty: def.mutate === 'true' ? T.bool : T.void, lv, id: def.id, args, result: def.mutate, span }
  }
  return { k: 'builtin', ty: def.ret, id: def.id, args: [recv, ...args], site: cx.site(span, name), span }
}

function methodArg(cx: Sema, kind: MethodDef['args'][number], a: TExpr, span: Span): TExpr {
  if (a.ty.t === 'error') return a
  switch (kind) {
    case 'int':
      if (!isInteger(a.ty)) {
        cx.error(span, `Expected an integer here, got '${typeName(a.ty)}'`)
        return errExpr(span)
      }
      return numConvert(cx, a, T.long)
    case 'str': return convertTo(cx, a, T.string, span, 'arg')
    case 'strOrChar':
      if (a.ty.t === 'prim' && a.ty.p === 'char') return a
      return convertTo(cx, a, T.string, span, 'arg')
    case 'chars':
      if (!isCharArray(a.ty)) {
        cx.error(span, `Expected a char array (e.g. char buf[20]), got '${typeName(a.ty)}'`)
        return errExpr(span)
      }
      return a
    default:
      return toStringExpr(cx, a, span)
  }
}
