import type { CompileResult, CompileOptions, Diagnostic, Program, VM, VMHost, VMOptions, VMRunResult } from '../../compiler/api'
import type { ArduinoShim } from '../shim/arduino'
import { scanIncludes } from '../shim/boards'
import { buildCompileOptions, createCppHost } from '../shim/cppBinding'
import { TICK_BUDGET, type WatchEntry } from '../protocol'
import { formatWatch } from './watch'
import type { ProgramRunner, TickOutcome } from './types'

/* ============================================================
   C++ DIALECT RUNNER — compile() + createVM() from src/compiler.
   Each tick is vm.run(budget, nowMs) with maxLoopsPerRun 1 (plus one
   follow-up run on the same budget after a woken delay(), see tick()):
   a runaway loop just spends its budget, it can never hang.
   ============================================================ */

/** The two compiler entry points (injected so tests can fake the VM). */
export interface CompilerFns {
  compile(source: string, opts: CompileOptions): CompileResult
  createVM(program: Program, host: VMHost, opts?: VMOptions): VM
}

export interface CppLoadResult {
  program: CppProgram | null
  diagnostics: Diagnostic[]
}

const VM_OPTIONS: VMOptions = { maxLoopsPerRun: 1, maxCallDepth: 256 }

/**
 * How far the VM clock may trail sim time when a resumed loop() is chained (see tick()).
 * About one frame: delay() periods stay exact on average, and millis() never drifts away.
 */
export const MAX_CLOCK_LAG_MS = 20

/** Notes the compiler cannot know about: headers that are accepted but not simulated. */
export function sandboxDiagnostics(source: string): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const inc of scanIncludes(source)) {
    if (inc.header === 'WiFi.h') {
      out.push({
        severity: 'warning',
        message: 'WiFi is not simulated: WiFi calls compile, but they are stubs (status() reports WL_CONNECTED).',
        line: inc.line,
        col: inc.col,
      })
    }
  }
  return out
}

/** The VM can take more work this tick (not asleep, halted or failed). */
function isRunning(r: VMRunResult): boolean {
  return r.status === 'running' || r.status === 'ready'
}

function internalError(e: unknown, what: string): Diagnostic {
  const msg = e instanceof Error ? e.message : String(e)
  return { severity: 'error', message: `Internal ${what} error: ${msg}`, line: 1, col: 1 }
}

export class CppProgram implements ProgramRunner {
  /** The last tick ended inside a loop() iteration (asleep in delay() or out of budget). */
  private midLoop = false
  /** Virtual time the sleeping VM wakes at, when midLoop came from a delay(). */
  private wakeAt: number | null = null
  /** loop() has returned at least once, so the program is past setup(). */
  private looping = false

  private constructor(private readonly vm: VM) {}

  static load(source: string, shim: ArduinoShim, intBits: 16 | 32, compiler: CompilerFns): CppLoadResult {
    const opts = buildCompileOptions(shim.api, shim.hw.board, intBits)
    let res: CompileResult
    try {
      res = compiler.compile(source, opts)
    } catch (e) {
      return { program: null, diagnostics: [internalError(e, 'compiler')] }
    }
    const diagnostics = [...res.diagnostics, ...sandboxDiagnostics(source)]
    if (!res.ok || !res.program) return { program: null, diagnostics }
    if (!res.program.hasLoop) {
      diagnostics.push({ severity: 'warning', message: 'No loop() function: the program stops after setup().', line: 1, col: 1 })
    }
    try {
      const vm = compiler.createVM(res.program, createCppHost(shim), VM_OPTIONS)
      return { program: new CppProgram(vm), diagnostics }
    } catch (e) {
      return { program: null, diagnostics: [...diagnostics, internalError(e, 'VM')] }
    }
  }

  /**
   * One frame: loop() STARTS at most once per tick (maxLoopsPerRun 1), but an iteration
   * resumed from an earlier tick (it slept in delay()) is followed by the next loop() in
   * the same tick, as on a board. Without that, `loop() { ...; delay(20); }` would idle a
   * whole frame after every wake and run at 21 Hz instead of 50 Hz.
   */
  tick(nowMs: number): TickOutcome {
    let r: VMRunResult
    let executed = 0
    let loops = 0
    try {
      r = this.vm.run(TICK_BUDGET, nowMs)
      executed = r.executed
      if (r.loopCompleted) loops++
      if (this.midLoop && this.looping && r.loopCompleted && isRunning(r) && executed < TICK_BUDGET) {
        // restart at the wake time (the VM clock never goes back), at most a frame behind
        const start = this.wakeAt === null ? nowMs : Math.min(nowMs, Math.max(this.wakeAt, nowMs - MAX_CLOCK_LAG_MS))
        r = this.vm.run(TICK_BUDGET - executed, start)
        executed += r.executed
        if (r.loopCompleted) loops++
      }
    } catch (e) {
      const error = internalError(e, 'VM')
      return { status: 'error', line: this.vm.currentLine, executed, loops, error }
    }
    if (loops > 0) this.looping = true
    this.midLoop = !(r.loopCompleted && isRunning(r))
    this.wakeAt = r.status === 'sleeping' && r.wakeAtMs !== undefined ? r.wakeAtMs : null
    const out: TickOutcome = {
      status: r.status === 'ready' ? 'running' : r.status,
      line: r.line,
      executed,
      loops,
    }
    if (r.status === 'sleeping' && r.wakeAtMs !== undefined) out.wakeAtMs = r.wakeAtMs
    if (r.status === 'error') {
      out.error = r.error ?? { severity: 'error', message: 'Runtime error', line: r.line || 1, col: 1 }
    }
    return out
  }

  reset(): void {
    this.vm.reset()
    this.midLoop = false
    this.wakeAt = null
    this.looping = false
  }

  globals(): WatchEntry[] {
    const g = this.vm.getGlobals()
    return Object.keys(g)
      .sort()
      .map((name) => ({ name, value: formatWatch(g[name]) }))
  }
}
