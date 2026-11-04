/* ============================================================
   LINK HEALTH — ping/pong RTT, line/byte rate meters and the
   stale-telemetry rule. Pure, clock passed in (ms).
   ============================================================ */

export const PING_INTERVAL_MS = 1000
/** No tel for this long while verified = STALE. */
export const STALE_MS = 500
const MAX_PENDING_PINGS = 8
const PING_EXPIRE_MS = 5000
/** EMA weight of each new RTT sample. */
const RTT_ALPHA = 0.25

export class PingTracker {
  private nextId = 1
  private nextAt = 0
  private pending = new Map<number, number>()
  /** Smoothed RTT, ms. */
  rtt: number | null = null
  /** Most recent raw RTT, ms. */
  lastRtt: number | null = null

  /** True when a ping should be sent at `now`. */
  due(now: number): boolean {
    return now >= this.nextAt
  }

  /** Register a ping sent at `now`; returns its id. */
  issue(now: number): number {
    const id = this.nextId++
    this.nextAt = now + PING_INTERVAL_MS
    this.pending.set(id, now)
    // keep the map bounded when a board never answers
    for (const [k, sentAt] of this.pending) {
      if (this.pending.size <= MAX_PENDING_PINGS && now - sentAt < PING_EXPIRE_MS) break
      this.pending.delete(k)
    }
    return id
  }

  /** Match a pong. Returns the raw RTT, or null for an unknown / expired id. */
  resolve(id: number, now: number): number | null {
    const sentAt = this.pending.get(id)
    if (sentAt === undefined) return null
    this.pending.delete(id)
    const rtt = Math.max(0, now - sentAt)
    this.lastRtt = rtt
    this.rtt = this.rtt === null ? rtt : this.rtt + RTT_ALPHA * (rtt - this.rtt)
    return rtt
  }

  get pendingCount(): number {
    return this.pending.size
  }

  reset(): void {
    this.pending.clear()
    this.nextAt = 0
    this.rtt = null
    this.lastRtt = null
  }
}

/** Counts events and bytes; publishes per-second rates once per window. */
export class RateMeter {
  private count = 0
  private bytes = 0
  private windowStart: number | null = null
  perSec = 0
  bytesPerSec = 0

  constructor(private readonly windowMs = 1000) {}

  add(bytes: number, now: number): void {
    if (this.windowStart === null) this.windowStart = now
    this.count++
    this.bytes += bytes
  }

  /** Close the window if it elapsed. Returns true when the rates changed. */
  update(now: number): boolean {
    if (this.windowStart === null) {
      this.windowStart = now
      return false
    }
    const elapsed = now - this.windowStart
    if (elapsed < this.windowMs) return false
    const perSec = (this.count * 1000) / elapsed
    const bytesPerSec = (this.bytes * 1000) / elapsed
    const changed = perSec !== this.perSec || bytesPerSec !== this.bytesPerSec
    this.perSec = perSec
    this.bytesPerSec = bytesPerSec
    this.count = 0
    this.bytes = 0
    this.windowStart = now
    return changed
  }

  reset(): void {
    this.count = 0
    this.bytes = 0
    this.windowStart = null
    this.perSec = 0
    this.bytesPerSec = 0
  }
}

/** Telemetry is stale when nothing arrived for STALE_MS since `since` (the later of last tel and verify). */
export function isStale(now: number, lastTelAt: number | null, since: number, staleMs = STALE_MS): boolean {
  const ref = lastTelAt === null ? since : Math.max(lastTelAt, since)
  return now - ref > staleMs
}
