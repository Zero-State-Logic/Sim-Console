import { describe, expect, it } from 'vitest'
import type { Expr, FuncDecl, VarDecl } from '../ast'
import { DiagBag } from '../diagnostics'
import { lex } from '../lexer'
import { parse } from '../parser'
import { preprocess } from '../preprocessor'
import { compile } from '../index'
import { OPTS } from './harness'

function ast(src: string): { items: ReturnType<typeof parse>['items']; bag: DiagBag } {
  const bag = new DiagBag()
  const toks = preprocess(lex(src, bag), { knownIncludes: [] }, bag)
  return { items: parse(toks, ['Servo'], bag).items, bag }
}

function exprOf(src: string): Expr {
  const fn = ast(`void f() { ${src}; }`).items[0] as FuncDecl
  const s = fn.body?.body[0]
  if (!s || s.kind !== 'expr') throw new Error('not an expression statement')
  return s.expr
}

function show(e: Expr): string {
  switch (e.kind) {
    case 'binary': return `(${show(e.left)} ${e.op} ${show(e.right)})`
    case 'assign': return `(${show(e.target)} ${e.op} ${show(e.value)})`
    case 'unary': return `(${e.op}${show(e.expr)})`
    case 'postfix': return `(${show(e.expr)}${e.op})`
    case 'ternary': return `(${show(e.cond)} ? ${show(e.a)} : ${show(e.b)})`
    case 'ident': return e.name
    case 'int': return String(e.value)
    case 'call': return `${show(e.callee)}(${e.args.map(show).join(', ')})`
    case 'index': return `${show(e.obj)}[${show(e.index)}]`
    case 'member': return `${show(e.obj)}.${e.name}`
    case 'cast': return `(${e.type.name})${show(e.expr)}`
    case 'comma': return `(${show(e.left)}, ${show(e.right)})`
    default: return e.kind
  }
}

function firstError(src: string): { line: number; col: number; message: string } {
  const d = compile(src, OPTS).diagnostics.find((x) => x.severity === 'error')
  if (!d) throw new Error('expected an error')
  return { line: d.line, col: d.col, message: d.message }
}

describe('parser: precedence and associativity', () => {
  it('binds * tighter than + and + tighter than <<', () => {
    expect(show(exprOf('a + b * c << 1'))).toBe('((a + (b * c)) << 1)')
  })

  it('orders comparison, bitwise and logical operators like C', () => {
    expect(show(exprOf('a < b == c & d ^ e | f && g || h'))).toBe('(((((((a < b) == c) & d) ^ e) | f) && g) || h)')
  })

  it('makes assignment and ?: right-associative', () => {
    expect(show(exprOf('a = b = c'))).toBe('(a = (b = c))')
    expect(show(exprOf('x = a ? b : c ? d : e'))).toBe('(x = (a ? b : (c ? d : e)))')
  })

  it('parses unary, postfix, casts, calls, members and indexing', () => {
    expect(show(exprOf('-a[i]++'))).toBe('(-(a[i]++))')
    expect(show(exprOf('(int)x + int(y)'))).toBe('((int)x + (int)y)')
    expect(show(exprOf('s.write(map(v, 0, 1023, 0, 180))'))).toBe('s.write(map(v, 0, 1023, 0, 180))')
    expect(show(exprOf('m[1][2] += !k'))).toBe('(m[1][2] += (!k))')
  })

  it('parses the comma operator', () => {
    expect(show(exprOf('i++, j--'))).toBe('((i++), (j--))')
  })
})

