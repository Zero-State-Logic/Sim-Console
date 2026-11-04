import { describe, expect, it } from 'vitest'
import { compile } from '../index'
import { compileOk, errorsOf, OPTS, warningsOf } from './harness'

const wrap = (body: string, globals = ''): string => `${globals}\nvoid setup() {\n${body}\n}\nvoid loop() {}`

describe('sema: names and scopes', () => {
  it('suggests the closest name for an undeclared identifier', () => {
    expect(errorsOf(wrap('Servo servos; servo.write(90);'))).toEqual(["'servo' was not declared in this scope. Did you mean 'servos'?"])
  })

  it('gives the 1-based position of the bad name', () => {
    const d = compile(wrap('  int count = 0;\n  cuont++;'), OPTS).diagnostics.find((x) => x.severity === 'error')
    expect([d?.line, d?.col, d?.endCol]).toEqual([4, 3, 8])
    expect(d?.message).toMatch(/Did you mean 'count'\?/)
  })

  it('explains a global used above its declaration', () => {
    const src = 'void setup() { speed = 3; }\nvoid loop() {}\nint speed = 1;'
    expect(errorsOf(src)[0]).toMatch(/declared later, on line 3/)
  })

  it('lets functions be called above their definition (Arduino prototypes)', () => {
    compileOk('void setup() { blink(3); }\nvoid loop() {}\nvoid blink(int n) { delay(n); }')
  })

  it('ends a variable scope at its block', () => {
    expect(errorsOf(wrap('{ int inner = 1; } inner = 2;'))[0]).toMatch(/'inner' was not declared/)
    expect(errorsOf(wrap('for (int i = 0; i < 3; i++) {} i = 0;'))[0]).toMatch(/'i' was not declared/)
  })

  it('rejects redeclaration in one scope but allows shadowing in an inner one', () => {
    expect(errorsOf(wrap('int a = 1; int a = 2;'))[0]).toMatch(/Redeclaration of 'a'/)
    compileOk(wrap('int a = 1; { int a = 2; a++; } a++;'))
  })

  it('explains a function used without parentheses and a type used as a value', () => {
    expect(errorsOf(wrap('int t = millis;'))[0]).toMatch(/'millis' is a function/)
    expect(errorsOf(wrap('Servo.attach(9);'))[0]).toMatch(/'Servo' is a type, not an object/)
  })
})

describe('sema: types and conversions', () => {
  it('rejects assigning to const and modifying const arrays', () => {
    expect(errorsOf(wrap('a = 2;', 'const int a = 1;'))[0]).toMatch(/declared const/)
    expect(errorsOf(wrap('t[0] = 2;', 'const int t[] = {1, 2};'))[0]).toMatch(/declared const/)
    expect(errorsOf(wrap('a++;', 'const int a = 1;'))[0]).toMatch(/declared const/)
  })

  it('requires an initializer for const', () => {
    expect(errorsOf('const int n;\nvoid setup() {}\nvoid loop() {}')[0]).toMatch(/must be given a value/)
  })

  it('keeps String number constructors explicit, as in WString.h', () => {
    expect(errorsOf(wrap('String s = 5;'))[0]).toMatch(/Write String\(value\)/)
    compileOk(wrap('String s = String(5); s += 7; s = s + 1.5;'))
  })

  it('rejects text to number conversions with a hint', () => {
    expect(errorsOf(wrap('String s = "1"; int n = s;'))[0]).toMatch(/toInt\(\)/)
  })

  it('rejects % on floats and bit operators on floats', () => {
    expect(errorsOf(wrap('float f = 5.0 % 2;'))[0]).toMatch(/fmod/)
    expect(errorsOf(wrap('float f = 1.5; int x = f << 1;'))[0]).toMatch(/needs integers/)
  })

  it('rejects whole-array assignment', () => {
    expect(errorsOf(wrap('int a[2]; int b[2]; a = b;'))[0]).toMatch(/Arrays cannot be assigned/)
  })

  it('rejects pointers except const char*', () => {
    compileOk(wrap('const char* name = "hexapod"; Serial.println(name);'))
    expect(errorsOf(wrap('int* p;'))[0]).toMatch(/Pointers are not supported/)
    expect(errorsOf(wrap('int a = 1; int b = &a;'))[0]).toMatch(/address-of/)
  })

  it('warns about pointer arithmetic on a string literal', () => {
    expect(warningsOf(wrap('Serial.println("Value: " + 5);')).join()).toMatch(/moves the pointer/)
    expect(errorsOf(wrap('Serial.println("a" + "b");'))[0]).toMatch(/Cannot add two C strings/)
  })

  it('infers types for let / var / auto', () => {
    compileOk(wrap('let a = 5; var b = 2.5; const c = "hi"; auto d = a * 2; Serial.println(c.length() + a + b + d);'))
    expect(errorsOf(wrap('let x;'))[0]).toMatch(/needs an initial value/)
  })

  it('warns when a constant expression overflows 16-bit int on AVR', () => {
    const avr = { ...OPTS, intBits: 16 as const }
    expect(warningsOf(wrap('long us = 1000 * 1000;'), avr).join()).toMatch(/Integer overflow.*wraps to 16960.*1000L/)
    expect(warningsOf(wrap('long us = 1000L * 1000;'), avr).join()).not.toMatch(/overflow/)
  })

  it('warns about constant out-of-bounds indexes and division by zero', () => {
    expect(warningsOf(wrap('int a[4]; a[4] = 1;')).join()).toMatch(/Index 4 is out of bounds/)
    expect(warningsOf(wrap('int z = 0; int q = 5 / 0;')).join()).toMatch(/Division by zero/)
  })
})

