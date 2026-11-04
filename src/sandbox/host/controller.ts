import type { StoreApi } from 'zustand/vanilla'
import type { Diagnostic } from '../../compiler/api'
import { fitConfigToSpec, type HardwareConfig } from '../../core/hardware'
import type { RobotModule, SandboxCommand } from '../../core/types'
import { defaultSource, exampleInfos, exampleSource, type ExampleCtx } from '../examples'
import { commandNameSet, MAX_CMDS_PER_TICK, parseWorkerMsg, type Dialect, type HwMap, type LoadedMsg, type MainMsg, type OutMsg } from '../protocol'
import { ledPin } from '../shim/boards'
import { isActive, type ProgramState, type SandboxState } from '../store'
import type { ConsoleBuffer, ConsoleKind } from './consoleBuffer'
import type { SourceStore } from './persist'
import { RateMeter } from './rate'
import { Watchdog, type TimerFns } from './watchdog'

/* ============================================================
   SANDBOX CONTROLLER — the main-thread side of the CODE source.
   Owns the worker, the program state machine and the watchdog.
   One frame of latency, like a real control loop: frame N posts
   sensors, frame N+1 applies the commands that came back.
   ============================================================ */

export const TICK_LIMIT_MS = 1000
export const LOAD_LIMIT_MS = 3000
const FLUSH_INTERVAL_MS = 100
const PERSIST_DELAY_MS = 400
const MAX_PENDING_INPUT = 4096
const WATCHDOG_TICK_MSG = 'loop() blocked for more than 1 s (infinite loop?)'
const WATCHDOG_LOAD_MSG = 'The program did not finish loading within 3 s (infinite loop at the top level?)'
const WATCHDOG_ABANDONED_MSG = 'watchdog: the stopped program was still stuck in user code (infinite loop?), so its worker was shut down.'

/** The bits of a Worker the controller uses (a real Worker satisfies it). */
export interface WorkerLike {
  postMessage(msg: MainMsg): void
  terminate(): void
  onmessage: ((e: MessageEvent) => void) | null
  onerror: ((e: ErrorEvent) => void) | null
}

export interface ControllerDeps {
  spawn: () => WorkerLike
  store: StoreApi<SandboxState>
  console: ConsoleBuffer
  persist: SourceStore
  hardware: () => HardwareConfig
  timers: TimerFns
  /** Wall clock, ms. */
  clock: () => number
}

/** 'abandoned' = a reply nobody waits for any more (after STOP); if it never comes, the worker is stuck. */
type Bite = 'tick' | 'load' | 'abandoned'

/** The profile slice the worker needs, fitted to the module's joint count. */
export function hwMapFor(cfg: HardwareConfig, m: RobotModule): HwMap {
  const c = fitConfigToSpec(cfg, m.getHardwareSpec())
  return {
    board: c.board,
    servoDriver: c.servoDriver,
    servoPins: c.servoPins.slice(),
    servoMinUs: c.servoMinUs,
    servoMaxUs: c.servoMaxUs,
    servoRangeDeg: c.servoRangeDeg,
    jointInvert: c.jointInvert.slice(),
    jointOffsetDeg: c.jointOffsetDeg.slice(),
    jointScale: c.jointScale.slice(),
  }
}

/** Every supported board is 32-bit (ESP32, RP2040, STM32, Pi), so `int` is 32 bits. */
export function intBitsFor(): 16 | 32 {
  return 32
}

export class SandboxController {
  private worker: WorkerLike | null = null
  private module: RobotModule | null = null
  private loadId = 0
  private seq = 0
  private inFlight: number | null = null
  private pendingCmds: SandboxCommand[] | null = null
  private stepPending = false
  private afterLoad: 'running' | 'paused' = 'running'
  private commandNames = new Set<string>()
  private input = ''
  private simT = 0
  /** Sim time of the last frame the loaded program saw (null = nothing loaded yet). */
  private progT: number | null = null
  private readonly meter = new RateMeter()
  private instrEma = 0
  private ticks = 0
  private lastFlush = -Infinity
  private persistHandle: unknown = null
  /** Latest per-tick values; flushed to the store at about 10 Hz. */
  private readonly live: Pick<SandboxState, 'line' | 'led' | 'wakeAtMs' | 'sensors'> = { line: 0, led: 0, wakeAtMs: null, sensors: {} }
  private readonly watchdog: Watchdog<Bite>

