import type { LogDir, LogEntry, LogTag } from '../types'

/* ============================================================
   LOG RING — fixed-capacity serial-monitor history. Entry objects
   are preallocated and overwritten in place, so a 100 line/s link
   does not churn the GC. Readers copy what they render.
   ============================================================ */

export const LOG_CAPACITY = 2000
/** Display cap per entry; the raw line can be up to MAX_LINE_BYTES. */
export const LOG_TEXT_CHARS = 600

export class LogRing {
  private readonly slots: LogEntry[]
  private head = 0
  private size = 0
  private nextId = 1
  /** Bumped on every push and clear; cheap change detection for readers. */
  version = 0

  constructor(readonly capacity = LOG_CAPACITY) {
    this.slots = Array.from({ length: capacity }, () => ({ id: 0, ts: 0, dir: 'sys' as LogDir, text: '' }))
  }

  push(ts: number, dir: LogDir, text: string, tag?: LogTag): void {
    const e = this.slots[this.head]
    e.id = this.nextId++
    e.ts = ts
    e.dir = dir
    e.text = text.length > LOG_TEXT_CHARS ? `${text.slice(0, LOG_TEXT_CHARS)}… (+${text.length - LOG_TEXT_CHARS} chars)` : text
    e.tag = tag
    this.head = (this.head + 1) % this.capacity
    if (this.size < this.capacity) this.size++
    this.version++
  }

  get length(): number {
    return this.size
  }

  clear(): void {
    this.size = 0
    this.head = 0
    this.version++
  }

  /** Oldest-first copies of the newest `limit` entries passing `filter`. */
  snapshot(limit = this.capacity, filter?: (e: LogEntry) => boolean): LogEntry[] {
    const out: LogEntry[] = []
    for (let k = 0; k < this.size && out.length < limit; k++) {
      const e = this.slots[(this.head - 1 - k + this.capacity * 2) % this.capacity]
      if (!filter || filter(e)) out.push({ id: e.id, ts: e.ts, dir: e.dir, text: e.text, tag: e.tag })
    }
    return out.reverse()
  }

  /** Every entry as NDJSON, oldest first: {"ts":..,"dir":"rx","text":".."} per line. */
  toNdjson(): string {
    let s = ''
    for (const e of this.snapshot()) {
      s += JSON.stringify(e.tag ? { ts: Math.round(e.ts), dir: e.dir, text: e.text, tag: e.tag } : { ts: Math.round(e.ts), dir: e.dir, text: e.text })
      s += '\n'
    }
    return s
  }
}