describe('sema: calls', () => {
  it('checks arity of user functions, natives and native methods', () => {
    const g = 'int add(int a, int b) { return a + b; }\nServo s;'
    expect(errorsOf(wrap('add(1);', g))[0]).toMatch(/Too few arguments to function 'int add\(int, int\)'/)
    expect(errorsOf(wrap('add(1, 2, 3);', g))[0]).toMatch(/Too many arguments/)
    expect(errorsOf(wrap('pinMode(13);', g))[0]).toMatch(/pinMode\(\) takes 2 arguments/)
    expect(errorsOf(wrap('s.write();', g))[0]).toMatch(/Servo\.write\(\) takes 1 argument/)
  })

  it('reports unknown members of objects, classes and structs', () => {
    expect(errorsOf(wrap('Serial.prinln(1);'))[0]).toBe("'Serial' has no method named 'prinln'. Did you mean 'println'?")
    expect(errorsOf(wrap('s.wirte(1);', 'Servo s;'))[0]).toBe("'Servo' has no method named 'wirte'. Did you mean 'write'?")
    expect(errorsOf(wrap('p.z = 1;', 'struct P { int x; int y; }; P p;'))[0]).toMatch(/'struct P' has no member named 'z'/)
  })

  it('supports default arguments and overloads', () => {
    compileOk(wrap('move(); move(3); move(1.5);', 'void move(int n = 1) {}\nvoid move(float f) {}'))
  })

  it('needs a variable for a reference parameter of exactly the same type', () => {
    const g = 'void bump(int &x) { x++; }'
    expect(errorsOf(wrap('bump(5);', g))[0]).toMatch(/must be a variable/)
    expect(errorsOf(wrap('long v = 1; bump(v);', g))[0]).toMatch(/exactly the same type/)
    compileOk(wrap('int v = 1; bump(v);', g))
  })

  it('rejects calling a variable and passing Serial as a value', () => {
    expect(errorsOf(wrap('int f = 1; f();'))[0]).toMatch(/not a function/)
    expect(errorsOf(wrap('Serial.println(Serial);'))[0]).toMatch(/cannot be passed as a value/)
  })

  it('reports prototypes that are called but never defined', () => {
    expect(errorsOf('void later();\nvoid setup() { later(); }\nvoid loop() {}')[0]).toMatch(/never defined/)
  })
})

