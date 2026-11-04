/* ============================================================
   PREPROCESSOR — runs on the token stream.
   #define (object-like and function-like, # and ##), #undef,
   #include (known headers silently, unknown with a warning),
   #if / #ifdef / #ifndef / #elif / #else / #endif, #error,
   #warning; #pragma and #line are ignored.
   Expanded tokens carry the position of the macro use, so
   diagnostics point at the line the user wrote.
   ============================================================ */

import { DiagBag, spanOf, type Span } from './diagnostics'
import { lexOne, type Token } from './lexer'
import { table } from './tables'

interface Macro {
  name: string
  /** null for object-like macros. */
  params: string[] | null
  variadic: boolean
  body: Token[]
}

interface Cond {
  /** This branch is being emitted. */
  active: boolean
  /** Some branch of this #if chain was already taken. */
  taken: boolean
  /** The enclosing context is active. */
  parent: boolean
  sawElse: boolean
  at: Span
}

export interface PreprocessOptions {
  knownIncludes: readonly string[]
  /** Extra predefined object-like macros (name → numeric value). */
  predefined?: Record<string, number>
}

/** Depth guard against runaway self-referential expansions. */
const MAX_EXPANSION_DEPTH = 200

export function preprocess(tokens: Token[], opts: PreprocessOptions, diags: DiagBag): Token[] {
  return new Preprocessor(tokens, opts, diags).run()
}

class Preprocessor {
  private readonly macros = new Map<string, Macro>()
  private readonly conds: Cond[] = []
  private readonly out: Token[] = []
  private readonly known: Set<string>
  private i = 0

  constructor(private readonly toks: Token[], opts: PreprocessOptions, private readonly diags: DiagBag) {
    this.known = new Set(opts.knownIncludes.map((h) => h.toLowerCase()))
    const pre = { ARDUINO: 10819, __cplusplus: 201103, ...(opts.predefined ?? {}) }
    for (const [name, v] of Object.entries(pre)) {
      this.macros.set(name, { name, params: null, variadic: false, body: [numToken(v, toks[0])] })
    }
  }

  private get active(): boolean {
    return this.conds.length === 0 || this.conds[this.conds.length - 1].active
  }

  run(): Token[] {
    const n = this.toks.length
    while (this.i < n) {
      const t = this.toks[this.i]
      if (t.kind === 'eof') break
      if (t.kind === 'punct' && t.text === '#' && t.nl) {
        this.directive()
        continue
      }
      this.i++
      if (!this.active) continue
      this.emit(t)
    }
    for (const c of this.conds) this.diags.error(c.at, 'Unterminated #if: missing #endif')
    this.out.push(this.toks[n - 1])
    return this.out
  }

  /** Emits one source token, expanding it when it names a macro. */
  private emit(t: Token): void {
    if (t.kind !== 'ident' || !this.macros.has(t.text)) {
      this.out.push(t)
      return
    }
    const expanded = this.expandFrom(t, () => this.peekSource(), () => this.takeSource(), 0)
    for (const e of expanded) this.out.push(e)
  }

  private peekSource(): Token | null {
    const t = this.toks[this.i]
    if (!t || t.kind === 'eof' || (t.kind === 'punct' && t.text === '#' && t.nl)) return null
    return t
  }

  private takeSource(): Token | null {
    const t = this.peekSource()
    if (t) this.i++
    return t
  }

  /** Reads the rest of the directive line (tokens up to the next line start). */
  private lineTokens(): Token[] {
    const res: Token[] = []
    while (this.i < this.toks.length) {
      const t = this.toks[this.i]
      if (t.kind === 'eof' || t.nl) break
      res.push(t)
      this.i++
    }
    return res
  }

