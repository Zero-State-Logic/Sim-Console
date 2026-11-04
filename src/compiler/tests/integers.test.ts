import { describe, expect, it } from 'vitest'
import { arith, convertNumber, floatToInt32, formatFloat, wrapInt } from '../arith'
import { commonType, promote, T } from '../ctypes'
import { AVR, OPTS, printed } from './harness'

const avr = (body: string, globals = ''): string => printed(body, AVR, globals)
const esp = (body: string, globals = ''): string => printed(body, OPTS, globals)

describe('C integer semantics on a 16-bit int board (AVR)', () => {
  it('wraps int at 32767', () => {
    expect(avr('int a = 32767; a++; Serial.println(a);')).toBe('-32768\n')
    expect(avr('int a = 30000; int b = a + a; Serial.println(b);')).toBe('-5536\n')
  })

  it('wraps unsigned int and unsigned long below zero', () => {
    expect(avr('unsigned int u = 0; u--; Serial.println(u);')).toBe('65535\n')
    expect(avr('unsigned long ul = 0; ul--; Serial.println(ul);')).toBe('4294967295\n')
  })

  it('wraps long at 2^31 and byte at 255', () => {
    expect(avr('long l = 2147483647; l++; Serial.println(l);')).toBe('-2147483648\n')
    expect(avr('byte b = 255; b++; Serial.println(b);')).toBe('0\n')
    expect(avr('char c = 127; c++; Serial.println((int)c);')).toBe('-128\n')
  })

  it('promotes byte operands to int before adding', () => {
    expect(avr('byte a = 200; byte b = 100; int s = a + b; Serial.println(s);')).toBe('300\n')
  })

  it('narrows long to int on assignment', () => {
    expect(avr('long big = 40000; int i = big; Serial.println(i);')).toBe('-25536\n')
  })

  it('compares signed and unsigned like C (int vs unsigned int → unsigned)', () => {
    expect(avr('int a = -1; unsigned int b = 1; Serial.println(a < b);')).toBe('0\n')
    // on AVR, long can hold every unsigned int value, so this compares as long
    expect(avr('long a = -1; unsigned int b = 1; Serial.println(a < b);')).toBe('1\n')
  })

  it('treats 40000 as a long literal and 0xFFFF as unsigned int', () => {
    expect(avr('Serial.println(sizeof(40000)); Serial.println(sizeof(0xFFFF)); Serial.println(0xFFFF + 1);')).toBe('4\n2\n0\n')
  })

  it('shifts with the promoted left type', () => {
    expect(avr('int x = 1 << 15; Serial.println(x);')).toBe('-32768\n')
    expect(avr('unsigned long y = 1UL << 31; Serial.println(y);')).toBe('2147483648\n')
    expect(avr('int n = -16; Serial.println(n >> 2);')).toBe('-4\n')
    expect(avr('unsigned int y = 0xFFFF; Serial.println(y >> 4);')).toBe('4095\n')
  })

  it('applies ~ in the promoted width', () => {
    expect(avr('Serial.println(~0); Serial.println(~0u);')).toBe('-1\n65535\n')
  })

  it('makes double a 32-bit float', () => {
    expect(avr('float f = 0.1; double d = 0.1; Serial.println(f == d); Serial.println(sizeof(double));')).toBe('1\n4\n')
  })

  it('uses the AVR round() macro, which returns long', () => {
    expect(avr('Serial.println(round(2.5)); Serial.println(round(-2.5)); Serial.println(sizeof(round(1.2)));')).toBe('3\n-3\n4\n')
  })
})

describe('C integer semantics on a 32-bit board', () => {
  it('wraps int at 2^31 and unsigned at 2^32', () => {
    expect(esp('int a = 2147483647; a += 1; Serial.println(a);')).toBe('-2147483648\n')
    expect(esp('unsigned int u = 0; u -= 1; Serial.println(u);')).toBe('4294967295\n')
  })

  it('multiplies 32-bit integers exactly with wraparound', () => {
    expect(esp('long a = 100000; long b = 100000; Serial.println(a * b);')).toBe('1410065408\n')
    expect(esp('unsigned long a = 4000000000UL; Serial.println(a * 2);')).toBe('3705032704\n')
  })

  it('compares long with unsigned int as unsigned long (long cannot hold all of it)', () => {
    expect(esp('long a = -1; unsigned int b = 1; Serial.println(a < b);')).toBe('0\n')
  })

  it('keeps float and double distinct', () => {
    expect(esp('float f = 0.1; double d = 0.1; Serial.println(f == d); Serial.println(sizeof(double));')).toBe('0\n8\n')
    expect(esp('float f = 16777217; Serial.println((long)f);')).toBe('16777216\n')
  })

  it('uses math.h round(), which returns double', () => {
    expect(esp('Serial.println(round(2.5)); Serial.println(round(-2.5));')).toBe('3.00\n-3.00\n')
  })
})

