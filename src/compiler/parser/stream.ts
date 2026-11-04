/* ============================================================
   TOKEN STREAM — cursor, expectations and error recovery shared
   by the recursive-descent parser files. Also tracks which
   identifiers name types (C++ needs this to tell `T x;` from `a * b;`).
   ============================================================ */

import { DiagBag, type Span } from '../diagnostics'
import type { Token } from '../lexer'

export class ParseError extends Error {}

/** Words that start a builtin type. */
export const TYPE_WORDS = new Set([
  'void', 'bool', 'boolean', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned',
  'byte', 'word', 'String', 'size_t', 'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'int32_t', 'uint32_t',
  'int64_t', 'uint64_t',
])

/** Qualifiers accepted (and mostly ignored) before or after a type. */
export const QUALIFIERS = new Set(['const', 'constexpr', 'static', 'volatile', 'extern', 'inline', 'register', 'PROGMEM', 'mutable'])

/** Keywords that are not identifiers and are not supported. */
export const UNSUPPORTED = new Map<string, string>([
  ['new', "'new' is not supported: there is no dynamic memory in the simulator. Declare a variable or a fixed-size array instead"],
  ['delete', "'delete' is not supported: there is no dynamic memory in the simulator"],
  ['this', "'this' is not supported: structs have fields only, not member functions"],
  ['goto', "'goto' is not supported. Use a loop with break / continue instead"],
  ['try', 'Exceptions (try / catch / throw) are not supported on Arduino'],
  ['throw', 'Exceptions (try / catch / throw) are not supported on Arduino'],
  ['template', 'Templates are not supported in the simulator'],
  ['namespace', 'Namespaces are not supported in the simulator'],
  ['class', 'C++ classes are not supported. Use a struct with fields and plain functions that take it by reference'],
  ['union', 'Unions are not supported in the simulator'],
  ['operator', 'Operator overloading is not supported in the simulator'],
  ['asm', 'Inline assembly is not supported in the simulator'],
])

export class TokenStream {
  pos = 0
  /** struct / enum / typedef names declared so far, plus native class names. */
  readonly typeNames = new Set<string>()
  readonly structNames = new Set<string>()
  readonly classNames: Set<string>

  constructor(readonly toks: Token[], readonly diags: DiagBag, classNames: readonly string[]) {
    this.classNames = new Set(classNames)
    for (const c of classNames) this.typeNames.add(c)
  }

  peek(k = 0): Token {
    return this.toks[Math.min(this.pos + k, this.toks.length - 1)]
  }

  get prev(): Token {
    return this.toks[Math.max(0, this.pos - 1)]
  }

  next(): Token {
    const t = this.peek()
    if (t.kind !== 'eof') this.pos++
    return t
  }

  /** True when the current token is the punctuator or keyword `text`. */
  is(text: string, k = 0): boolean {
    const t = this.peek(k)
    return (t.kind === 'punct' || t.kind === 'ident') && t.text === text
  }

  accept(text: string): boolean {
    if (!this.is(text)) return false
    this.pos++
    return true
  }

  get atEnd(): boolean {
    return this.peek().kind === 'eof'
  }

  expect(text: string, context = ''): Token {
    if (this.is(text)) return this.next()
    return this.fail(this.missingSpan(), this.missingMessage(text, context))
  }

  expectIdent(what: string): Token {
    const t = this.peek()
    if (t.kind === 'ident' && !TYPE_WORDS.has(t.text) && !UNSUPPORTED.has(t.text)) return this.next()
    const shown = t.kind === 'eof' ? 'end of file' : `'${t.text}'`
    return this.fail(t, `Expected ${what}, found ${shown}`)
  }

  fail(span: Span, message: string): never {
    this.diags.error(span, message)
    throw new ParseError(message)
  }

  /** Where a missing token belongs: right after the previous token. */
  missingSpan(): Span {
    const p = this.prev
    if (this.pos === 0) return this.peek()
    return { line: p.endLine, col: p.endCol, endLine: p.endLine, endCol: p.endCol + 1 }
  }

  missingMessage(text: string, context: string): string {
    const n = this.peek()
    const where = n.kind === 'eof' ? ' at end of file' : n.line > this.prev.endLine ? ' at the end of this line' : ` before '${n.text}'`
    return `Expected '${text}'${context ? ` ${context}` : ''}${where}`
  }

  spanFrom(start: Span): Span {
    const p = this.prev
    return { line: start.line, col: start.col, endLine: p.endLine, endCol: p.endCol }
  }

  isTypeName(name: string): boolean {
    return this.typeNames.has(name)
  }

  /** Skips to just after the next ';' at bracket depth 0, or to a '}' that closes the current depth. */
  syncStatement(): void {
    let depth = 0
    while (!this.atEnd) {
      const t = this.peek()
      if (t.text === '{' || t.text === '(' || t.text === '[') depth++
      else if (t.text === ')' || t.text === ']') depth = Math.max(0, depth - 1)
      else if (t.text === '}') {
        if (depth === 0) return
        depth--
        if (depth === 0 && t.kind === 'punct') {
          this.pos++
          if (this.is(';')) this.pos++
          return
        }
      } else if (t.text === ';' && depth === 0) {
        this.pos++
        return
      }
      this.pos++
    }
  }

  /** Top-level recovery: skip a whole declaration including a braced body. */
  syncTopLevel(): void {
    let depth = 0
    while (!this.atEnd) {
      const t = this.next()
      if (t.kind !== 'punct') continue
      if (t.text === '{') depth++
      else if (t.text === '}') {
        depth--
        if (depth <= 0) {
          this.accept(';')
          return
        }
      } else if (t.text === ';' && depth <= 0) return
    }
  }
}