  private directive(): void {
    const hash = this.toks[this.i++]
    const line = this.lineTokens()
    const name = line[0]
    if (!name) return
    const rest = line.slice(1)
    const kw = name.text
    if (kw === 'if' || kw === 'ifdef' || kw === 'ifndef') return this.openIf(kw, name, rest)
    if (kw === 'elif' || kw === 'else' || kw === 'endif') return this.branch(kw, name, rest)
    if (!this.active) return
    switch (kw) {
      case 'define': return this.define(name, rest)
      case 'undef':
        if (rest[0]) this.macros.delete(rest[0].text)
        return
      case 'include': return this.include(name, rest)
      case 'error': return this.diags.error(spanOf(hash, line[line.length - 1]), `#error ${spell(rest)}`)
      case 'warning': return this.diags.warning(spanOf(hash, line[line.length - 1]), `#warning ${spell(rest)}`)
      case 'pragma':
      case 'line':
        return
      default:
        this.diags.error(spanOf(hash, name), `Invalid preprocessing directive #${kw}`)
    }
  }

  private openIf(kw: string, name: Token, rest: Token[]): void {
    const parent = this.active
    let value = false
    if (parent) {
      if (kw === 'if') value = this.evalCondition(name, rest)
      else {
        const id = rest[0]
        if (!id || id.kind !== 'ident') this.diags.error(name, `#${kw} needs a macro name`)
        const defined = !!id && this.macros.has(id.text)
        value = kw === 'ifdef' ? defined : !defined
      }
    }
    this.conds.push({ active: parent && value, taken: value, parent, sawElse: false, at: name })
  }

  private branch(kw: string, name: Token, rest: Token[]): void {
    const c = this.conds[this.conds.length - 1]
    if (!c) {
      this.diags.error(name, `#${kw} without #if`)
      return
    }
    if (kw === 'endif') {
      this.conds.pop()
      return
    }
    if (c.sawElse) {
      this.diags.error(name, `#${kw} after #else`)
      return
    }
    if (kw === 'else') {
      c.sawElse = true
      c.active = c.parent && !c.taken
      c.taken = true
      return
    }
    const value = c.parent && !c.taken ? this.evalCondition(name, rest) : false
    c.active = c.parent && !c.taken && value
    c.taken = c.taken || value
  }

  private define(name: Token, rest: Token[]): void {
    const id = rest[0]
    if (!id || id.kind !== 'ident') {
      this.diags.error(name, 'Macro names must be identifiers')
      return
    }
    let params: string[] | null = null
    let variadic = false
    let bodyStart = 1
    const open = rest[1]
    if (open && open.text === '(' && !open.space) {
      params = []
      let j = 2
      while (j < rest.length && rest[j].text !== ')') {
        const p = rest[j]
        if (p.text === '...') variadic = true
        else if (p.kind === 'ident') params.push(p.text)
        else if (p.text !== ',') this.diags.error(p, `Unexpected '${p.text}' in macro parameter list`)
        j++
      }
      if (j >= rest.length) this.diags.error(open, "Missing ')' in macro parameter list")
      bodyStart = j + 1
    }
    this.macros.set(id.text, { name: id.text, params, variadic, body: rest.slice(bodyStart) })
  }

  private include(name: Token, rest: Token[]): void {
    let header = ''
    if (rest[0]?.kind === 'string') header = rest[0].str
    else if (rest[0]?.text === '<') {
      const close = rest.findIndex((t) => t.text === '>')
      header = rest.slice(1, close < 0 ? rest.length : close).map((t) => t.text).join('')
    }
    if (!header) {
      this.diags.error(name, '#include expects "FILENAME" or <FILENAME>')
      return
    }
    const base = header.split('/').pop() ?? header
    if (this.known.has(header.toLowerCase()) || this.known.has(base.toLowerCase())) return
    const at = spanOf(rest[0], rest[rest.length - 1])
    this.diags.warning(at, `Library '${header}' is not available in the simulator: it is skipped, and calls into it will be reported as undeclared`)
  }

  /* ---------------- macro expansion ---------------- */

