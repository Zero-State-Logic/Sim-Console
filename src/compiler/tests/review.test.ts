/* ============================================================
   REVIEW REGRESSIONS — behaviour pinned by the independent review:
   identifiers that collide with Object.prototype names, AVR's
   32-bit double, const char* indexing, declared-only setup()/loop(),
   array size cap, diagnostics overflow, and adversarial C semantics.
   ============================================================ */

import { describe, expect, it } from 'vitest'
import { compile, createVM } from '../index'
import { AVR, OPTS, RecordingHost, compileOk, errorsOf, printed, runSketch } from './harness'

const esp = (body: string, globals = ''): string => printed(body, OPTS, globals)
const avr = (body: string, globals = ''): string => printed(body, AVR, globals)
const sketch = (body: string): string => `void setup() {\n${body}\n}\nvoid loop() {}\n`

describe('identifiers named like Object.prototype members', () => {
  it('reports toString(), valueOf and hasOwnProperty as undeclared instead of resolving them to JS internals', () => {
    // Arrange
    const calls = ['toString(1);', 'constructor(1, 2);', 'int x = valueOf; Serial.println(x);', 'Serial.println(hasOwnProperty);']
    // Act
    const errors = calls.map((c) => errorsOf(sketch(c)))
    // Assert
    expect(errors[0]).toEqual(["'toString' was not declared in this scope."])
    expect(errors[1]).toEqual(["'constructor' was not declared in this scope."])
    expect(errors[2][0]).toMatch(/'valueOf' was not declared/)
    expect(errors[3][0]).toMatch(/'hasOwnProperty' was not declared/)
  })

  it('rejects String methods that only exist on JS strings, without an internal compiler error', () => {
    expect(errorsOf(sketch('String s = "a"; s.toString();'))).toEqual(["'String' has no method named 'toString'."])
    expect(errorsOf(sketch('String s = "a"; int n = s.constructor(); Serial.println(n);'))).toEqual(["'String' has no method named 'constructor'."])
  })

  it('does not treat an identifier as a #if operator', () => {
    expect(errorsOf('#if 1 constructor 2\n#endif\n' + sketch(''))[0]).toMatch(/Cannot evaluate #if expression/)
  })

  it('still allows such names for user variables, and exports them as own properties', () => {
    // Arrange
    const src = 'struct S { int __proto__; int b; };\nS g;\nint constructor = 3;\nint __proto__[2] = {1, 2};\n' + sketch('g.__proto__ = 5; int toString = 1; toString++; Serial.println(toString);')
    // Act
    const { vm, out } = runSketch(src)
    const globals = vm.getGlobals()
    // Assert
    expect(out).toBe('2\n')
    expect(Object.getPrototypeOf(globals)).toBe(Object.prototype)
    expect(Object.keys(globals)).toEqual(['g', 'constructor', '__proto__'])
    expect(JSON.stringify(globals)).toBe('{"g":{"__proto__":5,"b":0},"constructor":3,"__proto__":[1,2]}')
  })

  it('keeps every compiled program structured-clonable (no functions in the constant pool)', () => {
    const r = compileOk(sketch('double d = PI; Serial.println(d); Serial.println(sqrt(2.0));'))
    expect(() => structuredClone(r.program)).not.toThrow()
  })
})

describe('double is a 32-bit float on AVR', () => {
  it('rounds math builtin results, math constants and host doubles to float precision', () => {
    // Arrange
    const src = 'double fromHost;\n' + sketch('setJoint(0, sqrt(2.0)); double d = PI; setJoint(1, d); fromHost = readLoad(0) + 0.0; double e = getD(); setJoint(2, e);')
    const opts = { ...AVR, functions: [...AVR.functions, { name: 'getD', params: [], returns: 'double' as const }] }
    const r = compileOk(src, opts)
    const host = new RecordingHost()
    host.answers.readLoad = () => 0.1
    host.answers.getD = () => Math.SQRT1_2
    // Act
    createVM(r.program!, host).run(10000, 0)
    // Assert
    const sent = host.callsTo('setJoint').map((c) => c.args[1])
    expect(sent).toEqual([Math.fround(Math.SQRT2), Math.fround(Math.PI), Math.fround(Math.SQRT1_2)])
  })

  it('keeps 64-bit doubles on 32-bit boards', () => {
    // the harness prints a double with toFixed(digits), so 10 digits show the stored precision
    const body = 'double d = PI; Serial.println(d, 10); Serial.println(sqrt(2.0), 10);'
    expect(esp(body)).toBe('3.1415926536\n1.4142135624\n')
    expect(avr(body)).toBe('3.1415927410\n1.4142135382\n')
  })

  it('parses String.toDouble() at full precision only where double is 64-bit', () => {
    const body = 'String s = "0.1"; double d = s.toDouble(); Serial.println(d == 0.1); Serial.println(d == 0.1f);'
    expect(esp(body)).toBe('1\n0\n')
    expect(avr(body)).toBe('1\n1\n')
  })
})

describe('const char* text', () => {
  it('reads characters by index, with 0 at the terminator', () => {
    expect(esp('const char* msg = "hi"; for (int i = 0; msg[i] != 0; i++) Serial.print(msg[i]); Serial.println((int)msg[2]);')).toBe('hi0\n')
    expect(esp('const char* names[] = {"ab", "cd"}; Serial.println(names[1][0]); Serial.println(names[0]);')).toBe('c\nab\n')
  })

  it('reports writes into a const char* as read-only', () => {
    expect(errorsOf(sketch('char* msg = "hi"; msg[0] = \'H\';'))[0]).toMatch(/'msg' \(a 'const char\*'\) are read-only/)
    expect(errorsOf(sketch('char* msg = "hi"; msg[0]++;'))[0]).toMatch(/read-only/)
    expect(errorsOf(sketch('const char* msg = "hi"; msg[0] = \'H\';'))[0]).toMatch(/const/)
  })
})

describe('program structure checks', () => {
  it('reports setup() or loop() declared without a body at compile time', () => {
    // Arrange + Act
    const r = compile('void setup();\nvoid loop() {}\n', OPTS)
    // Assert
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0]).toMatchObject({ severity: 'error', line: 1, col: 6 })
    expect(r.diagnostics[0].message).toMatch(/setup\(\) is declared but never defined/)
    expect(errorsOf('void setup() {}\nvoid loop();\n')[0]).toMatch(/loop\(\) is declared but never defined/)
  })

  it('caps array sizes so a typo cannot exhaust the worker', () => {
    expect(errorsOf('int big[100000000];\n' + sketch(''))[0]).toMatch(/Array is too large \(100000000 values\)/)
    expect(errorsOf('int grid[2000][1000];\n' + sketch(''))[0]).toMatch(/too large/)
    expect(errorsOf('struct P { int x; int y; };\nP pts[600000];\n' + sketch(''))[0]).toMatch(/1200000 values/)
    expect(compile('byte buf[100000];\n' + sketch('buf[99999] = 1;'), OPTS).ok).toBe(true)
  })

  it('still shows an error when more than 100 warnings come first', () => {
    // Arrange: 120 unused locals, then one undeclared name
    const unused = Array.from({ length: 120 }, (_, i) => `int u${i};`).join(' ')
    // Act
    const r = compile(sketch(`${unused} nope = 1;`), OPTS)
    // Assert
    expect(r.ok).toBe(false)
    expect(r.diagnostics.length).toBeLessThanOrEqual(100)
    expect(r.diagnostics.some((d) => d.severity === 'error' && d.message.includes("'nope' was not declared"))).toBe(true)
  })

  it('reports absurd nesting as a diagnostic instead of throwing', () => {
    const deep = `${'('.repeat(20000)}1${')'.repeat(20000)}`
    const r = compile(sketch(`int x = ${deep}; Serial.println(x);`), OPTS)
    expect(r.ok).toBe(false)
    expect(r.diagnostics.at(-1)?.message).toMatch(/nested too deeply/)
  })

  it('stops a runaway String with a runtime error at its line instead of exhausting memory', () => {
    // Arrange
    const r = compileOk('String s = "ab";\nvoid setup() {\n  while (true) {\n    s += s;\n  }\n}\nvoid loop() {}')
    // Act
    const res = createVM(r.program!, new RecordingHost()).run(1e6, 0)
    // Assert
    expect(res.status).toBe('error')
    expect(res.error?.line).toBe(4)
    expect(res.error?.message).toMatch(/String is too long/)
    const rep = compileOk(sketch('String t = "x"; for (int i = 0; i < 30; i++) t.replace("x", "xx");'))
    expect(createVM(rep.program!, new RecordingHost()).run(1e7, 0).error?.message).toMatch(/String is too long/)
  })

  it('lexes a very long string literal', () => {
    const text = 'x'.repeat(300000)
    expect(esp(`String s = "${text}"; Serial.println(s.length());`)).toBe('300000\n')
  })
})

