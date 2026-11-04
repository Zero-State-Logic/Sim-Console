/* ============================================================
   WATCHDOG — kills the code worker when a reply is overdue.
   Timer-driven (a blocked worker cannot answer, so polling it is
   useless) with one guard: if the MAIN thread itself stalled or
   the tab was hidden (no frame heartbeat), it waits another full
   period instead of blaming the program.
   ============================================================ */

export interface TimerFns {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realTimers: TimerFns = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/** A heartbeat older than this means the main thread was not running frames. */
export const STALL_GRACE_MS = 500

export class Watchdog<R extends string = string> {
  private handle: unknown = null
  private reason: R | null = null
  private limitMs = 0
  private strict = false
  private lastBeat: number

  constructor(
    private readonly timers: TimerFns,
    private readonly now: () => number,
    private readonly onBite: (reason: R) => void,
  ) {
    this.lastBeat = now()
  }

  get armed(): boolean {
    return this.handle !== null
  }

  /** Why the countdown is running (null when disarmed). */
  get pending(): R | null {
    return this.handle === null ? null : this.reason
  }

  /**
   * Start (or restart) the countdown. `strict` skips the stall guard: for work nobody is
   * waiting on any more, where frames may have stopped for good (the source left CODE).
   */
  arm(limitMs: number, reason: R, strict = false): void {
    this.disarm()
    this.reason = reason
    this.limitMs = limitMs
    this.strict = strict
    this.schedule()
  }

  disarm(): void {
    if (this.handle !== null) this.timers.clearTimeout(this.handle)
    this.handle = null
    this.reason = null
  }

  /** Called once per rendered frame. */
  heartbeat(): void {
    this.lastBeat = this.now()
  }

  private schedule(): void {
    this.handle = this.timers.setTimeout(() => this.fire(), this.limitMs)
  }

  private fire(): void {
    this.handle = null
    const reason = this.reason
    if (reason === null) return
    if (!this.strict && this.now() - this.lastBeat > STALL_GRACE_MS) {
      // the page was not ticking: give the worker a full period from now
      this.schedule()
      return
    }
    this.reason = null
    this.onBite(reason)
  }
}
