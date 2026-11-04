import { describe, expect, it } from 'vitest'
import { compile } from '../index'
import { compileOk, errorsOf, OPTS, printed, warningsOf } from './harness'

const wrap = (body: string, globals = ''): string => `${globals}\nvoid setup() {\n${body}\n}\nvoid loop() {}`

describe('math builtins', () => {
  it('computes trig, powers, logs and rounding in double precision', () => {
    const body = 'Serial.println(sqrt(2), 6); Serial.println(pow(2, 10)); Serial.println(sin(HALF_PI)); Serial.println(cos(PI)); Serial.println(tan(0)); Serial.println(degrees(atan2(1, 1))); Serial.println(asin(1) * 2, 4); Serial.println(acos(1)); Serial.println(atan(1) * 4, 4);'
    expect(printed(body)).toBe('1.414214\n1024.00\n1.00\n-1.00\n0.00\n45.00\n3.1416\n0.00\n3.1416\n')
  })

  it('implements exp/log/floor/ceil/fabs/fmod/hypot/trunc/fmin/fmax/cbrt', () => {
    const body = 'Serial.println(exp(1), 4); Serial.println(log(M_E)); Serial.println(log10(1000)); Serial.println(floor(-1.5)); Serial.println(ceil(-1.5)); Serial.println(fabs(-2.25)); Serial.println(fmod(-7.5, 2)); Serial.println(hypot(3, 4)); Serial.println(trunc(-2.7)); Serial.println(fmin(1, 2)); Serial.println(fmax(1, 2)); Serial.println(cbrt(27));'
    expect(printed(body)).toBe('2.7183\n1.00\n3.00\n-2.00\n-1.00\n2.25\n-1.50\n5.00\n-2.00\n1.00\n2.00\n3.00\n')
  })

  it('detects NaN and infinity', () => {
    expect(printed('float z = 0; Serial.print(isnan(sqrt(-1))); Serial.print(isinf(1 / z)); Serial.print(isnan(1.0));')).toBe('110')
  })

  it('converts radians and degrees', () => {
    expect(printed('Serial.println(radians(180), 5); Serial.println(degrees(PI));')).toBe('3.14159\n180.00\n')
  })

  it('classifies characters and changes case', () => {
    const body = "Serial.print(isDigit('7')); Serial.print(isAlpha('x')); Serial.print(isAlphaNumeric('_')); Serial.print(isSpace('\\t')); Serial.print(isWhitespace('\\n')); Serial.print(isUpperCase('Q')); Serial.print(isLowerCase('Q')); Serial.print(isPunct('!')); Serial.print(isHexadecimalDigit('f')); Serial.print(isPrintable('~')); Serial.print(isControl('\\n')); Serial.print(isAscii(200)); Serial.print(isGraph(' ')); Serial.print((char)toUpperCase('a')); Serial.print((char)tolower('B')); Serial.print(isdigit('3'));"
    expect(printed(body)).toBe('1101010111100Ab1')
  })

  it('reports wrong builtin argument counts and non-numeric arguments', () => {
    expect(errorsOf(wrap('delay();'))[0]).toMatch(/delay\(\) takes 1 argument/)
    expect(errorsOf(wrap('random(1, 2, 3);'))[0]).toMatch(/random\(\) takes 1 or 2 arguments/)
    expect(errorsOf(wrap('sqrt("4");'))[0]).toMatch(/sqrt\(\) needs a number/)
    expect(errorsOf(wrap('int m = min(1);'))[0]).toMatch(/min\(\) takes 2 arguments/)
  })

  it('evaluates macro arguments twice, exactly like the Arduino.h macros', () => {
    expect(printed('int i = 1; int m = max(i++, 0); Serial.print(m); Serial.print(i);')).toBe('23')
  })

  it('suggests builtins for misspelt names', () => {
    expect(errorsOf(wrap('unsigned long t = milis();'))[0]).toMatch(/Did you mean 'millis'\?/)
  })
})

describe('more String methods', () => {
  it('searches from an index and removes to the end', () => {
    const body = 'String s = "a-b-c"; Serial.print(s.lastIndexOf(\'-\', 2)); Serial.print(s.indexOf(\'-\', 9)); s.remove(3); Serial.print(s); Serial.print(s.isEmpty()); String e = ""; Serial.print(e.isEmpty()); Serial.print(s.startsWith("b", 2)); Serial.print(s.reserve(10));'
    expect(printed(body)).toBe('1-1a-b0111')
  })

  it('replaces characters and handles substring with swapped bounds', () => {
    expect(printed("String s = \"a.b.c\"; s.replace('.', '/'); Serial.print(s); Serial.print(s.substring(3, 1));")).toBe('a/b/c/b')
  })

  it('getBytes / toCharArray from an offset into a byte buffer', () => {
    expect(printed('String s = "hello"; byte b[4]; s.getBytes(b, 4, 1); Serial.print(b[0]); Serial.print(b[2]); Serial.print(b[3]);')).toBe('1011080')
  })

  it('formats float concatenation, chars and unsigned values', () => {
    expect(printed("String s = String('x') + String(250u) + String(-2.5f) + String((byte)200); Serial.print(s);")).toBe('x250-2.50200')
  })

  it('rejects unknown and wrongly-called String methods', () => {
    expect(errorsOf(wrap('String s; s.size();'))[0]).toMatch(/'String' has no method named 'size'/)
    expect(errorsOf(wrap('String s; s.substring();'))[0]).toMatch(/takes 1 to 2 arguments/)
    expect(errorsOf(wrap('String s; s.charAt(1.5);'))[0]).toMatch(/Expected an integer/)
    expect(errorsOf(wrap('String s; char c[2]; s.toCharArray(5, 2);'))[0]).toMatch(/Expected a char array/)
    expect(errorsOf(wrap('const char* p = "x"; p.length();'))[0]).toMatch(/has no methods\. Wrap it in a String/)
    expect(errorsOf(wrap('int a[3]; a.length();'))[0]).toMatch(/sizeof\(arr\) \/ sizeof\(arr\[0\]\)/)
  })

  it('rejects modifying a const String', () => {
    expect(errorsOf(wrap('s.toUpperCase();', 'const String s = "x";'))[0]).toMatch(/const/)
  })
})