describe('Arduino library details', () => {
  it('expands bitToggle like Arduino.h', () => {
    expect(esp('int x = 5; bitToggle(x, 0); bitToggle(x, 3); Serial.println(x);')).toBe('12\n')
  })

  it('gives -1 from lastIndexOf(char, from) when from is past the end, but clamps the String overload', () => {
    expect(esp('String s = "abcabc"; Serial.println(s.lastIndexOf(\'a\', 10)); Serial.println(s.lastIndexOf("a", 10)); Serial.println(s.lastIndexOf(\'a\'));')).toBe('-1\n3\n3\n')
  })

  it('truncates map() toward zero for negative quotients (long division, not floor)', () => {
    // (-1 - 0) * (2 - 0) / (3 - 0) = -2 / 3 → 0 in C; floor would give -1
    expect(esp('Serial.println(map(-1, 0, 3, 0, 2)); Serial.println(map(512, 0, 1023, 0, 255));')).toBe('0\n127\n')
  })
})

describe('adversarial C semantics', () => {
  it('follows the usual arithmetic conversions with unsigned operands', () => {
    expect(esp('Serial.println(-1 / 2u); Serial.println(-1 % 10u); unsigned int u = 3; int s = -1; Serial.println(s < u); Serial.println(true ? s : u);')).toBe('2147483647\n5\n0\n4294967295\n')
    expect(avr('unsigned int u = 40000; Serial.println(u > -1); Serial.println(-1 % 10u); long l = -1; Serial.println(l < u);')).toBe('0\n5\n1\n')
  })

  it('wraps every narrow type on compound assignment and ++', () => {
    expect(avr('byte b = 200; b = b * 2; char c = 200; int8_t s8 = 127; s8++; uint16_t w = 0; w--; int x = -32768; x = -x; Serial.println(b); Serial.println((int)c); Serial.println(s8); Serial.println(w); Serial.println(x);')).toBe('144\n-56\n-128\n65535\n-32768\n')
    expect(esp('long big = 100000; big *= big; unsigned long ul = 4000000000UL; Serial.println(big); Serial.println(ul + ul); int i = 7; i /= 2.0; Serial.println(i);')).toBe('1410065408\n3705032704\n3\n')
  })

  it('reproduces the classic AVR int overflow in 200 * 200 even when assigned to long', () => {
    expect(avr('long y = 200 * 200; long z = 200L * 200; Serial.println(y); Serial.println(z);')).toBe('-25536\n40000\n')
  })

  it('reports runtime faults at the operator, index or call column', () => {
    const at = (src: string): string => {
      const r = compileOk(src)
      const res = createVM(r.program!, new RecordingHost()).run(1e6, 0)
      return `${res.status} ${res.error?.line}:${res.error?.col} ${res.error?.message}`
    }
    expect(at('void setup() {\n  int a = 0;\n  int b = 5;\n  b %= a;\n}\nvoid loop() {}')).toBe('error 4:5 Integer remainder (%) by zero')
    expect(at('int m[2][3];\nvoid setup() {\n  int j = 3;\n  m[0][j]++;\n}\nvoid loop() {}')).toBe("error 4:8 Index 3 is out of bounds for 'm[]' (size 3, valid 0..2)")
    expect(at('int f(int n) {\n  return f(n + 1) + 1;\n}\nvoid setup() { f(0); }\nvoid loop() {}')).toMatch(/^error 2:10 Stack overflow/)
  })

  it('resumes at the exact fractional wake time after delayMicroseconds()', () => {
    // Arrange
    const r = compileOk('void setup() { delay(100); Serial.println(millis()); delayMicroseconds(1500); Serial.println(micros()); }\nvoid loop() { delay(10); Serial.println(millis()); }')
    const host = new RecordingHost()
    const vm = createVM(r.program!, host, { maxLoopsPerRun: 1000 })
    // Act
    vm.run(1e6, 0)
    const res = vm.run(1e6, 150)
    // Assert: 100 + 1.5 + 10k ms; the next wake is 151.5
    expect(host.serial).toBe('100\n101500\n111\n121\n131\n141\n')
    expect(res).toMatchObject({ status: 'sleeping', wakeAtMs: 151.5, loopCompleted: true })
  })
})
