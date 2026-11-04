/* ============================================================
   PARSER ENTRY — top-level declarations: functions and
   prototypes, globals, struct / enum / typedef definitions.
   Collects as many errors as it can by resynchronising after
   each broken declaration.
   ============================================================ */

import type { EnumDecl, FuncDecl, Param, Stmt, StructDecl, TopLevel, TranslationUnit, TypedefDecl, TypeSpec, VarDecl } from '../ast'
import { DiagBag, type Span } from '../diagnostics'
import type { Token } from '../lexer'
import { StmtParser } from './stmt'
import { ParseError, TokenStream, TYPE_WORDS, UNSUPPORTED } from './stream'
import { isTypeStart, parseTypeSpec, type TypeHooks } from './types'

export function parse(tokens: Token[], classNames: readonly string[], diags: DiagBag): TranslationUnit {
  return new Parser(tokens, classNames, diags).unit()
}

class Parser implements TypeHooks {
  private readonly ts: TokenStream
  private readonly sp: StmtParser

  constructor(tokens: Token[], classNames: readonly string[], diags: DiagBag) {
    this.ts = new TokenStream(tokens, diags, classNames)
    this.sp = new StmtParser(this.ts, this, (ts) => this.localType(ts))
  }

  unit(): TranslationUnit {
    const items: TopLevel[] = []
    const ts = this.ts
    while (!ts.atEnd && !ts.diags.full) {
      const before = ts.pos
      try {
        this.topLevel(items)
      } catch (e) {
        if (!(e instanceof ParseError)) throw e
        ts.pos = Math.max(ts.pos, before)
        ts.syncTopLevel()
      }
    }
    return { items }
  }

  private topLevel(items: TopLevel[]): void {
    const ts = this.ts
    const t = ts.peek()
    if (ts.accept(';')) return
    if (t.kind === 'ident') {
      if (t.text === 'typedef') {
        items.push(this.typedef())
        return
      }
      if (t.text === 'using') {
        ts.diags.warning(t, "'using' is ignored by the simulator")
        while (!ts.atEnd && !ts.accept(';')) ts.next()
        return
      }
      const msg = UNSUPPORTED.get(t.text)
      if (msg) ts.fail(t, msg)
      if ((t.text === 'struct' || t.text === 'enum') && this.isBareTypeDef()) {
        this.bareTypeDef(items)
        return
      }
    }
    if (!isTypeStart(ts)) this.notAType(t)
    const spec = parseTypeSpec(ts, this, false)
    if (spec.structDef) items.push(spec.structDef)
    if (spec.enumDef) items.push(spec.enumDef)
    if (ts.accept(';')) return
    let pointer = 0
    while (ts.accept('*')) pointer++
    const isRef = ts.accept('&')
    const name = ts.expectIdent('a name for the declaration')
    if (ts.is('(') && this.isFunction(spec)) {
      items.push(this.func({ ...spec, pointer: spec.pointer + pointer }, name, isRef))
      return
    }
    if (isRef) ts.fail(name, `Reference variable '${name.text}' must be a function parameter`)
    const decls = this.sp.declarators({ name, pointer })
    ts.expect(';', 'after the declaration')
    items.push({ kind: 'var', span: ts.spanFrom(spec.span), spec, decls })
  }

  private notAType(t: Token): never {
    const ts = this.ts
    if (t.kind === 'ident' && ts.is('(', 1)) {
      ts.fail(t, `'${t.text}(...)' looks like a call outside any function. Statements must go inside setup() or loop()`)
    }
    if (t.kind === 'ident' && (ts.peek(1).kind === 'ident' || ts.is('*', 1))) {
      ts.fail(t, `Unknown type '${t.text}'. Is a #include missing, or is it a typo?`)
    }
    if (t.text === '}') ts.fail(t, "Unexpected '}' (no block is open here)")
    return ts.fail(t, `Expected a declaration, found '${t.text || 'end of file'}'`)
  }

  /** `struct X {...};` / `enum E {...};` (also with trailing declarators). */
  private isBareTypeDef(): boolean {
    const ts = this.ts
    if (ts.is('{', 1)) return true
    if (ts.peek(1).kind === 'ident' && (ts.is('{', 2) || ts.is(':', 2))) return true
    return ts.is('class', 1) || ts.is('struct', 1)
  }

  private bareTypeDef(items: TopLevel[]): void {
    const decl = this.sp.varDecl()
    if (decl.spec.structDef) items.push(decl.spec.structDef)
    if (decl.spec.enumDef) items.push(decl.spec.enumDef)
    this.ts.expect(';', `after the ${decl.spec.structDef ? 'struct' : 'enum'} definition`)
    if (decl.decls.length > 0) items.push(decl)
  }

  /** After `T name`, is the '(' a parameter list (function) or constructor arguments? */
  private isFunction(spec: TypeSpec): boolean {
    const ts = this.ts
    if (ts.is(')', 1)) return !ts.classNames.has(spec.name) || ts.is('{', 2)
    if (this.bodyFollowsParens()) return true
    const t = ts.peek(1)
    if (t.kind !== 'ident') return false
    if (t.text === 'void' || t.text === 'const' || t.text === 'struct' || TYPE_WORDS.has(t.text)) return true
    return ts.isTypeName(t.text)
  }

  /** `name(...) {` is a function definition whatever the parentheses hold. */
  private bodyFollowsParens(): boolean {
    let depth = 0
    for (let k = 0; ; k++) {
      const t = this.ts.peek(k)
      if (t.kind === 'eof') return false
      if (t.text === '(') depth++
      else if (t.text === ')' && --depth === 0) return this.ts.is('{', k + 1)
    }
  }

