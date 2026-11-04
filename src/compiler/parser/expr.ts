/* ============================================================
   EXPRESSIONS — precedence climbing for binary operators,
   recursive descent for unary / postfix / primary. C++ precedence:
   , < = op= < ?: < || < && < | < ^ < & < == != < relational
   < << >> < + - < * / % < unary < postfix.
   ============================================================ */

import type { Expr, TypeSpec } from '../ast'
import { spanOf, type Span } from '../diagnostics'
import { isTypeInParens, parseTypeSpec, type TypeHooks } from './types'
import { TYPE_WORDS, TokenStream, UNSUPPORTED } from './stream'

const BIN_PREC: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6,
  '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
}

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='])

/** Single-word builtin types usable as functional casts: int(x), byte(x), float(x). */
const FUNC_CAST = new Set([
  'int', 'long', 'short', 'float', 'double', 'char', 'byte', 'bool', 'boolean', 'word', 'unsigned', 'size_t',
  'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'int32_t', 'uint32_t',
])

export class ExprParser {
  constructor(private readonly ts: TokenStream, private readonly hooks: TypeHooks) {}

  /** Full expression including the comma operator. */
  expr(): Expr {
    let left = this.assign()
    while (this.ts.is(',')) {
      this.ts.next()
      const right = this.assign()
      left = { kind: 'comma', span: spanOf(left.span, right.span), left, right }
    }
    return left
  }

  assign(): Expr {
    const target = this.ternary()
    const t = this.ts.peek()
    if (t.kind === 'punct' && ASSIGN_OPS.has(t.text)) {
      this.ts.next()
      const value = this.ts.is('{') ? this.initList() : this.assign()
      return { kind: 'assign', span: spanOf(target.span, value.span), op: t.text, target, value, opSpan: t }
    }
    return target
  }

  ternary(): Expr {
    const cond = this.binary(1)
    if (!this.ts.is('?')) return cond
    this.ts.next()
    const a = this.expr()
    this.ts.expect(':', 'in conditional expression')
    const b = this.assign()
    return { kind: 'ternary', span: spanOf(cond.span, b.span), cond, a, b }
  }

  private binary(minPrec: number): Expr {
    let left = this.unary()
    for (;;) {
      const t = this.ts.peek()
      const prec = t.kind === 'punct' ? BIN_PREC[t.text] : undefined
      if (prec === undefined || prec < minPrec) return left
      this.ts.next()
      const right = this.binary(prec + 1)
      left = { kind: 'binary', span: spanOf(left.span, right.span), op: t.text, left, right, opSpan: t }
    }
  }

  unary(): Expr {
    const ts = this.ts
    const t = ts.peek()
    if (t.kind === 'punct') {
      if (t.text === '-' || t.text === '+' || t.text === '!' || t.text === '~' || t.text === '++' || t.text === '--' || t.text === '&' || t.text === '*') {
        ts.next()
        const e = this.unary()
        return { kind: 'unary', span: spanOf(t, e.span), op: t.text, expr: e }
      }
      if (t.text === '(' && isTypeInParens(ts)) return this.cast()
    }
    if (t.kind === 'ident' && t.text === 'sizeof') return this.sizeof()
    return this.postfix(this.primary())
  }

  private cast(): Expr {
    const open = this.ts.next()
    const type = parseTypeSpec(this.ts, this.hooks, true)
    this.ts.expect(')', 'to close the cast')
    const e = this.unary()
    return { kind: 'cast', span: spanOf(open, e.span), type, expr: e }
  }

  private sizeof(): Expr {
    const kw = this.ts.next()
    if (this.ts.is('(') && isTypeInParens(this.ts)) {
      this.ts.next()
      const type = parseTypeSpec(this.ts, this.hooks, true)
      this.ts.expect(')', 'after the sizeof type')
      return { kind: 'sizeof', span: this.ts.spanFrom(kw), type, expr: null }
    }
    const e = this.unary()
    return { kind: 'sizeof', span: spanOf(kw, e.span), type: null, expr: e }
  }

  private postfix(base: Expr): Expr {
    const ts = this.ts
    let e = base
    for (;;) {
      const t = ts.peek()
      if (t.kind !== 'punct') return e
      if (t.text === '[') {
        ts.next()
        const index = this.expr()
        ts.expect(']', 'to close the array index')
        e = { kind: 'index', span: ts.spanFrom(e.span), obj: e, index }
      } else if (t.text === '(') {
        ts.next()
        const args = this.args(')')
        e = { kind: 'call', span: ts.spanFrom(e.span), callee: e, args }
      } else if (t.text === '.' || t.text === '->') {
        ts.next()
        const name = ts.peek()
        if (name.kind !== 'ident') ts.fail(name, `Expected a member name after '${t.text}'`)
        ts.next()
        e = { kind: 'member', span: spanOf(e.span, name), obj: e, name: name.text, nameSpan: name, arrow: t.text === '->' }
      } else if (t.text === '++' || t.text === '--') {
        ts.next()
        e = { kind: 'postfix', span: spanOf(e.span, t), op: t.text, expr: e }
      } else {
        return e
      }
    }
  }

