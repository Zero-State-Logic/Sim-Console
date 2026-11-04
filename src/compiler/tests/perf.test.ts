import { describe, expect, it } from 'vitest'
import { createVM } from '../index'
import { compileOk, RecordingHost } from './harness'

/**
 * V8 block coverage slows every loop several times over, so the wall-clock limits
 * only hold for a normal test run. Vitest exposes its resolved config on the worker
 * global (internal, hence the defensive access); npm run coverage also sets the env.
 */
function coverageOn(): boolean {
  const worker = (globalThis as { __vitest_worker__?: { config?: { coverage?: { enabled?: boolean } } } }).__vitest_worker__
  return worker?.config?.coverage?.enabled === true || process.env.npm_lifecycle_event === 'coverage'
}

const SLOWDOWN = coverageOn() ? 5 : 1

describe('VM performance', () => {
  it('runs a 1e6-iteration loop in well under 2 s (≥ 5M instructions/s)', () => {
    // Arrange
    const src = 'unsigned long sum = 0;\nvoid setup() {\n  for (long i = 0; i < 1000000; i++) {\n    sum += i & 7;\n  }\n}'
    const vm = createVM(compileOk(src).program!, new RecordingHost())
    // Act
    const t0 = performance.now()
    const r = vm.run(1e9, 0)
    const seconds = (performance.now() - t0) / 1000
    // Assert
    expect(r.status).toBe('halted')
    expect(vm.getGlobals().sum).toBe(3500000)
    expect(seconds).toBeLessThan(2 * SLOWDOWN)
    expect(r.executed / seconds).toBeGreaterThan(5e6 / SLOWDOWN)
  })

  it('compiles a few hundred lines quickly', () => {
    const fns = Array.from({ length: 150 }, (_, i) => `int f${i}(int x) { int y = x * ${i}; if (y > 10) { y -= 3; } return y % 7; }`).join('\n')
    const t0 = performance.now()
    compileOk(`${fns}\nvoid setup() { int s = 0; s += f1(2) + f149(3); }\nvoid loop() {}`)
    expect(performance.now() - t0).toBeLessThan(1500 * SLOWDOWN)
  })
})