describe('sema: statements', () => {
  it('rejects break and continue outside loops', () => {
    expect(errorsOf(wrap('break;'))[0]).toMatch(/'break' is only allowed/)
    expect(errorsOf(wrap('switch (1) { case 1: continue; }'))[0]).toMatch(/'continue' is only allowed inside a loop/)
  })

  it('checks return values against the function type', () => {
    expect(errorsOf('int f() { return; }\nvoid setup() {}\nvoid loop() {}')[0]).toMatch(/must return a value/)
    expect(errorsOf('void f() { return 1; }\nvoid setup() {}\nvoid loop() {}')[0]).toMatch(/is void and cannot return a value/)
  })

  it('warns when a non-void function can fall off its end', () => {
    expect(warningsOf('int f(int x) { if (x) return 1; }\nvoid setup() {}\nvoid loop() {}').join()).toMatch(/without returning a value/)
    expect(warningsOf('int f(int x) { if (x) return 1; else return 2; }\nint g() { while (true) {} }\nvoid setup() {}\nvoid loop() {}').join()).not.toMatch(/without returning/)
    const sw = "int code(char c) { switch (c) { case 'a': return 1; default: return 0; } }"
    expect(warningsOf(`${sw}\nvoid setup() {}\nvoid loop() {}`).join()).not.toMatch(/without returning/)
    const swBreak = 'int code(int c) { switch (c) { case 1: break; default: return 0; } }'
    expect(warningsOf(`${swBreak}\nvoid setup() {}\nvoid loop() {}`).join()).toMatch(/without returning/)
  })

  it('checks switch: integer value, constant and unique labels, crossing initialisation', () => {
    expect(errorsOf(wrap('float f = 1; switch (f) { }'))[0]).toMatch(/switch needs an integer/)
    expect(errorsOf(wrap('int k = 2; switch (1) { case k: break; }'))[0]).toMatch(/integer constant/)
    expect(errorsOf(wrap('switch (1) { case 1: break; case 1: break; }'))[0]).toMatch(/Duplicate case value 1/)
    expect(errorsOf(wrap('switch (1) { case 1: int x = 2; x++; break; case 2: break; }'))[0]).toMatch(/skips the initialisation of 'x'/)
    compileOk(wrap('switch (1) { case 1: { int x = 2; x++; break; } case 2: break; }'))
  })

  it('warns about unused and set-but-unused locals', () => {
    const w = warningsOf(wrap('int unused; int setOnly = 0; setOnly = 3; int used = 1; Serial.println(used);'))
    expect(w).toContain("Unused variable 'unused'")
    expect(w).toContain("Variable 'setOnly' is set but never used")
    expect(w.join()).not.toMatch(/'used'/)
  })

  it('warns about missing setup() / loop()', () => {
    expect(warningsOf('int x = 1;').join()).toMatch(/No setup\(\) or loop\(\)/)
    expect(warningsOf('void setup() {}').join()).toMatch(/No loop\(\)/)
  })

  it('compiles constant array sizes from #define, const int and sizeof', () => {
    compileOk('#define LEGS 6\nconst int J = 3;\nint angles[LEGS * J];\nint copy[sizeof(angles) / sizeof(angles[0])];\nvoid setup() {}\nvoid loop() {}')
    expect(errorsOf(wrap('int n = 3; int a[n];'))[0]).toMatch(/Array size must be a constant/)
  })

  it('warns that sizeof on an array parameter gives a pointer size', () => {
    expect(warningsOf('int len(int a[]) { return sizeof(a); }\nvoid setup() {}\nvoid loop() {}').join()).toMatch(/size of a pointer/)
  })

  it('accepts a full Arduino-style file with includes and qualifiers', () => {
    const src = `#include <Arduino.h>
#include <Servo.h>
static const uint8_t PINS[] PROGMEM = {9, 10};
volatile unsigned long ticks = 0;
Servo servos[2];
void setup() { for (byte i = 0; i < 2; i++) servos[i].attach(PINS[i]); }
void loop() { ticks++; }`
    compileOk(src)
  })

  it('warns about classic beginner bugs', () => {
    expect(warningsOf(wrap('int x = 0; if (x = 5) {}')).join()).toMatch(/did you mean the comparison '=='/)
    expect(warningsOf(wrap('for (unsigned int i = 5; i >= 0; i--) { break; }')).join()).toMatch(/always true: an unsigned value is never negative/)
    expect(warningsOf(wrap('byte b = 3; if (b < 0) {}')).join()).toMatch(/always false/)
    expect(warningsOf(wrap('int i = 1; if (i >= 0) {}')).join()).not.toMatch(/always/)
    expect(errorsOf(wrap('char c = 0; if (c == "a") {}'))[0]).toMatch(/single quotes/)
  })
})