  constructor(private readonly deps: ControllerDeps) {
    this.watchdog = new Watchdog<Bite>(deps.timers, deps.clock, (r) => this.bite(r))
  }

  /* ---------------- helpers ---------------- */

  private get st(): SandboxState {
    return this.deps.store.getState()
  }

  private set(patch: Partial<SandboxState>): void {
    this.deps.store.setState(patch)
  }

  private log(kind: ConsoleKind, text: string): void {
    this.deps.console.push(kind, text, this.simT * 1000)
    this.set({ consoleRev: this.deps.console.rev })
  }

  private setState(state: ProgramState): void {
    if (this.st.state !== state) this.set({ state })
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker
    const w = this.deps.spawn()
    w.onmessage = (e) => this.onMessage(e.data)
    w.onerror = (e) => this.onWorkerError(e)
    this.worker = w
    return w
  }

  private killWorker(): void {
    if (!this.worker) return
    this.worker.onmessage = null
    this.worker.onerror = null
    this.worker.terminate()
    this.worker = null
    this.watchdog.disarm()
  }

  /**
   * Forget any in-flight work: its replies will be dropped. A worker that still owes a
   * reply may be stuck in user code, and a stuck worker never reads the 'stop' that follows,
   * so the watchdog keeps watching it (strictly: frames stop once the source leaves CODE).
   */
  private drop(): void {
    this.inFlight = null
    this.pendingCmds = null
    this.stepPending = false
    const owed = this.watchdog.pending
    if (this.worker && (owed === 'tick' || owed === 'load')) this.watchdog.arm(TICK_LIMIT_MS, 'abandoned', true)
    else if (owed !== 'abandoned') this.watchdog.disarm()
  }

  private release(): void {
    this.module?.releaseSandbox()
  }

  private clearLive(): void {
    this.live.line = 0
    this.live.wakeAtMs = null
  }

  private exampleCtx(m: RobotModule): ExampleCtx {
    return { spec: m.getHardwareSpec(), hw: fitConfigToSpec(this.deps.hardware(), m.getHardwareSpec()) }
  }

  /* ---------------- program control (UI) ---------------- */

  run(): void {
    const { state, dirty } = this.st
    if (state === 'compiling') return
    if ((state === 'running' || state === 'sleeping') && !dirty) return
    if (state === 'paused' && !dirty) {
      this.setState('running')
      this.log('sys', '▶ resumed')
      return
    }
    this.afterLoad = 'running'
    this.load()
  }

  pause(): void {
    const s = this.st.state
    if (s !== 'running' && s !== 'sleeping') return
    this.setState('paused')
    this.flush(true)
    this.log('sys', '❚❚ paused')
  }

  /** Run exactly one tick (loads first when nothing is loaded). */
  step(): void {
    const { state, dirty } = this.st
    if (state === 'compiling') return
    if (state === 'running' || state === 'sleeping') {
      this.setState('paused')
      this.stepPending = true
      return
    }
    if (state === 'paused' && !dirty) {
      this.stepPending = true
      return
    }
    this.afterLoad = 'paused'
    this.load()
    this.stepPending = true
  }

  /** Start over from setup() (reloads instead when the editor changed). */
  reset(): void {
    const { state, dirty } = this.st
    if (!isActive(state)) return
    if (dirty) {
      this.afterLoad = state === 'paused' ? 'paused' : 'running'
      this.load()
      return
    }
    this.restart('↺ reset: setup() runs again')
  }

  /** Same program from the top: fresh globals, setup() runs again (paused stays paused). */
  private restart(note: string): void {
    const state = this.st.state
    this.drop()
    this.clearLive()
    this.worker?.postMessage({ t: 'reset' })
    this.release()
    this.meter.reset()
    this.set({ line: 0, error: null, wakeAtMs: null, globals: [] })
    if (state === 'sleeping') this.setState('running')
    this.log('sys', note)
  }

