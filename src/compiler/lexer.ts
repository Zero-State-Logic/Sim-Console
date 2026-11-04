/* ============================================================
   LEXER — source text → tokens with 1-based line/col ranges.
   Handles // and block comments, backslash-newline splices,
   char/string escapes, and int literals in hex/binary/octal/decimal
   with u/l suffixes, floats with f suffix.
   ============================================================ */

import { DiagBag, type Span } from './diagnostics'

export type TokKind = 'ident' | 'int' | 'float' | 'char' | 'string' | 'punct' | 'eof'

export interface Token extends Span {
  kind: TokKind
  /** Identifier name, punctuator, or the raw literal spelling. */
  text: string
  /** Numeric value of int / float / char literals. */
  num: number
  /** Decoded value of a string literal. */
  str: string
  /** Integer literal suffixes and radix (they decide the literal's C type). */
  isUnsigned: boolean
  isLong: boolean
  isFloat32: boolean
  radix: number
  /** First token on its source line (a directive starts with '#' here). */
  nl: boolean
  /** Whitespace precedes the token (function-like #define needs NAME( with no space). */
  space: boolean
  /** Macros that must not re-expand inside this token's expansion. */
  hide?: readonly string[]
}

const PUNCTS = [
  '<<=', '>>=', '...', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '::', '##',
]
const SINGLE = '+-*/%<>=!~&|^?:;,.()[]{}#'

const ESCAPES: Record<string, number> = {
  n: 10, t: 9, r: 13, '0': 0, '\\': 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11, '?': 63, e: 27,
}

const SMART_QUOTES = /[‘’“”]/

export function lex(src: string, diags: DiagBag): Token[] {
  return new Lexer(src, diags).run()
}

class Lexer {
  private i = 0
  private line = 1
  private lineStart = 0
  private nl = true
  private space = false
  private readonly out: Token[] = []

  constructor(private readonly src: string, private readonly diags: DiagBag) {}

