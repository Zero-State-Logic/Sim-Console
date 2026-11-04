import type { Diagnostic } from '../../compiler/api'
import type { RunStatus, WatchEntry } from '../protocol'

/** Result of one program tick, shared by the C++ and JS runners. */
export interface TickOutcome {
  status: RunStatus
  /** 1-based line executing now, 0 = unknown. */
  line: number
  /** Instructions executed (C++ only). */
  executed: number
  /** loop() completions during this tick. */
  loops: number
  wakeAtMs?: number
  error?: Diagnostic
}

export interface ProgramRunner {
  tick(nowMs: number): TickOutcome | Promise<TickOutcome>
  globals(): WatchEntry[]
}
