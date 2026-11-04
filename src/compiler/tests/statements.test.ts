import { describe, expect, it } from 'vitest'
import { printed, runSketch } from './harness'

describe('control flow', () => {
  it('runs if / else if / else chains', () => {
    const body = 'for (int i = 0; i < 4; i++) { if (i == 0) Serial.print("a"); else if (i == 1) Serial.print("b"); else { Serial.print("c"); } }'
    expect(printed(body)).toBe('abcc')
  })

  it('runs while, do/while (at least once) and for with a comma step', () => {
    expect(printed('int n = 3; while (n > 0) { Serial.print(n); n--; }')).toBe('321')
    expect(printed('int n = 10; do { Serial.print(n); n++; } while (n < 3);')).toBe('10')
    expect(printed('for (int i = 0, j = 5; i < j; i++, j--) { Serial.print(i); Serial.print(j); }')).toBe('051423')
  })

  it('supports break and continue, including in nested loops', () => {
    const body = 'for (int i = 0; i < 4; i++) { for (int j = 0; j < 4; j++) { if (j == 2) break; if (j == 0) continue; Serial.print(i); Serial.print(j); } }'
    expect(printed(body)).toBe('01112131')
    expect(printed('int i = 0; while (true) { i++; if (i % 2) continue; if (i > 6) break; Serial.print(i); }')).toBe('246')
  })

  it('continues a for loop through its step expression', () => {
    expect(printed('for (int i = 0; i < 5; i++) { if (i == 2) continue; Serial.print(i); }')).toBe('0134')
  })

  it('falls through switch cases until break, with default anywhere', () => {
    const fn = 'void show(int k) { switch (k) { case 1: Serial.print("one "); case 2: Serial.print("two "); break; default: Serial.print("other "); case 9: Serial.print("nine "); } }'
    expect(printed('show(1); show(2); show(5); show(9);', undefined, fn)).toBe('one two two other nine nine ')
  })

  it('switches on chars and enum members', () => {
    const g = 'enum Mode { IDLE, WALK, RUN };'
    const body = "char c = 'w'; switch (c) { case 'w': Serial.print(1); break; case 'r': Serial.print(2); break; } Mode m = RUN; switch (m) { case IDLE: break; case RUN: Serial.print(3); break; }"
    expect(printed(body, undefined, g)).toBe('13')
  })

  it('breaks out of a switch inside a loop without leaving the loop, and continue skips to the loop', () => {
    const body = 'for (int i = 0; i < 3; i++) { switch (i) { case 1: continue; default: break; } Serial.print(i); }'
    expect(printed(body)).toBe('02')
  })

  it('returns early from functions and nested loops', () => {
    const g = 'int find(int target) { for (int i = 0; i < 10; i++) { for (int j = 0; j < 10; j++) { if (i * 10 + j == target) return i; } } return -1; }'
    expect(printed('Serial.print(find(42)); Serial.print(find(500));', undefined, g)).toBe('4-1')
  })

  it('evaluates ternaries, short-circuit logic and comma expressions', () => {
    const g = 'int calls = 0; bool touch() { calls++; return true; }'
    const body = 'int x = 5; Serial.print(x > 3 ? "big" : "small"); bool r = false && touch(); r = true || touch(); Serial.print(calls); int y = (x++, x * 2); Serial.print(y);'
    expect(printed(body, undefined, g)).toBe('big012')
  })

  it('runs recursion (fib) and mutual recursion', () => {
    const g = 'long fib(int n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }\nbool isOdd(int n);\nbool isEven(int n) { return n == 0 ? true : isOdd(n - 1); }\nbool isOdd(int n) { return n == 0 ? false : isEven(n - 1); }'
    expect(printed('Serial.print(fib(20)); Serial.print(isEven(10)); Serial.print(isOdd(7));', undefined, g)).toBe('676511')
  })

  it('iterates arrays with range-for, by value and by reference', () => {
    const body = 'int a[] = {1, 2, 3}; int sum = 0; for (int v : a) sum += v; for (int &v : a) v *= 10; for (auto v : a) Serial.print(v); Serial.print(sum);'
    expect(printed(body)).toBe('1020306')
  })

  it('keeps static locals across calls and loop() iterations', () => {
    const src = 'int tick() { static int n = 0; n++; return n; }\nvoid setup() {}\nvoid loop() { static int calls = 10; calls++; Serial.print(tick()); Serial.print(calls); Serial.print(" "); }'
    expect(runSketch(src, 3).out).toBe('111 212 313 ')
  })

  it('zero-initialises locals declared inside a loop on every pass', () => {
    expect(printed('for (int i = 0; i < 3; i++) { int acc; acc += i; Serial.print(acc); }')).toBe('012')
  })

  it('increments and assigns as expressions (pre/post, compound)', () => {
    const body = 'int i = 5; int a = i++; int b = ++i; int c = (i += 3); int arr[2] = {7, 8}; int d = arr[1]--; Serial.print(a); Serial.print(b); Serial.print(c); Serial.print(d); Serial.print(arr[1]);'
    expect(printed(body)).toBe('571087')
  })

  it('applies every compound operator', () => {
    const body = 'int x = 100; x -= 10; x *= 2; x /= 3; x %= 7; x <<= 3; x >>= 1; x |= 1; x &= 0xF; x ^= 3; Serial.print(x);'
    // 90, 180, 60, 4, 32, 16, 17, 1, then 1 ^ 3 = 2
    expect(printed(body)).toBe('2')
  })
})