  stop(): void {
    const s = this.st.state
    if (!isActive(s) && s !== 'compiling') return
    this.loadId++
    this.drop()
    this.clearLive()
    this.worker?.postMessage({ t: 'stop' })
    this.release()
    this.set({ state: 'stopped', line: 0, wakeAtMs: null })
    this.log('sys', '■ stopped')
  }

  private load(): void {
    const m = this.module
    if (!m) return
    // never queue a program behind a reply that is still owed (the old one may be stuck)
    if (this.watchdog.pending !== null) this.killWorker()
    const w = this.ensureWorker()
    const api = m.getSandboxApi()
    const hw = hwMapFor(this.deps.hardware(), m)
    const { source, dialect } = this.st
    this.commandNames = commandNameSet(api)
    this.loadId++
    this.progT = null
    this.drop()
    this.clearLive()
    this.live.led = 0
    this.release()
    this.meter.reset()
    this.instrEma = 0
    this.ticks = 0
    this.set({
      state: 'compiling',
      diagnostics: [],
      error: null,
      api,
      line: 0,
      led: 0,
      wakeAtMs: null,
      globals: [],
      ledPin: ledPin(hw.board),
      board: hw.board,
    })
    w.postMessage({ t: 'load', id: this.loadId, dialect, source, api, hw, intBits: intBitsFor() })
    this.watchdog.arm(LOAD_LIMIT_MS, 'load')
  }

  /* ---------------- editor (UI) ---------------- */

  setSource(source: string): void {
    const loaded = this.st.loadedSource
    this.set({ source, dirty: loaded !== null && loaded !== source })
    this.schedulePersist()
  }

  private schedulePersist(): void {
    if (this.persistHandle !== null) this.deps.timers.clearTimeout(this.persistHandle)
    this.persistHandle = this.deps.timers.setTimeout(() => this.persistNow(), PERSIST_DELAY_MS)
  }

  /** Write the editor buffer now (also called before switching robot or dialect). */
  persistNow(): void {
    if (this.persistHandle !== null) this.deps.timers.clearTimeout(this.persistHandle)
    this.persistHandle = null
    const { kind, dialect, source } = this.st
    if (source.length > 0) this.deps.persist.save(kind, dialect, source)
  }

  setDialect(d: Dialect): void {
    if (d === this.st.dialect) return
    this.stop()
    this.persistNow()
    this.deps.persist.saveDialect(d)
    this.set({ dialect: d })
    this.loadBuffer()
  }

  loadExample(id: string): void {
    const m = this.module
    if (!m) return
    const { kind, dialect, source } = this.st
    const src = exampleSource(kind, id, dialect, this.exampleCtx(m))
    if (src === null || src === source) return
    this.set({ prevSource: source })
    this.setSource(src)
  }

  restorePrevious(): void {
    const prev = this.st.prevSource
    if (prev === null) return
    this.set({ prevSource: null })
    this.setSource(prev)
  }

  /** Console input line, delivered to Serial.read() with a newline. */
  sendSerial(text: string): void {
    this.input = (this.input + text + '\n').slice(-MAX_PENDING_INPUT)
    this.log('in', text)
  }

  clearConsole(): void {
    this.deps.console.clear()
    this.set({ consoleRev: this.deps.console.rev })
  }

  /** Editor buffer for the current kind + dialect: stored text, else the first example. */
  private loadBuffer(): void {
    const m = this.module
    const { kind, dialect } = this.st
    const stored = this.deps.persist.load(kind, dialect)
    const source = stored ?? (m ? defaultSource(kind, dialect, this.exampleCtx(m)) : '')
    this.set({ source, loadedSource: null, dirty: false, diagnostics: [], error: null, prevSource: null, state: 'idle', line: 0, globals: [] })
  }

  /* ---------------- SandboxApi (runtime) ---------------- */