  run(): Token[] {
    const s = this.src
    while (this.i < s.length) {
      const c = s[this.i]
      if (c === '\n') {
        this.newline(this.i + 1)
        continue
      }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
        this.i++
        this.space = true
        continue
      }
      if (c === '\\' && this.spliceAt(this.i)) continue
      if (c === '/' && s[this.i + 1] === '/') {
        this.lineComment()
        continue
      }
      if (c === '/' && s[this.i + 1] === '*') {
        this.blockComment()
        continue
      }
      this.token()
    }
    const eof = this.make('eof', '', this.i, this.i)
    this.out.push(eof)
    return this.out
  }

  private newline(next: number): void {
    this.i = next
    this.line++
    this.lineStart = next
    this.nl = true
    this.space = true
  }

  /** Backslash at end of line joins lines (used by multi-line #define). */
  private spliceAt(at: number): boolean {
    let j = at + 1
    if (this.src[j] === '\r') j++
    if (this.src[j] !== '\n') return false
    this.i = j + 1
    this.line++
    this.lineStart = j + 1
    this.space = true
    return true
  }

  private lineComment(): void {
    const s = this.src
    while (this.i < s.length && s[this.i] !== '\n') {
      if (s[this.i] === '\\' && this.spliceAt(this.i)) continue
      this.i++
    }
    this.space = true
  }

  private blockComment(): void {
    const s = this.src
    const start = this.pos(this.i)
    this.i += 2
    while (this.i < s.length && !(s[this.i] === '*' && s[this.i + 1] === '/')) {
      if (s[this.i] === '\n') {
        this.line++
        this.lineStart = this.i + 1
      }
      this.i++
    }
    if (this.i >= s.length) {
      this.diags.error({ ...start, endLine: start.line, endCol: start.col + 2 }, 'Unterminated comment: missing */')
      return
    }
    this.i += 2
    this.space = true
  }

  private pos(at: number): { line: number; col: number } {
    return { line: this.line, col: at - this.lineStart + 1 }
  }

  private make(kind: TokKind, text: string, start: number, end: number, startLine = this.line, startCol = -1): Token {
    const col = startCol >= 0 ? startCol : start - this.lineStart + 1
    const t: Token = {
      kind, text, num: 0, str: '', isUnsigned: false, isLong: false, isFloat32: false, radix: 10,
      line: startLine, col, endLine: this.line, endCol: end - this.lineStart + 1,
      nl: this.nl, space: this.space,
    }
    this.nl = false
    this.space = false
    return t
  }

  private token(): void {
    const s = this.src
    const c = s[this.i]
    if (isIdentStart(c)) return this.ident()
    if (isDigit(c) || (c === '.' && isDigit(s[this.i + 1] ?? ''))) return this.number()
    if (c === '"') return this.stringLit()
    if (c === "'") return this.charLit()
    for (const p of PUNCTS) {
      if (s.startsWith(p, this.i)) {
        this.out.push(this.make('punct', p, this.i, this.i + p.length))
        this.i += p.length
        return
      }
    }
    if (SINGLE.includes(c)) {
      this.out.push(this.make('punct', c, this.i, this.i + 1))
      this.i++
      return
    }
    this.stray(c)
  }

  private stray(c: string): void {
    const p = this.pos(this.i)
    const span = { ...p, endLine: p.line, endCol: p.col + 1 }
    if (SMART_QUOTES.test(c)) {
      this.diags.error(span, `Stray '${c}' in program: this is a "smart quote" (from a word processor or web page). Use a plain ' or " instead`)
    } else {
      const shown = c.charCodeAt(0) < 32 ? `\\x${c.charCodeAt(0).toString(16)}` : c
      this.diags.error(span, `Stray '${shown}' in program`)
    }
    this.i++
  }

  private ident(): void {
    const s = this.src
    const start = this.i
    while (this.i < s.length && isIdentPart(s[this.i])) this.i++
    this.out.push(this.make('ident', s.slice(start, this.i), start, this.i))
  }

  private number(): void {
    const s = this.src
    const start = this.i
    let radix = 10
    let isFloat = false
    if (s[this.i] === '0' && (s[this.i + 1] === 'x' || s[this.i + 1] === 'X')) {
      radix = 16
      this.i += 2
      while (isHex(s[this.i] ?? '')) this.i++
    } else if (s[this.i] === '0' && (s[this.i + 1] === 'b' || s[this.i + 1] === 'B')) {
      radix = 2
      this.i += 2
      while (isDigit(s[this.i] ?? '')) this.i++
    } else {
      while (isDigit(s[this.i] ?? '')) this.i++
      if (s[this.i] === '.') {
        isFloat = true
        this.i++
        while (isDigit(s[this.i] ?? '')) this.i++
      }
      if ((s[this.i] === 'e' || s[this.i] === 'E') && /[0-9+-]/.test(s[this.i + 1] ?? '')) {
        isFloat = true
        this.i += 2
        while (isDigit(s[this.i] ?? '')) this.i++
      }
      if (!isFloat && s[start] === '0' && this.i - start > 1) radix = 8
    }
    const body = s.slice(start, this.i)
    const sufStart = this.i
    while (this.i < s.length && isIdentPart(s[this.i])) this.i++
    const suffix = s.slice(sufStart, this.i)
    const t = this.make(isFloat ? 'float' : 'int', s.slice(start, this.i), start, this.i)
    if (isFloat) this.floatValue(t, body, suffix)
    else this.intValue(t, body, suffix, radix)
    this.out.push(t)
  }

  private floatValue(t: Token, body: string, suffix: string): void {
    const v = Number(body)
    if (suffix === 'f' || suffix === 'F') {
      t.isFloat32 = true
      t.num = Math.fround(v)
    } else {
      if (suffix !== '' && suffix !== 'l' && suffix !== 'L') this.diags.error(t, `Invalid suffix '${suffix}' on floating constant`)
      t.num = v
    }
  }

  private intValue(t: Token, body: string, suffix: string, radix: number): void {
    t.radix = radix
    const lower = suffix.toLowerCase()
    if (!/^(u?l{0,2}|l{1,2}u)$/.test(lower)) {
      this.diags.error(t, `Invalid suffix '${suffix}' on integer constant`)
    }
    t.isUnsigned = lower.includes('u')
    t.isLong = lower.includes('l')
    const digits = radix === 16 || radix === 2 ? body.slice(2) : body
    if (digits === '') {
      this.diags.error(t, `Missing digits in ${radix === 16 ? 'hexadecimal' : 'binary'} constant`)
      return
    }
    const bad = radix === 2 ? /[^01]/ : radix === 8 ? /[^0-7]/ : null
    if (bad && bad.test(digits)) {
      this.diags.error(t, `Invalid digit in ${radix === 2 ? 'binary' : 'octal'} constant '${body}'`)
      return
    }
    const v = parseInt(digits, radix)
    if (v > 0xffffffff) {
      this.diags.error(t, `Integer constant '${body}' is too large: the simulator supports at most 32-bit integers`)
      t.num = v % 0x100000000
      return
    }
    t.num = v
  }

  /** Decodes one escape after a backslash at this.i; returns the char code. */
  private escape(): number {
    const s = this.src
    const c = s[this.i + 1] ?? ''
    if (c === 'x') {
      let j = this.i + 2
      while (isHex(s[j] ?? '')) j++
      const v = parseInt(s.slice(this.i + 2, j), 16)
      this.i = j
      return Number.isNaN(v) ? 0 : v & 0xff
    }
    if (c >= '0' && c <= '7') {
      let j = this.i + 1
      while (j < this.i + 4 && s[j] >= '0' && s[j] <= '7') j++
      const v = parseInt(s.slice(this.i + 1, j), 8)
      this.i = j
      return v & 0xff
    }
    this.i += 2
    const code = ESCAPES[c]
    if (code === undefined) {
      const p = this.pos(this.i - 2)
      this.diags.warning({ ...p, endLine: p.line, endCol: p.col + 2 }, `Unknown escape sequence '\\${c}'`)
      return c.charCodeAt(0) || 0
    }
    return code
  }

  /** Reads quoted body until `q`; returns codes or null when unterminated. */
  private quoted(q: string): number[] | null {
    const s = this.src
    const codes: number[] = []
    this.i++
    while (this.i < s.length && s[this.i] !== q) {
      if (s[this.i] === '\n') return null
      if (s[this.i] === '\\') {
        if (this.spliceAt(this.i)) continue
        codes.push(this.escape())
        continue
      }
      codes.push(s.charCodeAt(this.i))
      this.i++
    }
    if (this.i >= s.length) return null
    this.i++
    return codes
  }

  private stringLit(): void {
    const start = this.i
    const line = this.line
    const col = start - this.lineStart + 1
    const codes = this.quoted('"')
    if (codes === null) {
      this.diags.error({ line, col, endLine: line, endCol: col + 1 }, 'Missing terminating " character')
      const t = this.make('string', '""', start, this.i, line, col)
      this.out.push(t)
      return
    }
    const t = this.make('string', this.src.slice(start, this.i), start, this.i, line, col)
    // no spread: a very long literal would exceed the engine's argument limit
    t.str = codes.map((c) => String.fromCharCode(c)).join('')
    this.out.push(t)
  }

  private charLit(): void {
    const start = this.i
    const line = this.line
    const col = start - this.lineStart + 1
    const codes = this.quoted("'")
    const t = this.make('char', this.src.slice(start, this.i), start, this.i, line, col)
    if (codes === null) {
      this.diags.error({ line, col, endLine: line, endCol: col + 1 }, "Missing terminating ' character")
    } else if (codes.length === 0) {
      this.diags.error(t, 'Empty character constant')
    } else if (codes.length > 1) {
      this.diags.warning(t, 'Multi-character character constant')
      t.num = codes.slice(-4).reduce((acc, c) => ((acc << 8) | (c & 0xff)) | 0, 0)
      t.kind = 'int'
    } else {
      t.num = codes[0] > 127 ? codes[0] - 256 : codes[0]
    }
    this.out.push(t)
  }
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9'
}

function isHex(c: string): boolean {
  return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c)
}

/** Lexes a single token from text (used by the preprocessor for ## pasting). */
export function lexOne(text: string): Token | null {
  const bag = new DiagBag()
  const toks = lex(text, bag)
  return toks.length === 2 && !bag.hasErrors ? toks[0] : null
}