  /** Comma-separated assignment-expressions up to `close` (consumed). */
  args(close: string): Expr[] {
    const list: Expr[] = []
    if (this.ts.accept(close)) return list
    for (;;) {
      list.push(this.ts.is('{') ? this.initList() : this.assign())
      if (this.ts.accept(close)) return list
      this.ts.expect(',', `or '${close}' in the argument list`)
    }
  }

  initList(): Expr {
    const open = this.ts.expect('{')
    const items: Expr[] = []
    while (!this.ts.is('}')) {
      if (this.ts.is('.') && this.ts.peek(1).kind === 'ident') {
        this.ts.fail(this.ts.peek(), 'Designated initializers (.field = value) are not supported; list the values in field order')
      }
      items.push(this.ts.is('{') ? this.initList() : this.assign())
      if (!this.ts.accept(',')) break
    }
    this.ts.expect('}', 'to close the initializer list')
    return { kind: 'initList', span: this.ts.spanFrom(open), items }
  }

  private primary(): Expr {
    const ts = this.ts
    const t = ts.peek()
    switch (t.kind) {
      case 'int':
        ts.next()
        return { kind: 'int', span: t, value: t.num, unsigned: t.isUnsigned, long: t.isLong, radix: t.radix }
      case 'float':
        ts.next()
        return { kind: 'float', span: t, value: t.num, f32: t.isFloat32 }
      case 'char':
        ts.next()
        return { kind: 'char', span: t, value: t.num }
      case 'string':
        return this.strings()
      case 'ident':
        return this.identifier()
      default:
        break
    }
    if (t.text === '(') {
      ts.next()
      const e = this.expr()
      ts.expect(')', 'to close the parenthesis')
      return e
    }
    if (t.text === '{') return this.initList()
    const shown = t.kind === 'eof' ? 'end of file' : `'${t.text}'`
    return ts.fail(t, `Expected an expression, found ${shown}`)
  }

  /** Adjacent string literals concatenate: "abc" "def". */
  private strings(): Expr {
    const first = this.ts.next()
    let value = first.str
    let last: Span = first
    while (this.ts.peek().kind === 'string') {
      const s = this.ts.next()
      value += s.str
      last = s
    }
    return { kind: 'string', span: spanOf(first, last), value }
  }

  private identifier(): Expr {
    const ts = this.ts
    const t = ts.peek()
    const name = t.text
    const msg = UNSUPPORTED.get(name)
    if (msg) ts.fail(t, msg)
    if (name === 'true' || name === 'false') {
      ts.next()
      return { kind: 'bool', span: t, value: name === 'true' }
    }
    if (name === 'nullptr' || name === 'NULL') {
      ts.next()
      return { kind: 'int', span: t, value: 0, unsigned: false, long: false, radix: 10 }
    }
    if (FUNC_CAST.has(name) && ts.is('(', 1)) return this.funcCast()
    if ((name === 'String' || ts.isTypeName(name)) && (ts.is('(', 1) || ts.is('{', 1))) return this.construct()
    if (TYPE_WORDS.has(name)) ts.fail(t, `Unexpected type '${name}' in an expression`)
    ts.next()
    if (ts.is('::')) {
      ts.next()
      const member = ts.expectIdent('a name after ::')
      return { kind: 'scope', span: spanOf(t, member), scope: name, name: member.text }
    }
    return { kind: 'ident', span: t, name }
  }

  /** int(x), byte(x), unsigned(x) */
  private funcCast(): Expr {
    const t = this.ts.next()
    const type = typeSpecOf(t.text === 'boolean' ? 'bool' : t.text === 'unsigned' ? 'unsigned int' : t.text, t, false)
    this.ts.expect('(')
    const args = this.args(')')
    const span = this.ts.spanFrom(t)
    if (args.length !== 1) this.ts.fail(span, `Functional cast ${t.text}(...) takes exactly one value`)
    return { kind: 'cast', span, type, expr: args[0] }
  }

  /** String(x, HEX), Servo(), Adafruit_PWMServoDriver(0x40), Point{1, 2} */
  private construct(): Expr {
    const t = this.ts.next()
    const type = typeSpecOf(t.text, t, t.text !== 'String')
    const brace = this.ts.is('{')
    this.ts.next()
    const args = this.args(brace ? '}' : ')')
    return { kind: 'construct', span: this.ts.spanFrom(t), type, args }
  }
}

export function typeSpecOf(name: string, span: Span, named: boolean): TypeSpec {
  return { span, name, named, isConst: false, isStatic: false, pointer: 0, inferred: false }
}
