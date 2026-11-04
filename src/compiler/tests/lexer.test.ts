import { describe, expect, it } from 'vitest'
import { DiagBag } from '../diagnostics'
import { lex, lexOne } from '../lexer'

function toks(src: string): { kinds: string[]; texts: string[]; bag: DiagBag; all: ReturnType<typeof lex> } {
  const bag = new DiagBag()
  const all = lex(src, bag)
  const body = all.slice(0, -1)
  return { kinds: body.map((t) => t.kind), texts: body.map((t) => t.text), bag, all: body }
}

describe('lexer: tokens and positions', () => {
  it('gives 1-based line and column ranges', () => {
    // Arrange
    const src = 'int x;\n  x = 42;'
    // Act
    const { all } = toks(src)
    // Assert
    const x2 = all[3]
    expect(x2.text).toBe('x')
    expect([x2.line, x2.col, x2.endLine, x2.endCol]).toEqual([2, 3, 2, 4])
    expect(all[5].num).toBe(42)
    expect([all[5].col, all[5].endCol]).toEqual([7, 9])
  })

  it('marks the first token of each line and whitespace before tokens', () => {
    const { all } = toks('#define A(x) x\nA (1)')
    expect(all[0].nl).toBe(true)
    expect(all[1].nl).toBe(false)
    expect(all[3].space).toBe(false) // A( with no space: function-like macro
    expect(all[7].space).toBe(true)
  })

  it('skips line and block comments, including multi-line ones', () => {
    const { texts } = toks('a // comment\n/* block\n comment */ b /**/ c')
    expect(texts).toEqual(['a', 'b', 'c'])
  })

  it('reports an unterminated block comment', () => {
    const { bag } = toks('int a; /* never closed')
    expect(bag.items[0].message).toMatch(/Unterminated comment/)
  })

  it('reads longest punctuators first', () => {
    const { texts } = toks('a<<=b>>=c->d++--e<=f>=g==h!=i&&j||k::l...')
    expect(texts).toEqual(['a', '<<=', 'b', '>>=', 'c', '->', 'd', '++', '--', 'e', '<=', 'f', '>=', 'g', '==', 'h', '!=', 'i', '&&', 'j', '||', 'k', '::', 'l', '...'])
  })

  it('joins lines ending in a backslash', () => {
    const { all } = toks('#define LONG 1 + \\\n 2\nx')
    expect(all.map((t) => t.text)).toEqual(['#', 'define', 'LONG', '1', '+', '2', 'x'])
    expect(all[5].nl).toBe(false)
    expect(all[6].nl).toBe(true)
  })
})

describe('lexer: numbers', () => {
  it('parses decimal, hex, binary and octal integers', () => {
    const { all } = toks('123 0x1F 0XfF 0b1010 017 0')
    expect(all.map((t) => t.num)).toEqual([123, 31, 255, 10, 15, 0])
    expect(all.map((t) => t.radix)).toEqual([10, 16, 16, 2, 8, 10])
  })

  it('reads integer suffixes u, l, ul, lu, ull', () => {
    const { all } = toks('1u 2L 3UL 4lu 5ull')
    expect(all.map((t) => [t.isUnsigned, t.isLong])).toEqual([[true, false], [false, true], [true, true], [true, true], [true, true]])
  })

  it('parses floats with exponents and the f suffix (rounded to float32)', () => {
    const { all } = toks('1.5 .25 3. 1e3 2.5e-2 0.1f')
    expect(all.map((t) => t.kind)).toEqual(['float', 'float', 'float', 'float', 'float', 'float'])
    expect(all.slice(0, 5).map((t) => t.num)).toEqual([1.5, 0.25, 3, 1000, 0.025])
    expect(all[5].num).toBe(Math.fround(0.1))
    expect(all[5].isFloat32).toBe(true)
  })

  it('rejects bad digits and suffixes', () => {
    expect(toks('09').bag.items[0].message).toMatch(/octal/)
    expect(toks('0b102').bag.items[0].message).toMatch(/binary/)
    expect(toks('10px').bag.items[0].message).toMatch(/Invalid suffix 'px'/)
    expect(toks('0x').bag.items[0].message).toMatch(/Missing digits/)
  })

  it('rejects integers wider than 32 bits', () => {
    expect(toks('0x1FFFFFFFF').bag.items[0].message).toMatch(/too large/)
  })
})

describe('lexer: characters and strings', () => {
  it('decodes escapes in char literals', () => {
    const { all } = toks("'a' '\\n' '\\t' '\\0' '\\\\' '\\'' '\\x41' '\\101'")
    expect(all.map((t) => t.num)).toEqual([97, 10, 9, 0, 92, 39, 65, 65])
  })

  it('makes chars above 127 negative (char is signed)', () => {
    expect(toks("'\\xff'").all[0].num).toBe(-1)
  })

  it('decodes string literals', () => {
    const { all } = toks('"hi\\n\\"there\\""')
    expect(all[0].str).toBe('hi\n"there"')
  })

  it('reports unterminated strings and empty chars', () => {
    expect(toks('"abc\nx').bag.items[0].message).toMatch(/Missing terminating "/)
    expect(toks("''").bag.items[0].message).toMatch(/Empty character constant/)
  })

  it('warns on unknown escapes and multi-char constants', () => {
    const a = toks('"\\q"')
    expect(a.bag.items[0].severity).toBe('warning')
    const b = toks("'ab'")
    expect(b.bag.items[0].message).toMatch(/Multi-character/)
    expect(b.all[0].num).toBe((97 << 8) | 98)
  })

  it('explains smart quotes and stray characters', () => {
    expect(toks('Serial.println(“hi”);').bag.items[0].message).toMatch(/smart quote/)
    expect(toks('int a = 1 @ 2;').bag.items[0].message).toBe("Stray '@' in program")
  })

  it('lexOne reads exactly one token', () => {
    expect(lexOne('foo12')?.text).toBe('foo12')
    expect(lexOne('a b')).toBeNull()
  })
})
