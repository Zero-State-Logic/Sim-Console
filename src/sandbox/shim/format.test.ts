import { describe, expect, it } from 'vitest'
import { BIN, DEC, HEX, OCT, formatPrint, formatPrintf, printFloat, printLong, printNumber } from './format'

describe('printNumber / printLong (Print.cpp)', () => {
  it('prints upper-case digits in any base', () => {
    expect(printNumber(255, HEX)).toBe('FF')
    expect(printNumber(8, OCT)).toBe('10')
    expect(printNumber(5, BIN)).toBe('101')
  })

  it('treats a base below 2 as decimal', () => {
    expect(printNumber(42, 1)).toBe('42')
  })

  it('prints negative longs signed in DEC and two\'s complement otherwise', () => {
    expect(printLong(-1, DEC)).toBe('-1')
    expect(printLong(-1, HEX)).toBe('FFFFFFFF')
    expect(printLong(-2, BIN)).toBe('11111111111111111111111111111110')
  })
})

describe('printFloat', () => {
  it('uses two digits by default and rounds half up', () => {
    expect(printFloat(3)).toBe('3.00')
    // 0.125 is exact in binary, so the half really rounds up; 1.005 is not (Arduino prints 1.00)
    expect(printFloat(0.125, 2)).toBe('0.13')
    expect(printFloat(1.005, 2)).toBe('1.00')
    expect(printFloat(2.5, 0)).toBe('3')
  })

  it('rounds in double precision like the 32-bit cores (ESP32 prints 7.25 at 1 digit as 7.2)', () => {
    // 7.25 + 0.05 is 7.2999... in binary64, so the first digit floors to 2, exactly as Print.cpp does
    expect(printFloat(7.25, 1)).toBe('7.2')
    expect(printFloat(7.26, 1)).toBe('7.3')
  })

  it('keeps the sign of small negatives like Arduino', () => {
    expect(printFloat(-0.001, 2)).toBe('-0.00')
    expect(printFloat(-12.345, 1)).toBe('-12.3')
  })

  it('prints nan, inf and ovf', () => {
    expect(printFloat(Number.NaN)).toBe('nan')
    expect(printFloat(Number.POSITIVE_INFINITY)).toBe('inf')
    expect(printFloat(5e9)).toBe('ovf')
  })
})

describe('formatPrint by static argument type', () => {
  it('prints int as an integer but float as two decimals', () => {
    expect(formatPrint(3, 'int')).toBe('3')
    expect(formatPrint(3, 'float')).toBe('3.00')
    expect(formatPrint(3, 'double', 4)).toBe('3.0000')
  })

  it('applies the base argument to integers', () => {
    expect(formatPrint(255, 'int', HEX)).toBe('FF')
    expect(formatPrint(255, 'long', BIN)).toBe('11111111')
    expect(formatPrint(4294967295, 'unsigned')).toBe('4294967295')
  })

  it('prints char as a character, bool as 1/0 and strings as is', () => {
    expect(formatPrint(65, 'char')).toBe('A')
    expect(formatPrint(65, 'char', DEC)).toBe('65')
    expect(formatPrint(true, 'bool')).toBe('1')
    expect(formatPrint('hi', 'string')).toBe('hi')
  })

  it('falls back to the runtime value for "any"', () => {
    expect(formatPrint(7, 'any')).toBe('7')
    expect(formatPrint(7.25, 'any')).toBe('7.25')
    expect(formatPrint('x', 'any')).toBe('x')
    expect(formatPrint([1, 2], 'any')).toBe('[1, 2]')
  })
})

describe('formatPrintf', () => {
  it('formats integers with width, zero pad and sign', () => {
    expect(formatPrintf('%d|%5d|%-5d|%05d|%+d', [42, 42, 42, -42, 7])).toBe('42|   42|42   |-0042|+7')
  })

  it('formats hex, octal, unsigned and chars', () => {
    expect(formatPrintf('%x %X %#x %o %u %c', [255, 255, 255, 8, -1, 65])).toBe('ff FF 0xff 10 4294967295 A')
  })

  it('formats floats in f, e and g styles', () => {
    expect(formatPrintf('%.2f %8.3f %e %g %g', [3.14159, 2.5, 12345.678, 0.0001, 123456789])).toBe('3.14    2.500 1.234568e+04 0.0001 1.23457e+08')
  })

  it('supports strings, precision, star width and percent', () => {
    expect(formatPrintf('%s|%.3s|%*d|100%%', ['hello', 'hello', 4, 7])).toBe('hello|hel|   7|100%')
  })

  it('accepts length modifiers and missing arguments', () => {
    expect(formatPrintf('%ld %lu %s', [5, 6])).toBe('5 6 (null)')
  })

  it('zero-pads floats even with a precision, but not integers with one (C rule)', () => {
    expect(formatPrintf('%08.3f|%06.2f|%05.3d|%05f', [-3.14159, 1.5, 7, Infinity])).toBe('-003.142|001.50|  007|  inf')
  })

  it('chooses the %g style from the exponent after rounding', () => {
    expect(formatPrintf('%g %g %.3g %g', [999999.5, 0.000099999996, 9.9996, 100000])).toBe('1e+06 0.0001 10 100000')
  })
})

describe('formatPrint base 0', () => {
  it('writes the byte for print(value, 0), like Print.cpp', () => {
    expect([formatPrint(65, 'unsigned', 0), formatPrint(66, 'int', 0), formatPrint(67, 'long', 0)]).toEqual(['A', 'B', 'C'])
  })
})