describe('initializers and conversions', () => {
  it('accepts direct, brace and empty-brace initialisation of scalars', () => {
    expect(printed('int a(5); int b{6}; int c = {7}; int d{}; float e(1.5); Serial.print(a + b + c + d); Serial.print(e);')).toBe('181.50')
  })

  it('initialises struct arrays partially and with string fields', () => {
    const g = 'struct Item { const char* name; int qty; String note; };\nItem items[3] = {{"bolt", 4}, {"nut"}};'
    expect(printed('Serial.print(items[0].name); Serial.print(items[1].qty); Serial.print(items[2].note.length()); Serial.print(items[1].name);', undefined, g)).toBe('bolt00nut')
  })

  it('initialises char arrays inside structs and 2D char arrays', () => {
    const g = 'struct Tag { char id[4]; int n; };\nTag t = {"ab", 3};\nchar names[2][5] = {"one", "two"};'
    expect(printed('Serial.print(t.id); Serial.print(t.n); Serial.print(names[1]);', undefined, g)).toBe('ab3two')
  })

  it('reports bad initialisers', () => {
    expect(errorsOf(wrap('int a[3] = 5;'))[0]).toMatch(/must be initialised with a brace list/)
    expect(errorsOf(wrap('int a[];'))[0]).toMatch(/needs a size or an initializer list/)
    expect(errorsOf(wrap('int x = {1, 2};'))[0]).toMatch(/Too many values in braces/)
    expect(errorsOf(wrap('int a[2](1);'))[0]).toMatch(/cannot be initialised with \( \.\.\. \)/)
    expect(errorsOf(wrap('int x(1, 2);'))[0]).toMatch(/exactly one initial value/)
    expect(errorsOf(wrap('void v;'))[0]).toMatch(/cannot have type 'void'/)
  })

  it('warns about the most vexing parse for native objects', () => {
    expect(warningsOf(wrap('', 'Servo s();')).join()).toMatch(/declares a function/)
  })

  it('reports conversions between unrelated types', () => {
    const g = 'struct A { int x; };\nstruct B { int x; };\nServo sv;'
    expect(errorsOf(wrap('A a; B b = a;', g))[0]).toMatch(/Cannot convert 'struct A' as 'struct B'/)
    expect(errorsOf(wrap('int n = sv;', g))[0]).toMatch(/Cannot use a 'Servo' object as 'int'/)
    expect(errorsOf(wrap('int n = Serial;', g))[0]).toMatch(/built-in object/)
    expect(errorsOf(wrap('A a; if (a) {}', g))[0]).toMatch(/Cannot use 'struct A' as a condition/)
    expect(errorsOf(wrap('String s = "a"; const char* p = s;', g))[0]).toMatch(/c_str\(\)/)
    expect(errorsOf(wrap('int x = (int)"5";', g))[0]).toMatch(/Cannot cast/)
  })

  it('allows conditions on Strings, pointers and native objects', () => {
    compileOk(wrap('String s = "a"; const char* p = "b"; if (s && p && sv) Serial.print(1);', 'Servo sv;'))
  })

  it('passes 2D arrays only with matching inner dimensions', () => {
    const g = 'int sum(int m[][3]) { return m[0][0]; }'
    expect(errorsOf(wrap('int a[2][4]; sum(a);', g))[0]).toMatch(/cannot convert 'int\[2\]\[4\]' to 'int\[\]\[3\]'/)
    compileOk(wrap('int a[5][3]; sum(a);', g))
  })

  it('compiles void casts and conditional String results', () => {
    expect(printed('int unused = 3; (void)unused; bool hot = true; String s = hot ? "hot" : String("cold"); Serial.print(s);')).toBe('hot')
  })

  it('reports struct and enum redefinitions and bad typedefs', () => {
    expect(errorsOf('struct P { int x; };\nstruct P { int y; };\nvoid setup() {}\nvoid loop() {}')[0]).toMatch(/Redefinition of 'struct P'/)
    expect(errorsOf('enum E { A };\nenum E { B };\nvoid setup() {}\nvoid loop() {}')[0]).toMatch(/Redefinition of enum 'E'/)
    expect(errorsOf('struct S { int a; int a; };\nvoid setup() {}\nvoid loop() {}')[0]).toMatch(/Duplicate field 'a'/)
    expect(compile('typedef unsigned char u8;\nu8 v = 300;\nvoid setup() { Serial.print(v); }\nvoid loop() {}', OPTS).ok).toBe(true)
  })

  it('reports duplicate definitions and mismatched prototypes', () => {
    expect(errorsOf('void f() {}\nvoid f() {}\nvoid setup() {}\nvoid loop() {}')[0]).toMatch(/Redefinition of 'f'/)
    expect(errorsOf('int f();\nlong f() { return 1; }\nvoid setup() {}\nvoid loop() {}')[0]).toMatch(/declared returning 'int'/)
    expect(errorsOf('void f(int a = 1, int b) {}\nvoid setup() {}\nvoid loop() {}')[0]).toMatch(/needs a default value/)
  })
})
