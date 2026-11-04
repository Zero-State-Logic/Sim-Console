import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { Diagnostic } from '../compiler/api'
import type { BoardId } from '../core/protocol'
import type { RobotKind, SandboxFnDef, SensorSnapshot } from '../core/types'
import type { ExampleInfo } from './examples'
import { ConsoleBuffer } from './host/consoleBuffer'
import type { Dialect, WatchEntry } from './protocol'

/* ============================================================
   SANDBOX STORE — UI-facing program state. The controller is the
   only writer; per-tick values (line, LED, stats) are flushed here
   at about 10 Hz so React never re-renders at the frame rate.
   ============================================================ */

export type ProgramState = 'idle' | 'compiling' | 'running' | 'paused' | 'sleeping' | 'error' | 'stopped'

export interface SandboxStats {
  /** Compile (C++) or instantiate (JS) time of the loaded program, ms. */
  compileMs: number | null
  /** Moving average of VM instructions per tick (C++ only). */
  instrPerTick: number
  /** loop() completions per second of sim time. */
  loopHz: number
  ticks: number
}

export interface SandboxState {
  kind: RobotKind
  dialect: Dialect
  source: string
  /** Source of the program currently loaded in the worker (null = none). */
  loadedSource: string | null
  /** Editor differs from the loaded program. */
  dirty: boolean
  state: ProgramState
  diagnostics: Diagnostic[]
  /** Runtime error or watchdog report for the current / last run. */
  error: Diagnostic | null
  api: SandboxFnDef[]
  examples: ExampleInfo[]
  /** Buffer replaced by the last example load, for one-click restore. */
  prevSource: string | null
  stats: SandboxStats
  line: number
  led: number
  ledPin: number
  board: BoardId
  wakeAtMs: number | null
  globals: WatchEntry[]
  sensors: SensorSnapshot
  consoleRev: number
}

export function initialSandboxState(): SandboxState {
  return {
    kind: 'walker',
    dialect: 'cpp',
    source: '',
    loadedSource: null,
    dirty: false,
    state: 'idle',
    diagnostics: [],
    error: null,
    api: [],
    examples: [],
    prevSource: null,
    stats: { compileMs: null, instrPerTick: 0, loopHz: 0, ticks: 0 },
    line: 0,
    led: 0,
    ledPin: 2,
    board: 'esp32',
    wakeAtMs: null,
    globals: [],
    sensors: {},
    consoleRev: 0,
  }
}

export function createSandboxStore(): StoreApi<SandboxState> {
  return createStore<SandboxState>()(() => initialSandboxState())
}

/** The app's single sandbox store and console buffer. */
export const sandboxStore = createSandboxStore()
export const sandboxConsole = new ConsoleBuffer()

export function useSandbox<T>(selector: (s: SandboxState) => T): T {
  return useStore(sandboxStore, selector)
}

/** States in which a program is loaded in the worker. */
export function isActive(s: ProgramState): boolean {
  return s === 'running' || s === 'sleeping' || s === 'paused'
}