  tick(m: RobotModule, dt: number, t: number): void {
    this.module = m
    this.simT = t
    this.watchdog.heartbeat()
    if (!this.worker || !isActive(this.st.state)) return
    // the sim clock went back (sim RESET). A board clock cannot, and the VM clock would
    // stall until sim time caught up, so the program restarts like a power cycle.
    if (this.progT !== null && t < this.progT) this.restart('↺ sim reset: setup() runs again')
    this.progT = t
    if (dt > 0 && this.pendingCmds) {
      const cmds = this.pendingCmds
      this.pendingCmds = null
      m.applySandboxCommands(cmds)
    }
    if (this.inFlight !== null) return
    if (this.stepPending) {
      this.stepPending = false
      this.postTick(m, t, true)
      return
    }
    if (dt <= 0) return
    const state = this.st.state
    const wake = this.live.wakeAtMs
    if (state === 'running') this.postTick(m, t, false)
    // a sleeping program has nothing to do before its wake time
    else if (state === 'sleeping' && (wake === null || t * 1000 >= wake)) this.postTick(m, t, false)
  }

  onSourceEnter(m: RobotModule): void {
    this.module = m
    this.set({ api: m.getSandboxApi() })
    this.ensureWorker()
  }

  onSourceExit(m: RobotModule): void {
    this.module = m
    this.stop()
    m.releaseSandbox()
  }

  onRobotChange(m: RobotModule): void {
    this.persistNow()
    if (isActive(this.st.state) || this.st.state === 'compiling') {
      this.loadId++
      this.drop()
      this.worker?.postMessage({ t: 'stop' })
    }
    this.module = m
    const dialect = this.deps.persist.loadDialect() ?? this.st.dialect
    const hw = fitConfigToSpec(this.deps.hardware(), m.getHardwareSpec())
    this.set({ kind: m.kind, dialect, api: m.getSandboxApi(), examples: exampleInfos(m.kind), ledPin: ledPin(hw.board), board: hw.board })
    this.loadBuffer()
  }

  /* ---------------- worker traffic ---------------- */

  private postTick(m: RobotModule, t: number, wantGlobals: boolean): void {
    const w = this.worker
    if (!w) return
    const sensors = m.getSandboxSensors()
    const seq = ++this.seq
    const msg: MainMsg = { t: 'tick', seq, nowMs: t * 1000, sensors }
    if (this.input) {
      msg.input = this.input
      this.input = ''
    }
    if (wantGlobals) msg.wantGlobals = true
    this.inFlight = seq
    w.postMessage(msg)
    this.watchdog.arm(TICK_LIMIT_MS, 'tick')
    this.live.sensors = sensors
  }

  private onMessage(data: unknown): void {
    // any reply proves an abandoned request did not hang the worker
    if (this.watchdog.pending === 'abandoned') this.watchdog.disarm()
    const msg = parseWorkerMsg(data, this.commandNames)
    if (!msg) return
    if (msg.t === 'loaded') {
      if (msg.id !== this.loadId) return
      this.watchdog.disarm()
      this.onLoaded(msg)
      return
    }
    if (this.inFlight === null || msg.seq !== this.inFlight) return
    this.inFlight = null
    this.watchdog.disarm()
    this.onOut(msg)
  }

  private onLoaded(msg: LoadedMsg): void {
    for (const e of msg.log) this.log(e.level, e.text)
    const st = this.st
    const errors = msg.diagnostics.filter((d) => d.severity === 'error')
    const stats = { ...st.stats, compileMs: msg.compileMs, instrPerTick: 0, loopHz: 0, ticks: 0 }
    if (!msg.ok) {
      this.stepPending = false
      this.set({ state: 'error', diagnostics: msg.diagnostics, error: errors[0] ?? null, stats })
      for (const d of errors.slice(0, 8)) this.log('error', `line ${d.line}:${d.col}  ${d.message}`)
      if (errors.length === 0) this.log('error', 'The program could not be loaded.')
      return
    }
    for (const d of msg.diagnostics.filter((x) => x.severity === 'warning').slice(0, 8)) {
      this.log('warn', `line ${d.line}:${d.col}  ${d.message}`)
    }
    const label = st.dialect === 'cpp' ? `C++ compiled in ${msg.compileMs.toFixed(1)} ms` : `JavaScript loaded in ${msg.compileMs.toFixed(1)} ms`
    this.set({ state: this.afterLoad, diagnostics: msg.diagnostics, loadedSource: st.source, dirty: false, stats })
    this.log('sys', `▶ ${label}${this.afterLoad === 'paused' ? ' · paused at setup()' : ''}`)
  }