describe('parser: declarations', () => {
  it('parses globals with several declarators, arrays and initializers', () => {
    const v = ast('const int pins[] = {2, 3}, n = 2, grid[2][3];').items[0] as VarDecl
    expect(v.decls.map((d) => d.name)).toEqual(['pins', 'n', 'grid'])
    expect(v.decls[2].dims).toHaveLength(2)
    expect(v.spec.isConst).toBe(true)
  })

  it('normalises multi-word builtin types', () => {
    const v = ast('unsigned long a; unsigned b; long int c; signed char d; short int e;').items as VarDecl[]
    expect(v.map((x) => x.spec.name)).toEqual(['unsigned long', 'unsigned int', 'long', 'signed char', 'short'])
  })

  it('tells functions, prototypes and native constructors apart', () => {
    const items = ast('int f(int a, float b = 1.5);\nServo s(9);\nServo t;\nvoid setup() {}').items
    expect(items.map((i) => i.kind)).toEqual(['func', 'var', 'var', 'func'])
    const proto = items[0] as FuncDecl
    expect(proto.body).toBeNull()
    expect(proto.params[1].defaultValue?.kind).toBe('float')
    expect((items[1] as VarDecl).decls[0].ctorArgs).toHaveLength(1)
  })

  it('parses reference and array parameters', () => {
    const f = ast('void f(int &x, const int a[], int m[][3]) {}').items[0] as FuncDecl
    expect(f.params.map((p) => [p.name, p.isRef, p.dims.length])).toEqual([['x', true, 0], ['a', false, 1], ['m', false, 2]])
  })

  it('parses struct, enum and typedef declarations', () => {
    const items = ast('struct P { int x, y; float w = 1; };\nenum Mode { IDLE, WALK = 5, RUN };\ntypedef struct { int a; } Q;\nQ q;').items
    expect(items.map((i) => i.kind)).toEqual(['struct', 'enum', 'typedef', 'var'])
  })

  it('accepts JS-flavoured let / var / const declarations', () => {
    const v = ast('let a = 1; var b = 2.5; const c = 3;').items as VarDecl[]
    expect(v.every((x) => x.spec.inferred)).toBe(true)
  })

  it('parses range-for and switch labels', () => {
    const fn = ast('void f() { int a[3]; for (int x : a) {} switch (1) { case 1: break; default: break; } }').items[0] as FuncDecl
    expect(fn.body?.body.map((s) => s.kind)).toEqual(['var', 'forRange', 'switch'])
  })
})

describe('parser: errors and positions', () => {
  it('points a missing semicolon at the end of the previous token', () => {
    const e = firstError('void setup() {\n  int a = 1\n  a = 2;\n}\nvoid loop() {}')
    expect(e).toEqual({ line: 2, col: 12, message: "Expected ';' after the declaration at the end of this line" })
  })

  it('reports a missing closing parenthesis', () => {
    const e = firstError('void setup() {\n  if (x > 1 {\n  }\n}')
    expect(e.line).toBe(2)
    expect(e.message).toMatch(/Expected '\)' to close the if condition/)
  })

  it('collects several errors in one pass', () => {
    const r = compile('void setup() {\n  int a = ;\n  float b = 2 +;\n  a = 3\n}\nvoid loop() {}', OPTS)
    const lines = r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.line)
    expect(lines).toEqual([2, 3, 4])
  })

  it('explains statements written outside a function', () => {
    expect(firstError('pinMode(13, OUTPUT);').message).toMatch(/outside any function/)
  })

  it('explains unknown types and unsupported keywords', () => {
    expect(firstError('Foo bar;').message).toMatch(/Unknown type 'Foo'/)
    expect(firstError('class A {};').message).toMatch(/classes are not supported/)
    expect(firstError('void f() { int *p = new int; }').message).toMatch(/Pointers|new/)
    expect(firstError('void f() { goto end; }').message).toMatch(/goto/)
  })

  it('rejects member functions inside structs', () => {
    expect(firstError('struct P { int x; void move(); };').message).toMatch(/Member functions are not supported/)
  })

  it('reports an unclosed block at its opening brace', () => {
    const e = firstError('void setup() {\n  int a = 1;\n')
    expect(e.line).toBe(1)
    expect(e.message).toMatch(/Missing '\}'/)
  })
})
