import type { Diagnostic } from '../../compiler/api'
import type { ArduinoShim } from '../shim/arduino'
import { buildJsScope } from '../shim/jsBinding'
import type { WatchEntry } from '../protocol'
import { formatWatch } from './watch'
import type { TickOutcome } from './types'

/* ============================================================
   JS DIALECT RUNNER — user JS runs through `new Function` with the
   shim names as parameters (see jsBinding.ts for the isolation
   note). setup() runs once, then loop() starts at most once per tick;
   `await delay(ms)` suspends against the VIRTUAL clock, so a
   pending delay carries across ticks exactly like the C++ VM.
   ============================================================ */

/** Delay wake-ups resolved inside one tick before it yields (stops `while (1) await delay(0)`). */
const MAX_WAKES_PER_TICK = 64
/** How far the program clock may trail sim time after a wake-up (same rule as the C++ VM runner). */
const MAX_CLOCK_LAG_MS = 20
const MAX_WATCH = 100
/** `new Function` wraps the body in a 2-line header, so body line 1 is source line 3. */
const FN_HEADER_LINES = 2

type Fn = () => unknown

interface Invocation {
  kind: 'setup' | 'loop'
  settled: boolean
  failed: boolean
  error: unknown
  async: boolean
}

interface Timer {
  wakeAt: number
  resolve: () => void
}

/** Yields to the event loop so every pending microtask of user code runs. */
export type Drain = () => Promise<void>

/** setImmediate where it exists (Node), else a zero timer; the worker passes a MessageChannel drain. */
export const defaultDrain: Drain = () =>
  new Promise((r) => {
    const immediate = (globalThis as { setImmediate?: (fn: () => void) => unknown }).setImmediate
    if (typeof immediate === 'function') immediate(r)
    else setTimeout(r, 0)
  })

/** 1-based user line from a V8 / SpiderMonkey stack frame inside the Function body. */
export function lineFromStack(stack: string | undefined, header = FN_HEADER_LINES): number {
  if (!stack) return 0
  const m = /<anonymous>:(\d+):\d+/.exec(stack) ?? /> Function:(\d+):\d+/.exec(stack)
  if (!m) return 0
  return Math.max(1, Number(m[1]) - header)
}

export function errorDiagnostic(e: unknown, fallbackLine = 1): Diagnostic {
  const err = e instanceof Error ? e : null
  const msg = err ? `${err.name}: ${err.message}` : `Uncaught ${String(e)}`
  // SpiderMonkey reports a lineNumber for syntax errors in Function bodies; V8 does not
  const ff = (err as { lineNumber?: unknown } | null)?.lineNumber
  const ln = typeof ff === 'number' ? ff - FN_HEADER_LINES : 0
  const line = lineFromStack(err?.stack) || (ln > 0 ? ln : fallbackLine)
  return { severity: 'error', message: msg, line, col: 1 }
}

export interface JsLoadResult {
  program: JsProgram | null
  diagnostics: Diagnostic[]
}

export class JsProgram {
  private setupFn: Fn | null = null
  private loopFn: Fn | null = null
  private phase: 'setup' | 'loop' | 'done' = 'setup'
  private current: Invocation | null = null
  private timers: Timer[] = []
  private watched = new Map<string, unknown>()
  private failure: Diagnostic | null = null
  private line = 0
  private warnedSyncDelay = false

  private constructor(private readonly shim: ArduinoShim, private readonly drain: Drain) {}

  /** Compile and run the top level; returns diagnostics on syntax / top-level errors. */
  static load(source: string, shim: ArduinoShim, drain: Drain = defaultDrain): JsLoadResult {
    const p = new JsProgram(shim, drain)
    const diags = p.instantiate(source)
    return { program: diags.some((d) => d.severity === 'error') ? null : p, diagnostics: diags }
  }

  private instantiate(source: string): Diagnostic[] {
    const scope = buildJsScope(this.shim, {
      delay: (ms) => this.delay(ms),
      watch: (name, v) => this.watch(name, v),
    })
    // 'use strict' on the first body line keeps user line numbers aligned. The block lets
    // `const max = 0` / `let map = ...` shadow a shim parameter instead of being a
    // redeclaration SyntaxError (strict block functions stay visible to the return).
    const body = `'use strict';{${source}\n;return { setup: typeof setup === 'function' ? setup : null, loop: typeof loop === 'function' ? loop : null }}`
    let exports: { setup: Fn | null; loop: Fn | null }
    try {
      // running user JS is the point of the sandbox; this only ever executes inside the worker
      const factory = new Function(...scope.names, body) as (...v: unknown[]) => { setup: Fn | null; loop: Fn | null }
      exports = factory(...scope.values)
    } catch (e) {
      return [errorDiagnostic(e)]
    }
    this.setupFn = exports.setup
    this.loopFn = exports.loop
    const out: Diagnostic[] = []
    if (!this.setupFn && !this.loopFn) {
      out.push({ severity: 'warning', message: 'No setup() or loop() function: nothing will run.', line: 1, col: 1 })
    }
    return out
  }

