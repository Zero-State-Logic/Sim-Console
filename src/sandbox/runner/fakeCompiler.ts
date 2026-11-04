import type { CompileOptions, CompileResult, Program, VM, VMHost, VMOptions, VMRunResult, VMStatus } from '../../compiler/api'
import type { CompilerFns } from './cppRunner'

/*
 * Test double for src/compiler: records what the sandbox asks of the compiler and
 * the VM, and replays scripted run() results. Used by unit tests only, so they do
 * not depend on the real compiler being finished.
 */

export interface FakeCompiler extends CompilerFns {
  lastOptions: CompileOptions | null
  lastVMOptions: VMOptions | undefined
  host: VMHost | null
  runs: { budget: number; nowMs: number }[]
  resets: number
  /** Results returned by successive run() calls (the last one repeats). */
  script: Partial<VMRunResult>[]
  result: CompileResult
  globals: Record<string, number | number[]>
}

const PROGRAM: Program = { kind: 'kiyo-bytecode', version: 1, hasSetup: true, hasLoop: true }

export function fakeCompiler(patch: Partial<CompileResult> = {}): FakeCompiler {
  const fc: FakeCompiler = {
    lastOptions: null,
    lastVMOptions: undefined,
    host: null,
    runs: [],
    resets: 0,
    script: [{ status: 'running', executed: 100, loopCompleted: true, line: 5 }],
    result: { ok: true, diagnostics: [], program: PROGRAM, ...patch },
    globals: { speed: 1.25, arr: [1, 2, 3] },
    compile(_source: string, opts: CompileOptions): CompileResult {
      fc.lastOptions = opts
      return fc.result
    },
    createVM(_p: Program, host: VMHost, opts?: VMOptions): VM {
      fc.host = host
      fc.lastVMOptions = opts
      let i = 0
      let status: VMStatus = 'ready'
      return {
        run(budget: number, nowMs: number): VMRunResult {
          fc.runs.push({ budget, nowMs })
          const step = fc.script[Math.min(i++, fc.script.length - 1)]
          const r: VMRunResult = { status: 'running', executed: 0, loopCompleted: false, line: 0, ...step }
          status = r.status
          return r
        },
        get status() {
          return status
        },
        get currentLine() {
          return 0
        },
        reset() {
          fc.resets++
          i = 0
          status = 'ready'
        },
        getGlobals() {
          return fc.globals
        },
      }
    },
  }
  return fc
}
