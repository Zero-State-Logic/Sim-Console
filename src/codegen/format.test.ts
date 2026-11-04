import { describe, expect, it } from 'vitest'
import { asciiOnly, block, cFloat, cFloatList, cInt, cList, commentSafe, cString, joinSections, numText, pyFloat, pyList, pyString, roundTo, slug } from './format'

describe('number literals', () => {
  it('never writes exponent notation, NaN or Infinity', () => {
    expect(numText(1e-7)).toBe('0.0')
    expect(numText(1.5e21)).toBe('1500000000000000000000.0')
    expect(numText(Number.NaN)).toBe('0.0')
    expect(numText(Number.POSITIVE_INFINITY)).toBe('0.0')
  })

  it('trims trailing zeros but keeps one decimal', () => {
    expect(numText(90)).toBe('90.0')
    expect(numText(0.25)).toBe('0.25')
    expect(numText(-12.3456789, 3)).toBe('-12.346')
  })

  it('turns negative zero into zero', () => {
    expect(roundTo(-0.000001)).toBe(0)
    expect(Object.is(roundTo(-0.000001), -0)).toBe(false)
    expect(cFloat(-0.0000001)).toBe('0.0f')
  })

  it('formats C++ floats, ints and lists', () => {
    expect(cFloat(1.5)).toBe('1.5f')
    expect(cInt(2.6)).toBe('3')
    expect(cFloatList([1, -2.5])).toBe('{ 1.0f, -2.5f }')
    expect(cList(['a', 'b', 'c'], 2)).toBe('{\n  a, b,\n  c\n}')
    expect(cList([])).toBe('{}')
  })

  it('formats Python floats and lists', () => {
    expect(pyFloat(3)).toBe('3.0')
    expect(pyList(['1', '2'])).toBe('[1, 2]')
    expect(pyList(['1', '2', '3'], 2)).toBe('[\n    1, 2,\n    3,\n]')
  })
})

describe('string literals', () => {
  it('escapes quotes, backslashes and trigraph question marks in C++', () => {
    expect(cString('a"b\\c??')).toBe('"a\\"b\\\\c\\?\\?"')
  })

  it('drops characters outside printable ASCII', () => {
    expect(asciiOnly('KiyoéBot\n\t')).toBe('KiyoBot')
    expect(cString('Café')).toBe('"Caf"')
    expect(pyString('x"y')).toBe('"x\\"y"')
  })

  it('keeps comment text from closing the comment', () => {
    expect(commentSafe('a */ b /* c')).toBe('a * / b / * c')
  })
})

describe('layout helpers', () => {
  it('builds identifier-safe slugs', () => {
    expect(slug('Walker ESP32')).toBe('walker_esp32')
    expect(slug('8-leg')).toBe('k_8_leg')
  })

  it('joins only the non-empty sections with one blank line', () => {
    expect(joinSections(['a  ', false, '', null, 'b'])).toBe('a\n\nb\n')
    expect(block('\nx')).toBe('x')
  })
})
