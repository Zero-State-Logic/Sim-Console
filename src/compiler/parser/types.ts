/* ============================================================
   TYPE SPECIFIERS — `const unsigned long`, `uint8_t`, `String`,
   `struct P`, `Servo`, `const char*`, `auto` / `let` / `var`.
   Multi-word builtin types are normalised to one canonical name.
   ============================================================ */

import type { TypeSpec } from '../ast'
import type { Token } from '../lexer'
import { QUALIFIERS, TYPE_WORDS, TokenStream } from './stream'

/** Builtin words that can only stand alone (no signed/unsigned/long in front). */
const SOLO = new Set([
  'void', 'bool', 'boolean', 'float', 'byte', 'word', 'String', 'size_t', 'int8_t', 'uint8_t', 'int16_t',
  'uint16_t', 'int32_t', 'uint32_t', 'int64_t', 'uint64_t',
])

/** Hooks so type parsing can parse an inline struct/enum body without an import cycle. */
export interface TypeHooks {
  structBody(ts: TokenStream, start: Token, name: string, nameTok: Token): NonNullable<TypeSpec['structDef']>
  enumBody(ts: TokenStream, start: Token, name: string | null, isClass: boolean): NonNullable<TypeSpec['enumDef']>
}

/**
 * Does a type start at offset k? `named` names count only when they are not
 * immediately used as a value (`Servo(...)` is a construct expression, `E::A` a scope name).
 */
export function isTypeStart(ts: TokenStream, k = 0): boolean {
  const t = ts.peek(k)
  if (t.kind !== 'ident') return false
  if (TYPE_WORDS.has(t.text) || QUALIFIERS.has(t.text)) {
    if (t.text === 'String' && (ts.is('(', k + 1) || ts.is('.', k + 1))) return false
    return true
  }
  if (t.text === 'struct' || t.text === 'enum' || t.text === 'auto' || t.text === 'let' || t.text === 'var') return true
  if (ts.isTypeName(t.text)) {
    const n = ts.peek(k + 1)
    return !(n.text === '(' || n.text === '::' || n.text === '.' || n.text === '{')
  }
  return false
}

/** The current token begins a type inside a cast or sizeof: `(int)`, `(unsigned long)`, `(Point)`. */
export function isTypeInParens(ts: TokenStream): boolean {
  const t = ts.peek(1)
  if (t.kind !== 'ident') return false
  if (TYPE_WORDS.has(t.text) || t.text === 'const' || t.text === 'struct' || t.text === 'volatile') return true
  return ts.isTypeName(t.text) && (ts.is(')', 2) || ts.is('*', 2) || ts.is('&', 2))
}

export function parseTypeSpec(ts: TokenStream, hooks: TypeHooks, allowPointer: boolean): TypeSpec {
  const start = ts.peek()
  const spec: TypeSpec = { span: start, name: 'int', named: false, isConst: false, isStatic: false, pointer: 0, inferred: false }
  qualifiers(ts, spec)
  const t = ts.peek()
  if (t.kind !== 'ident') ts.fail(t, `Expected a type, found '${t.text || 'end of file'}'`)
  if (t.text === 'auto' || t.text === 'let' || t.text === 'var') {
    ts.next()
    spec.inferred = true
  } else if (spec.isConst && !isBaseWord(ts, t)) {
    // JS-flavoured `const x = 5;` — type inferred from the initializer
    spec.inferred = true
  } else if (t.text === 'struct') {
    structRef(ts, hooks, spec)
  } else if (t.text === 'enum') {
    enumRef(ts, hooks, spec)
  } else if (ts.isTypeName(t.text)) {
    ts.next()
    spec.name = t.text
    spec.named = true
  } else {
    spec.name = builtinName(ts)
  }
  qualifiers(ts, spec)
  if (allowPointer) {
    while (ts.accept('*')) {
      spec.pointer++
      qualifiers(ts, spec)
    }
  }
  spec.span = ts.spanFrom(start)
  return spec
}

function isBaseWord(ts: TokenStream, t: Token): boolean {
  return TYPE_WORDS.has(t.text) || t.text === 'struct' || t.text === 'enum' || ts.isTypeName(t.text)
}

function qualifiers(ts: TokenStream, spec: TypeSpec): void {
  for (;;) {
    const t = ts.peek()
    if (t.kind !== 'ident' || !QUALIFIERS.has(t.text)) return
    ts.next()
    if (t.text === 'const' || t.text === 'constexpr') spec.isConst = true
    else if (t.text === 'static') spec.isStatic = true
  }
}

function structRef(ts: TokenStream, hooks: TypeHooks, spec: TypeSpec): void {
  const kw = ts.next()
  let name = ''
  let nameTok: Token = kw
  if (ts.peek().kind === 'ident' && !ts.is('{')) {
    nameTok = ts.next()
    name = nameTok.text
  }
  if (ts.is('{')) {
    if (!name) name = `__anon_struct_${kw.line}_${kw.col}`
    spec.structDef = hooks.structBody(ts, kw, name, nameTok)
  } else if (!name) {
    ts.fail(kw, "Expected a struct name or '{' after 'struct'")
  } else if (!ts.structNames.has(name)) {
    ts.fail(nameTok, `'struct ${name}' is not defined (define it with struct ${name} { ... }; before using it)`)
  }
  spec.name = name
  spec.named = true
}

function enumRef(ts: TokenStream, hooks: TypeHooks, spec: TypeSpec): void {
  const kw = ts.next()
  const isClass = ts.accept('class') || ts.accept('struct')
  let name: string | null = null
  if (ts.peek().kind === 'ident' && !ts.is('{') && !ts.is(':')) name = ts.next().text
  if (ts.accept(':')) builtinName(ts) // underlying type, e.g. enum Mode : uint8_t
  if (ts.is('{')) spec.enumDef = hooks.enumBody(ts, kw, name, isClass)
  else if (!name) ts.fail(kw, "Expected an enum name or '{' after 'enum'")
  spec.name = name ?? 'int'
  spec.named = name !== null
}

/** Parses a run of builtin type words into one canonical name. */
function builtinName(ts: TokenStream): string {
  const first = ts.peek()
  if (SOLO.has(first.text)) {
    ts.next()
    return first.text === 'boolean' ? 'bool' : first.text
  }
  let sign: 'signed' | 'unsigned' | null = null
  let longs = 0
  let short = false
  let base: string | null = null
  for (;;) {
    const t = ts.peek()
    if (t.kind !== 'ident') break
    if (t.text === 'signed' || t.text === 'unsigned') sign = t.text
    else if (t.text === 'long') longs++
    else if (t.text === 'short') short = true
    else if ((t.text === 'int' || t.text === 'char' || t.text === 'double' || t.text === 'float') && base === null) base = t.text
    else break
    ts.next()
  }
  if (sign === null && longs === 0 && !short && base === null) ts.fail(first, `Expected a type, found '${first.text}'`)
  if (base === 'char') return sign === 'unsigned' ? 'unsigned char' : sign === 'signed' ? 'signed char' : 'char'
  if (base === 'double' || base === 'float') {
    if (sign || short || longs > 1) ts.fail(first, `Invalid type: '${sign ?? (short ? 'short' : 'long long')} ${base}'`)
    return 'double' === base || longs > 0 ? 'double' : 'float'
  }
  const u = sign === 'unsigned'
  if (short) return u ? 'unsigned short' : 'short'
  if (longs >= 2) return u ? 'unsigned long long' : 'long long'
  if (longs === 1) return u ? 'unsigned long' : 'long'
  return u ? 'unsigned int' : 'int'
}
