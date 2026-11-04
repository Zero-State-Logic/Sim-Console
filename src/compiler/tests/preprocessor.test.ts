import { describe, expect, it } from 'vitest'
import { DiagBag } from '../diagnostics'
import { lex } from '../lexer'
import { preprocess } from '../preprocessor'

function pp(src: string, known: string[] = ['Arduino.h', 'Servo.h']): { text: string; bag: DiagBag; toks: ReturnType<typeof lex> } {
  const bag = new DiagBag()
  const toks = preprocess(lex(src, bag), { knownIncludes: known }, bag).slice(0, -1)
  return { text: toks.map((t) => t.text).join(' '), bag, toks }
}

describe('preprocessor: #define', () => {
  it('expands object-like macros', () => {
    expect(pp('#define LED 13\npinMode(LED, 1);').text).toBe('pinMode ( 13 , 1 ) ;')
  })

  it('expands function-like macros with arguments', () => {
    expect(pp('#define SQ(x) ((x) * (x))\nSQ(a + 1)').text).toBe('( ( a + 1 ) * ( a + 1 ) )')
  })

  it('treats NAME (x) with a space as object-like', () => {
    expect(pp('#define F (x)\nF').text).toBe('( x )')
  })

  it('expands nested macros and stops self-recursion', () => {
    expect(pp('#define A B + 1\n#define B A\nA').text).toBe('A + 1')
    expect(pp('#define TWO 2\n#define FOUR (TWO * TWO)\nFOUR').text).toBe('( 2 * 2 )')
  })

  it('leaves a function-like macro name alone without parentheses', () => {
    expect(pp('#define M(x) x\nint M;').text).toBe('int M ;')
  })

  it('stringizes and pastes tokens', () => {
    const r = pp('#define S(x) #x\n#define CAT(a, b) a ## b\nS(hello world) CAT(serv, o1)')
    expect(r.toks[0].kind).toBe('string')
    expect(r.toks[0].str).toBe('hello world')
    expect(r.toks[1].text).toBe('servo1')
  })

  it('supports variadic macros', () => {
    expect(pp('#define LOG(...) print(__VA_ARGS__)\nLOG(a, b)').text).toBe('print ( a , b )')
  })

  it('puts expanded tokens at the position of the macro use', () => {
    const r = pp('#define LIMIT 180\n\nint x = LIMIT;')
    const t = r.toks.find((x) => x.text === '180')
    expect(t?.line).toBe(3)
    expect(t?.col).toBe(9)
  })

  it('reports wrong macro argument counts', () => {
    expect(pp('#define M(a, b) a\nM(1)').bag.items[0].message).toMatch(/expects 2 arguments, got 1/)
  })

  it('#undef removes a macro', () => {
    expect(pp('#define X 1\n#undef X\nX').text).toBe('X')
  })

  it('predefines ARDUINO', () => {
    expect(pp('ARDUINO').text).toBe('10819')
  })
})

describe('preprocessor: conditionals', () => {
  it('handles #ifdef / #ifndef / #else / #endif', () => {
    const src = '#define DEBUG\n#ifdef DEBUG\na\n#else\nb\n#endif\n#ifndef DEBUG\nc\n#endif'
    expect(pp(src).text).toBe('a')
  })

  it('handles #if 0 / #if 1 and #elif chains', () => {
    expect(pp('#if 0\na\n#elif 1\nb\n#else\nc\n#endif').text).toBe('b')
    expect(pp('#if 1\na\n#elif 1\nb\n#endif').text).toBe('a')
  })

  it('evaluates expressions with defined() and macros', () => {
    const src = '#define LEGS 6\n#if defined(LEGS) && LEGS > 4\nmany\n#endif\n#if !defined NOPE\nok\n#endif'
    expect(pp(src).text).toBe('many ok')
  })

  it('treats unknown identifiers as 0', () => {
    expect(pp('#if FOO\na\n#else\nb\n#endif').text).toBe('b')
  })

  it('nests conditionals inside inactive branches', () => {
    expect(pp('#if 0\n#if 1\na\n#endif\n#else\nb\n#endif').text).toBe('b')
  })

  it('reports unbalanced directives', () => {
    expect(pp('#if 1\na').bag.items[0].message).toMatch(/missing #endif/)
    expect(pp('#endif').bag.items[0].message).toMatch(/#endif without #if/)
    expect(pp('#if 1\n#else\n#else\n#endif').bag.items[0].message).toMatch(/after #else/)
  })
})

describe('preprocessor: other directives', () => {
  it('accepts known includes silently and warns about unknown ones', () => {
    const r = pp('#include <Servo.h>\n#include "Arduino.h"\n#include <FastLED.h>')
    expect(r.bag.items).toHaveLength(1)
    expect(r.bag.items[0].severity).toBe('warning')
    expect(r.bag.items[0].message).toMatch(/FastLED\.h/)
    expect(r.bag.items[0].line).toBe(3)
  })

  it('matches includes with a directory by base name', () => {
    expect(pp('#include <utility/Servo.h>').bag.items).toHaveLength(0)
  })

  it('ignores #pragma and reports #error / #warning', () => {
    const r = pp('#pragma once\n#warning careful\n#error stop here')
    expect(r.bag.items.map((d) => [d.severity, d.message])).toEqual([
      ['warning', '#warning careful'],
      ['error', '#error stop here'],
    ])
  })

  it('rejects unknown directives', () => {
    expect(pp('#frobnicate').bag.items[0].message).toMatch(/Invalid preprocessing directive/)
  })

  it('skips #error in an inactive branch', () => {
    expect(pp('#if 0\n#error no\n#endif').bag.items).toHaveLength(0)
  })
})