  private onOut(msg: OutMsg): void {
    if (msg.cmds.length > 0) {
      const merged = this.pendingCmds ? this.pendingCmds.concat(msg.cmds) : msg.cmds
      this.pendingCmds = merged.length > MAX_CMDS_PER_TICK ? merged.slice(merged.length - MAX_CMDS_PER_TICK) : merged
    }
    const tMs = this.simT * 1000
    for (const chunk of msg.serial) this.deps.console.appendSerial(chunk, tMs)
    for (const e of msg.log) this.deps.console.push(e.level, e.text, tMs)
    this.ticks++
    this.instrEma = this.ticks === 1 ? msg.executed : this.instrEma * 0.9 + msg.executed * 0.1
    this.meter.add(this.simT, msg.loops)
    this.live.line = msg.line
    this.live.led = msg.led
    this.live.wakeAtMs = msg.status === 'sleeping' ? msg.wakeAtMs ?? null : null
    if (msg.globals) this.set({ globals: msg.globals })
    const changed = this.applyStatus(msg)
    this.flush(changed)
  }

  /** Map the worker's run status onto the program state. Returns true on a change. */
  private applyStatus(msg: OutMsg): boolean {
    const s = this.st.state
    switch (msg.status) {
      case 'running':
        if (s === 'sleeping') this.setState('running')
        return s === 'sleeping'
      case 'sleeping':
        if (s === 'running') this.setState('sleeping')
        return s === 'running'
      case 'halted':
        this.drop()
        this.release()
        this.setState('stopped')
        this.log('sys', '■ program finished (loop() returned for good)')
        return true
      case 'error': {
        const err: Diagnostic = msg.error ?? { severity: 'error', message: 'Runtime error', line: msg.line || 1, col: 1 }
        this.drop()
        this.release()
        this.set({ state: 'error', error: err })
        this.log('error', `runtime error, line ${err.line}: ${err.message}`)
        return true
      }
    }
  }

  /** Push the per-tick values to the store, at most every 100 ms unless forced. */
  private flush(force: boolean): void {
    const now = this.deps.clock()
    if (!force && now - this.lastFlush < FLUSH_INTERVAL_MS) return
    this.lastFlush = now
    const st = this.st
    this.set({
      line: this.live.line,
      led: this.live.led,
      wakeAtMs: this.live.wakeAtMs,
      sensors: this.live.sensors,
      consoleRev: this.deps.console.rev,
      stats: { compileMs: st.stats.compileMs, instrPerTick: Math.round(this.instrEma), loopHz: this.meter.rate(), ticks: this.ticks },
    })
  }

  /* ---------------- failure paths ---------------- */

  private bite(reason: Bite): void {
    if (reason === 'abandoned' && !isActive(this.st.state)) {
      // the program was already stopped: just reclaim the CPU (a new worker spawns on RUN)
      this.killWorker()
      this.log('warn', WATCHDOG_ABANDONED_MSG)
      return
    }
    this.killWorker()
    this.loadId++
    this.drop()
    this.ensureWorker()
    this.release()
    // an abandoned tick that outlived a RESET is still loop() stuck
    const message = reason === 'load' ? WATCHDOG_LOAD_MSG : WATCHDOG_TICK_MSG
    const line = this.live.line || 1
    this.clearLive()
    this.set({ state: 'stopped', error: { severity: 'error', message, line, col: 1 }, wakeAtMs: null })
    this.log('error', `watchdog: ${message}. The worker was restarted.`)
  }

  private onWorkerError(e: ErrorEvent): void {
    e.preventDefault?.()
    this.killWorker()
    this.loadId++
    this.drop()
    this.release()
    const message = `The code worker crashed: ${e.message || 'script error'}`
    this.set({ state: 'error', error: { severity: 'error', message, line: 1, col: 1 } })
    this.log('error', message)
  }

  /** Tear down (tests and hot reload). */
  dispose(): void {
    this.drop()
    this.killWorker()
    if (this.persistHandle !== null) this.deps.timers.clearTimeout(this.persistHandle)
    this.persistHandle = null
  }
}