  /** delay(ms): a promise resolved by the runner once the virtual clock passes the deadline. */
  private delay(ms: number): Promise<void> {
    const wait = Number.isFinite(ms) && ms > 0 ? ms : 0
    this.line = lineFromStack(new Error().stack) || this.line
    return new Promise<void>((resolve) => {
      this.timers.push({ wakeAt: this.shim.now + wait, resolve })
    })
  }

  private watch(name: string, v: unknown): void {
    if (this.watched.has(name) || this.watched.size < MAX_WATCH) this.watched.set(name, v)
  }

  private invoke(fn: Fn, kind: Invocation['kind']): Invocation {
    const inv: Invocation = { kind, settled: false, failed: false, error: undefined, async: false }
    let ret: unknown
    try {
      ret = fn()
    } catch (e) {
      inv.settled = true
      inv.failed = true
      inv.error = e
      return inv
    }
    if (ret !== null && typeof ret === 'object' && typeof (ret as { then?: unknown }).then === 'function') {
      inv.async = true
      ;(ret as Promise<unknown>).then(
        () => {
          inv.settled = true
        },
        (e: unknown) => {
          inv.settled = true
          inv.failed = true
          inv.error = e
        },
      )
    } else {
      inv.settled = true
      if (this.timers.length > 0 && !this.warnedSyncDelay) {
        this.warnedSyncDelay = true
        this.shim.note('warn', 'delay() returns a Promise in JavaScript: use `await delay(ms)` inside an async function.')
      }
    }
    return inv
  }

  /**
   * Resolve the earliest due timers. Their continuation runs at the deadline, as on a
   * board: the program clock moves to it (at most MAX_CLOCK_LAG_MS behind sim time), so
   * the next delay() is measured from the wake-up, not from the frame. Returns how many woke.
   */
  private wakeDue(now: number): number {
    const w = this.nextWake()
    if (w === undefined || w > now) return 0
    this.shim.now = Math.min(now, Math.max(w, now - MAX_CLOCK_LAG_MS))
    return this.resolveUntil(w)
  }

  private resolveUntil(t: number): number {
    const due = this.timers.filter((x) => x.wakeAt <= t)
    if (due.length === 0) return 0
    this.timers = this.timers.filter((x) => x.wakeAt > t)
    for (const x of due) x.resolve()
    return due.length
  }

  private nextWake(): number | undefined {
    let w = Infinity
    for (const t of this.timers) w = Math.min(w, t.wakeAt)
    return Number.isFinite(w) ? w : undefined
  }

  /** Start the next invocation, or null when this tick should stop (loop() starts once per tick). */
  private start(loopStarts: number): Invocation | null {
    if (this.phase === 'setup') {
      this.phase = 'loop'
      if (this.setupFn) return this.invoke(this.setupFn, 'setup')
    }
    if (this.phase !== 'loop' || loopStarts >= 1) return null
    if (!this.loopFn) {
      this.phase = 'done'
      return null
    }
    return this.invoke(this.loopFn, 'loop')
  }

  /**
   * One frame. loop() STARTS at most once per tick, but a loop() resumed from an earlier
   * tick (it awaited a delay) is followed by the next one in the same tick, as on a board.
   */
  async tick(nowMs: number): Promise<TickOutcome> {
    if (this.failure) return this.outcome('error', 0)
    let loops = 0
    let loopStarts = 0
    let wakes = 0
    for (;;) {
      if (!this.current) {
        this.current = this.start(loopStarts)
        if (!this.current) break
        if (this.current.kind === 'loop') loopStarts++
      }
      const cur = this.current
      if (!cur.settled) {
        wakes += this.wakeDue(nowMs)
        await this.drain()
        if (!cur.settled) {
          const w = this.nextWake()
          if (w === undefined || w > nowMs || wakes >= MAX_WAKES_PER_TICK) break
          continue
        }
      }
      this.current = null
      if (cur.failed) {
        this.failure = errorDiagnostic(cur.error, this.line || 1)
        this.timers = []
        return this.outcome('error', loops)
      }
      if (cur.kind === 'loop') loops++
    }
    if (this.current) return this.outcome('sleeping', loops)
    // nothing awaits: due timers belong to un-awaited delay() calls; release them so they cannot pile up
    this.resolveUntil(nowMs)
    return this.outcome(this.phase === 'done' ? 'halted' : 'running', loops)
  }

  private outcome(status: TickOutcome['status'], loops: number): TickOutcome {
    const out: TickOutcome = { status, line: this.line, executed: 0, loops }
    if (status === 'sleeping') {
      const w = this.nextWake()
      if (w !== undefined) out.wakeAtMs = w
    }
    if (status === 'error' && this.failure) {
      out.error = this.failure
      out.line = this.failure.line
    }
    return out
  }

  globals(): WatchEntry[] {
    return [...this.watched].map(([name, v]) => ({ name, value: formatWatch(v) }))
  }
}
