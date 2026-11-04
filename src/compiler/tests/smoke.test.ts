import { describe, expect, it } from 'vitest'
import { compile } from '../index'
import { OPTS, printed, runSketch } from './harness'

describe('smoke', () => {
  it('prints hello', () => {
    expect(printed('Serial.println("hello");')).toBe('hello\n')
  })
  it('does arithmetic', () => {
    expect(printed('int a = 7; int b = 2; Serial.println(a / b); Serial.println(a % b); Serial.println(-7 / 2); Serial.println(-7 % 2);')).toBe('3\n1\n-3\n-1\n')
  })
  it('loops and functions', () => {
    const src = `int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
void setup() { for (int i = 0; i < 10; i++) { Serial.print(fib(i)); Serial.print(" "); } }
void loop() {}`
    expect(runSketch(src).out).toBe('0 1 1 2 3 5 8 13 21 34 ')
  })
  it('reports diagnostics', () => {
    const r = compile('void setup() { int servos = 1; servo = 2; }\nvoid loop() {}', OPTS)
    expect(r.diagnostics.map((d) => d.message)).toContain("'servo' was not declared in this scope. Did you mean 'servos'?")
  })
})
