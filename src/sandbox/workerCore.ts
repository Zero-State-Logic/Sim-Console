import type { Diagnostic } from '../compiler/api'
import { ArduinoShim } from './shim/arduino'
import { CppProgram, type CompilerFns } from './runner/cppRunner'
import { JsProgram, defaultDrain, type Drain } from './runner/jsRunner'
import type { TickOutcome } from './runner/types'
import { parseMainMsg, type LoadMsg, type LoadedMsg, type MainMsg, type OutMsg, type TickMsg, type WatchEntry, type WorkerMsg } from './protocol'

/* ============================================================
   WORKER CORE — every message the code worker handles, as plain
   logic with no Worker globals, so it runs (and is tested) in Node.
   Messages are processed strictly in order through one queue.
   ============================================================ */

/** Globals snapshot cadence (about 4 Hz). */
export const GLOBALS_INTERVAL_MS = 250

export interface CoreDeps {
  compiler: CompilerFns
  /** Wall clock, ms (compile timing and the globals throttle). */
  clock: () => number
  drain?: Drain
}

type Runner = CppProgram | JsProgram

/** Watched JS values are user objects (getters run here): a throw must not cost the reply. */
function safeGlobals(runner: Runner): WatchEntry[] {
  try {
    return runner.globals()
  } catch (e) {
    return [{ name: '(watch)', value: `could not read: ${e instanceof Error ? e.message : String(e)}` }]
  }
}

export class WorkerCore {
  private shim: ArduinoShim | null = null
  private runner: Runner | null = null
  private loaded: LoadMsg | null = null
  private lastGlobalsAt = -Infinity
  private lastStatus: TickOutcome['status'] | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: CoreDeps, private readonly post: (msg: WorkerMsg) => void) {}

  /** Entry point for raw message data. Resolves when this message has been handled. */
  receive(data: unknown): Promise<void> {
    const msg = parseMainMsg(data)
    if (!msg) return this.queue
    this.queue = this.queue
      .then(async () => {
        const reply = await this.handle(msg)
        if (reply) this.post(reply)
      })
      .catch(() => {
        /* a failed message must not wedge the queue; the main-thread watchdog recovers */
      })
    return this.queue
  }

  async handle(msg: MainMsg): Promise<WorkerMsg | null> {
    switch (msg.t) {
      case 'load':
        return this.onLoad(msg)
      case 'tick':
        return this.onTick(msg)
      case 'reset':
        this.onReset()
        return null
      case 'stop':
        this.shim = null
        this.runner = null
        this.loaded = null
        return null
    }
  }

  private instantiate(msg: LoadMsg, shim: ArduinoShim): { runner: Runner | null; diagnostics: Diagnostic[] } {
    if (msg.dialect === 'cpp') {
      const r = CppProgram.load(msg.source, shim, msg.intBits, this.deps.compiler)
      return { runner: r.program, diagnostics: r.diagnostics }
    }
    const r = JsProgram.load(msg.source, shim, this.deps.drain ?? defaultDrain)
    return { runner: r.program, diagnostics: r.diagnostics }
  }

  private onLoad(msg: LoadMsg): LoadedMsg {
    const t0 = this.deps.clock()
    const shim = new ArduinoShim(msg.hw, msg.api)
    let res: { runner: Runner | null; diagnostics: Diagnostic[] }
    try {
      res = this.instantiate(msg, shim)
    } catch (e) {
      res = { runner: null, diagnostics: [{ severity: 'error', message: `Internal error: ${String(e)}`, line: 1, col: 1 }] }
    }
    const compileMs = this.deps.clock() - t0
    this.shim = res.runner ? shim : null
    this.runner = res.runner
    this.loaded = res.runner ? msg : null
    this.lastGlobalsAt = -Infinity
    this.lastStatus = null
    return { t: 'loaded', id: msg.id, ok: res.runner !== null, diagnostics: res.diagnostics, compileMs, log: [] }
  }

  private onReset(): void {
    const load = this.loaded
    const shim = this.shim
    if (!load || !shim || !this.runner) return
    shim.reset()
    if (this.runner instanceof CppProgram) {
      this.runner.reset()
    } else {
      // JS has no VM to rewind: run the top level again for fresh globals
      const r = JsProgram.load(load.source, shim, this.deps.drain ?? defaultDrain)
      this.runner = r.program
    }
    this.lastStatus = null
  }

  private emptyOut(seq: number, status: OutMsg['status']): OutMsg {
    return { t: 'out', seq, cmds: [], serial: [], log: [], status, line: 0, led: 0, executed: 0, loops: 0 }
  }

  private async onTick(msg: TickMsg): Promise<OutMsg> {
    const shim = this.shim
    const runner = this.runner
    if (!shim || !runner) return this.emptyOut(msg.seq, 'halted')
    shim.beginTick(msg.nowMs, msg.sensors, msg.input)
    let outcome: TickOutcome
    try {
      outcome = await runner.tick(msg.nowMs)
    } catch (e) {
      outcome = { status: 'error', line: 0, executed: 0, loops: 0, error: { severity: 'error', message: `Internal error: ${String(e)}`, line: 1, col: 1 } }
    }
    const io = shim.takeOutput()
    const out: OutMsg = {
      t: 'out',
      seq: msg.seq,
      cmds: io.cmds,
      serial: io.serial,
      log: io.log,
      status: outcome.status,
      line: outcome.line,
      led: shim.led,
      executed: outcome.executed,
      loops: outcome.loops,
    }
    if (outcome.error) out.error = outcome.error
    if (outcome.wakeAtMs !== undefined) out.wakeAtMs = outcome.wakeAtMs
    const now = this.deps.clock()
    const changed = outcome.status !== this.lastStatus && outcome.status !== 'running'
    if (msg.wantGlobals || changed || now - this.lastGlobalsAt >= GLOBALS_INTERVAL_MS) {
      out.globals = safeGlobals(runner)
      this.lastGlobalsAt = now
    }
    this.lastStatus = outcome.status
    return out
  }
}