  /**
   * Expands macro token `t`. `peek`/`take` read the tokens that follow it (from the
   * source or from an argument list), so a function-like macro can collect its args.
   */
  private expandFrom(t: Token, peek: () => Token | null, take: () => Token | null, depth: number): Token[] {
    const m = this.macros.get(t.text)
    if (!m || t.hide?.includes(m.name) || depth > MAX_EXPANSION_DEPTH) return [t]
    let args: Token[][] | null = null
    if (m.params) {
      const next = peek()
      if (!next || next.text !== '(') return [t]
      take()
      args = this.collectArgs(t, take)
      if (!args) return [t]
      const want = m.params.length
      const got = args.length === 1 && args[0].length === 0 && want === 0 ? 0 : args.length
      if (got < want || (got > want && !m.variadic)) {
        this.diags.error(t, `Macro '${m.name}' expects ${want} argument${want === 1 ? '' : 's'}, got ${got}`)
        return []
      }
    }
    const hide = [...(t.hide ?? []), m.name]
    const replaced = this.substitute(m, args, t, depth)
    const placed = replaced.map((r, k) => ({ ...r, line: t.line, col: t.col, endLine: t.endLine, endCol: t.endCol, nl: false, space: k === 0 ? t.space : r.space, hide: [...(r.hide ?? []), ...hide] }))
    return this.rescan(placed, depth + 1)
  }

  /** Rescans an expansion for further macros (function-like ones may take args from inside it only). */
  private rescan(list: Token[], depth: number): Token[] {
    const res: Token[] = []
    let k = 0
    const peek = (): Token | null => list[k] ?? null
    const take = (): Token | null => list[k++] ?? null
    while (k < list.length) {
      const t = list[k++]
      if (t.kind === 'ident' && this.macros.has(t.text)) res.push(...this.expandFrom(t, peek, take, depth))
      else res.push(t)
    }
    return res
  }

  private collectArgs(at: Token, take: () => Token | null): Token[][] | null {
    const args: Token[][] = [[]]
    let level = 0
    for (;;) {
      const t = take()
      if (!t) {
        this.diags.error(at, `Unterminated argument list for macro '${at.text}'`)
        return null
      }
      if (t.text === '(' || t.text === '[' || t.text === '{') level++
      else if (t.text === ')' || t.text === ']' || t.text === '}') {
        if (level === 0 && t.text === ')') return args
        level--
      } else if (t.text === ',' && level === 0) {
        args.push([])
        continue
      }
      args[args.length - 1].push(t)
    }
  }

  private substitute(m: Macro, args: Token[][] | null, at: Token, depth: number): Token[] {
    const body = m.body
    if (!args || !m.params) return body.slice()
    const params = m.params
    const argOf = (name: string): Token[] | null => {
      if (name === '__VA_ARGS__' && m.variadic) return joinVariadic(args.slice(params.length))
      const idx = params.indexOf(name)
      return idx >= 0 ? args[idx] : null
    }
    const res: Token[] = []
    for (let k = 0; k < body.length; k++) {
      const b = body[k]
      if (b.text === '#' && body[k + 1]?.kind === 'ident') {
        const a = argOf(body[k + 1].text)
        if (a) {
          res.push(stringize(a, at))
          k++
          continue
        }
      }
      if (b.text === '##' && res.length > 0 && body[k + 1]) {
        const right = body[k + 1].kind === 'ident' ? argOf(body[k + 1].text) ?? [body[k + 1]] : [body[k + 1]]
        const left = res.pop() as Token
        res.push(...this.paste(left, right, at))
        k++
        continue
      }
      const a = b.kind === 'ident' ? argOf(b.text) : null
      const pastedNext = body[k + 1]?.text === '##'
      if (a) res.push(...(pastedNext ? a : this.rescan(a, depth + 1)))
      else res.push(b)
    }
    return res
  }

  private paste(left: Token, right: Token[], at: Token): Token[] {
    if (right.length === 0) return [left]
    const text = left.text + right[0].text
    const t = lexOne(text)
    if (!t) {
      this.diags.error(at, `Pasting '${left.text}' and '${right[0].text}' does not give a valid token`)
      return [left, ...right]
    }
    return [{ ...t, space: left.space }, ...right.slice(1)]
  }

  /* ---------------- #if expressions ---------------- */

