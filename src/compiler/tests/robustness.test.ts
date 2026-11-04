import { describe, expect, it } from 'vitest'
import { nextRandom } from '../arith'
import { compile, createVM } from '../index'
import { OPTS, RecordingHost } from './harness'

const BASE = `#include <Servo.h>
#define N 4
struct P { int x; float y = 1.5; };
enum Mode { A, B = 3 };
Servo s[N];
const int pins[N] = {2, 3, 4, 5};
String msg = "hi";
P pts[2] = {{1, 2.0}, {3}};
int f(int &a, int b = 2) { a += b; return a * 2; }
float g(float v) { return v > 0 ? sqrt(v) : -v; }
void setup() {
  Serial.begin(9600);
  for (int i = 0; i < N; i++) s[i].attach(pins[i]);
  int k = 1; f(k); msg += String(k, HEX) + 'c';
  switch (k) { case 1: k++; case 3: break; default: k = 0; }
  do { k--; } while (k > 0);
  for (auto &p : pts) p.x <<= 1;
}
void loop() {
  static unsigned long t = 0;
  if (millis() - t > 20) { t = millis(); s[0].write(map(analogRead(A0), 0, 1023, 0, 180)); }
  Serial.println(g(-2.5) + msg.length());
  delay(10);
}
`

/** Deterministic token-level mutations of a valid sketch. */
function mutants(src: string, count: number): string[] {
  const parts = src.split(/(\s+|[;,(){}[\]])/).filter((p) => p !== '')
  const out: string[] = []
  let seed = 12345
  const rnd = (n: number): number => {
    seed = nextRandom(seed)
    return seed % n
  }
  for (let m = 0; m < count; m++) {
    const p = parts.slice()
    const edits = 1 + rnd(3)
    for (let e = 0; e < edits; e++) {
      const i = rnd(p.length)
      const op = rnd(3)
      if (op === 0) p.splice(i, 1)
      else if (op === 1) p.splice(i, 0, p[rnd(p.length)])
      else [p[i], p[(i + 1) % p.length]] = [p[(i + 1) % p.length], p[i]]
    }
    out.push(p.join(''))
  }
  return out
}

describe('robustness', () => {
  it('compiles and runs the base sketch', () => {
    const r = compile(BASE, OPTS)
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const vm = createVM(r.program!, new RecordingHost(), { maxLoopsPerRun: 3 })
    for (let t = 0; t < 200; t += 16) expect(vm.run(100_000, t).status).not.toBe('error')
  })

  it('never crashes the compiler on 400 mutated sketches', () => {
    for (const src of mutants(BASE, 400)) {
      const r = compile(src, OPTS)
      const internal = r.diagnostics.filter((d) => d.message.startsWith('Internal compiler error'))
      expect({ src, internal }).toEqual({ src, internal: [] })
      for (const d of r.diagnostics) {
        expect(d.line).toBeGreaterThanOrEqual(1)
        expect(d.col).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('never crashes the VM on mutants that still compile', () => {
    let ran = 0
    for (const src of mutants(BASE, 400)) {
      const r = compile(src, OPTS)
      if (!r.ok || !r.program) continue
      const vm = createVM(r.program, new RecordingHost(), { maxLoopsPerRun: 2 })
      for (let t = 0; t < 60; t += 20) {
        const res = vm.run(20_000, t)
        if (res.status === 'error') expect(res.error?.message).not.toMatch(/internal/)
      }
      ran++
    }
    expect(ran).toBeGreaterThan(10)
  })

  it('handles empty input, only comments and garbage', () => {
    for (const src of ['', '// nothing', '/* */', '}}}}', '((((', 'int', '#define', '#if', 'void setup() {', '"unterminated', "'", '\u0000\u0001']) {
      const r = compile(src, OPTS)
      expect(r.diagnostics.some((d) => d.message.startsWith('Internal compiler error'))).toBe(false)
    }
  })
})