describe('division, modulo and conversions', () => {
  it('truncates integer division toward zero and follows C sign rules for %', () => {
    expect(esp('Serial.println(-7 / 2); Serial.println(-7 % 2); Serial.println(7 % -2); Serial.println(-7 % -2);')).toBe('-3\n-1\n1\n-1\n')
    expect(esp('int a = -7; int b = 2; Serial.println(a / b); Serial.println(a % b);')).toBe('-3\n-1\n')
  })

  it('does integer division before converting to float (the classic average bug)', () => {
    expect(esp('float avg = 7 / 2; Serial.println(avg); Serial.println(7 / 2.0);')).toBe('3.00\n3.50\n')
  })

  it('truncates float to int toward zero', () => {
    expect(esp('int a = 2.9; int b = -2.9; Serial.println(a); Serial.println(b); Serial.println((int)3.99);')).toBe('2\n-2\n3\n')
  })

  it('treats chars as small integers and bools as 0/1', () => {
    expect(esp("char c = 'A' + 2; Serial.println(c); Serial.println('a' - 'A');")).toBe('C\n32\n')
    expect(esp('bool b = 5; int n = true + true; Serial.println(b); Serial.println(n);')).toBe('1\n2\n')
  })

  it('evaluates Arduino macros with macro typing', () => {
    expect(esp('Serial.println(min(3, 7.5)); Serial.println(max(2, 9)); Serial.println(constrain(200, 0, 180)); Serial.println(abs(-5)); Serial.println(sq(-3));')).toBe('3.00\n9\n180\n5\n9\n')
  })

  it("computes map() in long arithmetic with truncation, like the board", () => {
    expect(esp('Serial.println(map(512, 0, 1023, 0, 180)); Serial.println(map(-10, 0, 10, 0, 100)); Serial.println(map(5, 0, 0, 0, 9));')).toBe('90\n-100\n-1\n')
  })

  it('implements the bit macros', () => {
    const body = 'byte r = 0; bitSet(r, 3); Serial.println(r); bitWrite(r, 0, 1); Serial.println(r); bitClear(r, 3); Serial.println(r); Serial.println(bitRead(5, 2)); Serial.println(bit(4)); Serial.println(highByte(0x1234)); Serial.println(lowByte(0x1234));'
    expect(esp(body)).toBe('8\n9\n1\n1\n16\n18\n52\n')
  })

  it('computes sizeof with target sizes and struct alignment', () => {
    const g = 'struct Mix { char c; int i; };'
    expect(avr('Serial.println(sizeof(int)); Serial.println(sizeof(Mix)); Serial.println(sizeof("abc"));', g)).toBe('2\n3\n4\n')
    expect(esp('Serial.println(sizeof(int)); Serial.println(sizeof(Mix));', g)).toBe('4\n8\n')
  })

  it('formats numbers in other bases and floats with fixed decimals', () => {
    expect(esp('Serial.println(255, HEX); Serial.println(5, BIN); Serial.println(3.14159, 3);')).toBe('FF\n101\n3.142\n')
    expect(esp('Serial.println(String(255, HEX)); Serial.println(String(-1, HEX)); Serial.println(String(1.5)); Serial.println(String(2.0 / 3, 4));')).toBe('ff\nffffffff\n1.50\n0.6667\n')
    expect(avr('Serial.println(String(-1, HEX));')).toBe('ffff\n')
  })

  it('folds constant expressions exactly like run-time arithmetic', () => {
    expect(avr('const int K = 300 * 200; int a = 300; int b = 200; Serial.println(K == a * b);')).toBe('1\n')
  })
})

describe('arith helpers (pure)', () => {
  it('wraps to every width', () => {
    expect([wrapInt(256, 8, false), wrapInt(128, 8, true), wrapInt(65536 + 5, 16, false), wrapInt(2 ** 31, 32, true), wrapInt(-1, 32, false)]).toEqual([0, -128, 5, -2147483648, 4294967295])
    expect(wrapInt(7, 1, false)).toBe(1)
  })

  it('converts float to int by truncation with saturation and NaN as 0', () => {
    expect([floatToInt32(2.7, true), floatToInt32(-2.7, true), floatToInt32(NaN, true), floatToInt32(1e20, true), floatToInt32(-5, false)]).toEqual([2, -2, 0, 2147483647, 0])
    expect(convertNumber(300.7, 'uchar', 32, true)).toBe(44)
    expect(convertNumber(0.1, 'float', 32, false)).toBe(Math.fround(0.1))
  })

  it('returns null for integer division by zero and divides floats normally', () => {
    expect(arith('/', 1, 0, T.int, 32)).toBeNull()
    expect(arith('%', 1, 0, T.int, 32)).toBeNull()
    expect(arith('/', 1, 0, T.double, 32)).toBe(Infinity)
  })

  it('implements promotion and the usual arithmetic conversions', () => {
    expect(promote(T.uchar, 16)).toBe(T.int)
    expect(promote(T.ushort, 16)).toBe(T.uint)
    expect(promote(T.ushort, 32)).toBe(T.int)
    expect(commonType(T.int, T.uint, 32)).toBe(T.uint)
    expect(commonType(T.long, T.uint, 16)).toBe(T.long)
    expect(commonType(T.long, T.uint, 32)).toBe(T.ulong)
    expect(commonType(T.int, T.float, 32)).toBe(T.float)
    expect(commonType(T.float, T.double, 32)).toBe(T.double)
  })

  it('formats floats like Arduino String()', () => {
    expect([formatFloat(1.005, 2), formatFloat(-0.001, 2), formatFloat(NaN, 2), formatFloat(-Infinity, 2), formatFloat(2.5, 0)]).toEqual(['1.00', '-0.00', 'nan', '-inf', '3'])
  })
})