  private evalCondition(at: Token, rest: Token[]): boolean {
    // resolve defined(X) / defined X before macro expansion
    const pre: Token[] = []
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k]
      if (t.kind === 'ident' && t.text === 'defined') {
        const paren = rest[k + 1]?.text === '('
        const id = rest[k + (paren ? 2 : 1)]
        if (!id || id.kind !== 'ident') {
          this.diags.error(t, "Operator 'defined' requires an identifier")
          return false
        }
        pre.push(numToken(this.macros.has(id.text) ? 1 : 0, t))
        k += paren ? 3 : 1
        continue
      }
      pre.push(t)
    }
    const expanded = this.rescan(pre, 0)
    if (expanded.length === 0) {
      this.diags.error(at, '#if with no expression')
      return false
    }
    const ev = new CondEval(expanded)
    const v = ev.parse(0)
    if (ev.error || ev.k < expanded.length) {
      this.diags.error(spanOf(expanded[0], expanded[expanded.length - 1]), `Cannot evaluate #if expression '${spell(rest)}'`)
      return false
    }
    return v !== 0
  }
}

const BIN_PREC: Readonly<Record<string, number>> = table({
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7,
  '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
})

/** Integer evaluator for #if lines. Unknown identifiers are 0, as in C. */
class CondEval {
  k = 0
  error = false

  constructor(private readonly t: Token[]) {}

  parse(minPrec: number): number {
    let left = this.unary()
    for (;;) {
      const op = this.t[this.k]?.text ?? ''
      if (op === '?' && minPrec === 0) {
        this.k++
        const a = this.parse(0)
        if (this.t[this.k]?.text !== ':') {
          this.error = true
          return 0
        }
        this.k++
        const b = this.parse(0)
        left = left !== 0 ? a : b
        continue
      }
      const prec = BIN_PREC[op]
      if (prec === undefined || prec < minPrec) return left
      this.k++
      const right = this.parse(prec + 1)
      left = binop(op, left, right)
    }
  }

  private unary(): number {
    const t = this.t[this.k++]
    if (!t) {
      this.error = true
      return 0
    }
    if (t.text === '!') return this.unary() === 0 ? 1 : 0
    if (t.text === '-') return -this.unary()
    if (t.text === '+') return this.unary()
    if (t.text === '~') return ~this.unary()
    if (t.text === '(') {
      const v = this.parse(0)
      if (this.t[this.k]?.text !== ')') this.error = true
      this.k++
      return v
    }
    if (t.kind === 'int' || t.kind === 'char') return t.num
    if (t.kind === 'ident') return t.text === 'true' ? 1 : 0
    this.error = true
    return 0
  }
}

function binop(op: string, a: number, b: number): number {
  switch (op) {
    case '||': return a !== 0 || b !== 0 ? 1 : 0
    case '&&': return a !== 0 && b !== 0 ? 1 : 0
    case '|': return a | b
    case '^': return a ^ b
    case '&': return a & b
    case '==': return a === b ? 1 : 0
    case '!=': return a !== b ? 1 : 0
    case '<': return a < b ? 1 : 0
    case '>': return a > b ? 1 : 0
    case '<=': return a <= b ? 1 : 0
    case '>=': return a >= b ? 1 : 0
    case '<<': return a << b
    case '>>': return a >> b
    case '+': return a + b
    case '-': return a - b
    case '*': return a * b
    case '/': return b === 0 ? 0 : Math.trunc(a / b)
    case '%': return b === 0 ? 0 : a % b
    default: return 0
  }
}

function numToken(v: number, at: Token | undefined): Token {
  const base = at ?? { line: 1, col: 1, endLine: 1, endCol: 1 }
  return {
    kind: 'int', text: String(v), num: v, str: '', isUnsigned: false, isLong: v > 32767, isFloat32: false, radix: 10,
    line: base.line, col: base.col, endLine: base.endLine, endCol: base.endCol, nl: false, space: true,
  }
}

function stringize(arg: Token[], at: Token): Token {
  const text = arg.map((t, k) => (k > 0 && t.space ? ' ' : '') + t.text).join('')
  return {
    kind: 'string', text: JSON.stringify(text), num: 0, str: text, isUnsigned: false, isLong: false, isFloat32: false, radix: 10,
    line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, nl: false, space: true,
  }
}

function joinVariadic(rest: Token[][]): Token[] {
  const res: Token[] = []
  rest.forEach((a, k) => {
    if (k > 0 && a[0]) res.push({ ...a[0], kind: 'punct', text: ',', space: false })
    res.push(...a)
  })
  return res
}

function spell(toks: Token[]): string {
  return toks.map((t, k) => (k > 0 && t.space ? ' ' : '') + t.text).join('')
}
