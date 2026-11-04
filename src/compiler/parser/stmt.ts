/* ============================================================
   STATEMENTS AND DECLARATORS — blocks, control flow, switch
   labels, local declarations `int a = 1, b[3] = {1,2,3};`,
   direct init `Servo s(9);`, range-for. Errors recover at the
   next ';' so one typo does not hide the rest of the file.
   ============================================================ */

import type { Block, Declarator, Expr, ForRange, Stmt, VarDecl } from '../ast'
import type { Span } from '../diagnostics'
import { ExprParser } from './expr'
import { ParseError, TokenStream, UNSUPPORTED } from './stream'
import { isTypeStart, parseTypeSpec, type TypeHooks } from './types'

export class StmtParser {
  readonly ex: ExprParser

  constructor(readonly ts: TokenStream, readonly hooks: TypeHooks, readonly localType: (ts: TokenStream) => Stmt | null) {
    this.ex = new ExprParser(ts, hooks)
  }

  block(): Block {
    const open = this.ts.expect('{')
    const body: Stmt[] = []
    while (!this.ts.is('}') && !this.ts.atEnd) {
      const before = this.ts.pos
      try {
        body.push(this.statement())
      } catch (e) {
        if (!(e instanceof ParseError)) throw e
        this.ts.syncStatement()
        if (this.ts.pos === before) this.ts.next()
      }
      if (this.ts.diags.full) break
    }
    if (this.ts.atEnd) this.ts.fail(open, "Missing '}' to close this block")
    this.ts.next()
    return { kind: 'block', span: this.ts.spanFrom(open), body }
  }

  statement(): Stmt {
    const ts = this.ts
    const t = ts.peek()
    if (t.kind === 'punct') {
      if (t.text === '{') return this.block()
      if (t.text === ';') {
        ts.next()
        return { kind: 'empty', span: t }
      }
    }
    if (t.kind === 'ident') {
      const kw = this.keyword(t.text)
      if (kw) return kw
      if (ts.is(':', 1)) ts.fail(t, 'Labels and goto are not supported')
      const local = this.localType(ts)
      if (local) return local
      if (isTypeStart(ts)) {
        const decl = this.varDecl()
        ts.expect(';', 'after the declaration')
        return decl
      }
    }
    const expr = this.ex.expr()
    ts.expect(';', 'after the expression')
    return { kind: 'expr', span: ts.spanFrom(expr.span), expr }
  }

  private keyword(word: string): Stmt | null {
    switch (word) {
      case 'if': return this.ifStmt()
      case 'while': return this.whileStmt()
      case 'do': return this.doStmt()
      case 'for': return this.forStmt()
      case 'switch': return this.switchStmt()
      case 'case': return this.caseLabel()
      case 'default': return this.defaultLabel()
      case 'break':
      case 'continue': {
        const t = this.ts.next()
        this.ts.expect(';', `after '${word}'`)
        return { kind: word, span: t }
      }
      case 'return': return this.returnStmt()
      default: {
        const msg = UNSUPPORTED.get(word)
        if (msg && word !== 'new' && word !== 'delete' && word !== 'this') this.ts.fail(this.ts.peek(), msg)
        return null
      }
    }
  }

  private condition(what: string): Expr {
    this.ts.expect('(', `after '${what}'`)
    const c = this.ex.expr()
    this.ts.expect(')', `to close the ${what} condition`)
    return c
  }

  private ifStmt(): Stmt {
    const kw = this.ts.next()
    const cond = this.condition('if')
    const then = this.statement()
    const els = this.ts.accept('else') ? this.statement() : null
    return { kind: 'if', span: this.ts.spanFrom(kw), cond, then, else: els }
  }

  private whileStmt(): Stmt {
    const kw = this.ts.next()
    const cond = this.condition('while')
    const body = this.statement()
    return { kind: 'while', span: this.ts.spanFrom(kw), cond, body }
  }

  private doStmt(): Stmt {
    const kw = this.ts.next()
    const body = this.statement()
    this.ts.expect('while', "after the do { } body")
    const cond = this.condition('while')
    this.ts.expect(';', 'after do { } while (...)')
    return { kind: 'do', span: this.ts.spanFrom(kw), body, cond }
  }

