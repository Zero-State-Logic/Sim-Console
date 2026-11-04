/* ============================================================
   ARDUINO C++ SUBSET COMPILER — public entry.
   compile(): lexer → preprocessor → parser → semantic analysis
   → bytecode. createVM(): the stack VM that runs it.

   Language notes for users (also shown in the API reference):
   - int is 16-bit when intBits = 16 (AVR boards), 32-bit otherwise;
     long is always 32-bit; double is 32-bit on AVR, 64-bit elsewhere.
   - Array indexes and integer division by zero are checked: the
     program stops with an error at that line instead of corrupting
     memory as a real board would.
   - Convenience: `let x = 5;`, `var y = 2.5;` and `const z = 3;`
     declare variables whose type is inferred from the initializer
     (5 → int, 2.5 → double, "text" → String). C++ `auto` works too.
   - Pointers are not supported except `const char*` for text; use
     arrays and reference parameters (void f(int &x)) instead.

   Running notes for the host (the sandbox worker):
   - run(budget, nowMs) executes until the budget is spent, delay()
     sleeps past nowMs, maxLoopsPerRun loop() passes complete, or
     yield() is called. millis() counts from the first run() after
     reset(); keep nowMs monotonic (reset() the VM when restarting time).
   - A delay() whose wake time is not after nowMs returns at once with
     the clock at exactly the wake time, so a delay-paced sketch keeps
     its real timing even when run() is only called once per frame.
     Raise maxLoopsPerRun (e.g. 1000) to let fast loops catch up too.
   ============================================================ */

import type { CompileOptions, CompileResult, Diagnostic, Program, VM, VMHost, VMOptions } from './api'
import type { BytecodeProgram } from './bytecode'
import { generate } from './codegen'
import { DiagBag } from './diagnostics'
import { lex } from './lexer'
import { parse } from './parser'
import { preprocess } from './preprocessor'
import { analyze } from './sema'
import { BytecodeVM } from './vm/vm'

export * from './api'

/** Functions and macros the compiler provides itself (for editor completion and the API reference). */
export { BUILTIN_NAMES as BUILTIN_FUNCTIONS } from './sema/macros'

export function compile(source: string, opts: CompileOptions): CompileResult {
  const diags = new DiagBag()
  try {
    const tokens = preprocess(lex(source, diags), { knownIncludes: opts.knownIncludes }, diags)
    const unit = parse(tokens, opts.classes.map((c) => c.name), diags)
    if (diags.hasErrors) return { ok: false, diagnostics: diags.sorted(), program: null }
    const typed = analyze(unit, opts, diags)
    if (diags.hasErrors) return { ok: false, diagnostics: diags.sorted(), program: null }
    const program: Program = generate(typed)
    return { ok: true, diagnostics: diags.sorted(), program }
  } catch (e) {
    // a compiler bug must never take down the editor: report it as a diagnostic
    const message = e instanceof RangeError
      ? 'The program is too complex to compile: expressions or blocks are nested too deeply'
      : `Internal compiler error: ${e instanceof Error ? e.message : String(e)}`
    const d: Diagnostic = { severity: 'error', message, line: 1, col: 1 }
    return { ok: false, diagnostics: [...diags.sorted(), d], program: null }
  }
}

export function createVM(program: Program, host: VMHost, opts?: VMOptions): VM {
  return new BytecodeVM(program as BytecodeProgram, host, opts)
}