  private func(ret: TypeSpec, name: Token, isRef: boolean): FuncDecl {
    const ts = this.ts
    if (isRef) ts.fail(name, 'Functions returning references are not supported')
    ts.expect('(')
    const params = this.params()
    if (ts.is('const')) ts.fail(ts.peek(), 'Member functions are not supported')
    let body = null
    if (!ts.accept(';')) {
      if (!ts.is('{')) ts.fail(ts.missingSpan(), ts.missingMessage('{', `to start the body of '${name.text}()'`))
      body = this.sp.block()
    }
    return { kind: 'func', span: ts.spanFrom(ret.span), ret, name: name.text, nameSpan: name, params, body }
  }

  private params(): Param[] {
    const ts = this.ts
    const list: Param[] = []
    if (ts.accept(')')) return list
    if (ts.is('void') && ts.is(')', 1)) {
      ts.next()
      ts.next()
      return list
    }
    for (;;) {
      list.push(this.param())
      if (ts.accept(')')) return list
      if (ts.is('...')) ts.fail(ts.peek(), 'Variadic functions (...) are not supported')
      ts.expect(',', "or ')' in the parameter list")
    }
  }

  private param(): Param {
    const ts = this.ts
    const start = ts.peek()
    if (!isTypeStart(ts)) {
      if (start.kind === 'ident' && (ts.is(',', 1) || ts.is(')', 1))) {
        ts.fail(start, `Parameter '${start.text}' has no type (write e.g. 'int ${start.text}')`)
      }
      ts.fail(start, `Unknown parameter type '${start.text}'`)
    }
    const spec = parseTypeSpec(ts, this, true)
    const isRef = ts.accept('&')
    let name: string | null = null
    let nameSpan: Span = ts.prev
    if (ts.peek().kind === 'ident' && !ts.is('const')) {
      const n = ts.expectIdent('a parameter name')
      name = n.text
      nameSpan = n
    }
    const dims = []
    while (ts.accept('[')) {
      dims.push(ts.is(']') ? null : this.sp.ex.ternary())
      ts.expect(']', 'to close the array parameter size')
    }
    const defaultValue = ts.accept('=') ? this.sp.ex.assign() : null
    return { span: ts.spanFrom(start), spec, name, nameSpan, isRef, dims, defaultValue }
  }

  private typedef(): TypedefDecl {
    const ts = this.ts
    const kw = ts.next()
    const spec = parseTypeSpec(ts, this, true)
    if (ts.is('(')) ts.fail(ts.peek(), 'Function-pointer typedefs are not supported')
    const name = ts.expectIdent('a name for the typedef')
    const dims = []
    while (ts.accept('[')) {
      dims.push(ts.is(']') ? null : this.sp.ex.ternary())
      ts.expect(']')
    }
    ts.expect(';', 'after the typedef')
    ts.typeNames.add(name.text)
    if (spec.structDef) ts.structNames.add(name.text)
    return { kind: 'typedef', span: ts.spanFrom(kw), spec, name: name.text, nameSpan: name, dims }
  }

  /** struct / enum / typedef inside a function body. */
  private localType(ts: TokenStream): Stmt | null {
    const t = ts.peek()
    if (t.text === 'typedef') {
      const decl = this.typedef()
      return { kind: 'localType', span: decl.span, decl, vars: null }
    }
    if ((t.text === 'struct' || t.text === 'enum') && this.isBareTypeDef()) {
      const decl = this.sp.varDecl()
      ts.expect(';', 'after the type definition')
      const def = decl.spec.structDef ?? decl.spec.enumDef
      if (!def) return { kind: 'empty', span: t }
      const vars = decl.decls.length > 0 ? { ...decl, spec: { ...decl.spec, structDef: undefined, enumDef: undefined } } : null
      return { kind: 'localType', span: decl.span, decl: def, vars }
    }
    return null
  }

  /* ---------------- TypeHooks ---------------- */

  structBody(ts: TokenStream, start: Token, name: string, nameTok: Token): StructDecl {
    ts.expect('{')
    ts.typeNames.add(name)
    ts.structNames.add(name)
    const fields: VarDecl[] = []
    while (!ts.is('}') && !ts.atEnd) {
      const t = ts.peek()
      if ((t.text === 'public' || t.text === 'private' || t.text === 'protected') && ts.is(':', 1)) {
        ts.next()
        ts.next()
        continue
      }
      if (t.text === name && ts.is('(', 1)) ts.fail(t, 'Struct constructors are not supported; initialise with { ... } instead')
      if (!isTypeStart(ts)) ts.fail(t, `Expected a field declaration in struct '${name}', found '${t.text}'`)
      const decl = this.sp.varDecl()
      const method = decl.decls.find((d) => d.ctorArgs !== null)
      if (method || ts.is('{')) {
        ts.fail(method?.nameSpan ?? ts.peek(), `Member functions are not supported in structs. Write a plain function that takes '${name} &' instead`)
      }
      ts.expect(';', 'after the struct field')
      fields.push(decl)
    }
    ts.expect('}', `to close struct '${name}'`)
    return { kind: 'struct', span: ts.spanFrom(start), name, nameSpan: nameTok, fields }
  }

  enumBody(ts: TokenStream, start: Token, name: string | null, isClass: boolean): EnumDecl {
    ts.expect('{')
    if (name) ts.typeNames.add(name)
    const members: EnumDecl['members'] = []
    while (!ts.is('}') && !ts.atEnd) {
      const id = ts.expectIdent('an enum member name')
      const value = ts.accept('=') ? this.sp.ex.ternary() : null
      members.push({ name: id.text, span: id, value })
      if (!ts.accept(',')) break
    }
    ts.expect('}', 'to close the enum')
    return { kind: 'enum', span: ts.spanFrom(start), name, isClass, members }
  }
}