  private forStmt(): Stmt {
    const ts = this.ts
    const kw = ts.next()
    ts.expect('(', "after 'for'")
    let init: VarDecl | { kind: 'expr'; span: Span; expr: Expr } | null = null
    if (!ts.is(';')) {
      if (isTypeStart(ts)) {
        const range = this.tryRangeFor(kw)
        if (range) return range
        init = this.varDecl()
      } else {
        const e = this.ex.expr()
        init = { kind: 'expr', span: e.span, expr: e }
      }
    }
    ts.expect(';', 'in the for (init; condition; step) header')
    const cond = ts.is(';') ? null : this.ex.expr()
    ts.expect(';', 'in the for (init; condition; step) header')
    const step = ts.is(')') ? null : this.ex.expr()
    ts.expect(')', 'to close the for header')
    const body = this.statement()
    return { kind: 'for', span: ts.spanFrom(kw), init, cond, step, body }
  }

  /** for (int x : arr) / for (auto &x : arr) */
  private tryRangeFor(kw: Span): ForRange | null {
    const ts = this.ts
    const save = ts.pos
    try {
      const spec = parseTypeSpec(ts, this.hooks, true)
      const isRef = ts.accept('&')
      const name = ts.peek()
      if (name.kind !== 'ident' || !ts.is(':', 1)) {
        ts.pos = save
        return null
      }
      ts.next()
      ts.next()
      const range = this.ex.expr()
      ts.expect(')', 'to close the for header')
      const body = this.statement()
      return { kind: 'forRange', span: ts.spanFrom(kw), spec, name: name.text, nameSpan: name, isRef, range, body }
    } catch (e) {
      if (!(e instanceof ParseError)) throw e
      ts.pos = save
      return null
    }
  }

  private switchStmt(): Stmt {
    const kw = this.ts.next()
    const expr = this.condition('switch')
    const body = this.statement()
    return { kind: 'switch', span: this.ts.spanFrom(kw), expr, body }
  }

  private caseLabel(): Stmt {
    const kw = this.ts.next()
    const value = this.ex.ternary()
    if (this.ts.is('...')) this.ts.fail(this.ts.peek(), "Case ranges ('case 1 ... 5:') are not supported; list each case")
    this.ts.expect(':', 'after the case value')
    return { kind: 'case', span: this.ts.spanFrom(kw), value }
  }

  private defaultLabel(): Stmt {
    const kw = this.ts.next()
    this.ts.expect(':', "after 'default'")
    return { kind: 'default', span: kw }
  }

  private returnStmt(): Stmt {
    const kw = this.ts.next()
    const value = this.ts.is(';') ? null : this.ex.expr()
    this.ts.expect(';', 'after the return statement')
    return { kind: 'return', span: this.ts.spanFrom(kw), value }
  }

  /** `spec declarator, declarator` without the trailing ';'. */
  varDecl(): VarDecl {
    const spec = parseTypeSpec(this.ts, this.hooks, false)
    if (this.ts.is(';') && (spec.structDef || spec.enumDef)) return { kind: 'var', span: spec.span, spec, decls: [] }
    const decls = this.declarators()
    return { kind: 'var', span: this.ts.spanFrom(spec.span), spec, decls }
  }

  declarators(first?: { name: Span & { text: string }; pointer: number }): Declarator[] {
    const list: Declarator[] = []
    let pending = first
    for (;;) {
      list.push(this.declarator(pending))
      pending = undefined
      if (!this.ts.accept(',')) return list
    }
  }

  private declarator(first?: { name: Span & { text: string }; pointer: number }): Declarator {
    const ts = this.ts
    let pointer = first?.pointer ?? 0
    let isRef = false
    if (!first) {
      while (ts.accept('*')) pointer++
      isRef = ts.accept('&')
    }
    const nameTok = first?.name ?? ts.expectIdent('a variable name')
    const dims: (Expr | null)[] = []
    while (ts.accept('[')) {
      dims.push(ts.is(']') ? null : this.ex.expr())
      ts.expect(']', 'to close the array size')
    }
    // `const uint8_t table[] PROGMEM = {...}`: flash placement is meaningless here
    while (ts.is('PROGMEM')) ts.next()
    let init: Expr | null = null
    let ctorArgs: Expr[] | null = null
    if (ts.accept('=')) init = ts.is('{') ? this.ex.initList() : this.ex.assign()
    else if (ts.is('{')) init = this.ex.initList()
    else if (ts.accept('(')) ctorArgs = this.ex.args(')')
    return { span: ts.spanFrom(nameTok), name: nameTok.text, nameSpan: nameTok, dims, isRef, pointer, init, ctorArgs }
  }
}
