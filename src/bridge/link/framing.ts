import { MAX_LINE_BYTES } from '../../core/protocol'

/* ============================================================
   NDJSON LINE FRAMER — turns an arbitrary chunked text stream
   (serial reads, BLE notifications, WS messages) into lines.
   Buffers partial lines, tolerates CRLF, skips empty lines and
   drops any line longer than MAX_LINE_BYTES (UTF-8 bytes).
   ============================================================ */

export interface FramerHandlers {
  onLine: (line: string) => void
  /** A line exceeded the cap and was discarded. `bytes` is the size seen so far. */
  onOversize?: (bytes: number) => void
}

/** UTF-8 byte length of a JS string without allocating an encoder buffer. */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      // surrogate pair = one 4-byte code point
      n += 4
      i++
    } else n += 3
  }
  return n
}

export class LineFramer {
  private buf = ''
  /** True while skipping the rest of an oversized line (until the next newline). */
  private discarding = false
  private discardedBytes = 0
  dropped = 0

  constructor(private readonly handlers: FramerHandlers, private readonly maxBytes = MAX_LINE_BYTES) {}

  push(chunk: string): void {
    let start = 0
    for (;;) {
      const nl = chunk.indexOf('\n', start)
      if (nl < 0) break
      this.finishLine(chunk.slice(start, nl))
      start = nl + 1
    }
    if (start < chunk.length) this.accumulate(chunk.slice(start))
  }

  /** Forget any partial line (e.g. after a reconnect). */
  reset(): void {
    this.buf = ''
    this.discarding = false
    this.discardedBytes = 0
  }

  private accumulate(part: string): void {
    if (this.discarding) {
      this.discardedBytes += utf8Length(part)
      return
    }
    this.buf += part
    // cheap bound first: UTF-8 length >= UTF-16 length
    if (this.buf.length > this.maxBytes || utf8Length(this.buf) > this.maxBytes) {
      this.discarding = true
      this.discardedBytes = utf8Length(this.buf)
      this.buf = ''
    }
  }

  private finishLine(tail: string): void {
    if (this.discarding) {
      const bytes = this.discardedBytes + utf8Length(tail)
      this.discarding = false
      this.discardedBytes = 0
      this.drop(bytes)
      return
    }
    let line = this.buf.length > 0 ? this.buf + tail : tail
    this.buf = ''
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line.length === 0) return
    const bytes = line.length > this.maxBytes / 4 ? utf8Length(line) : line.length
    if (bytes > this.maxBytes) {
      this.drop(bytes)
      return
    }
    this.handlers.onLine(line)
  }

  private drop(bytes: number): void {
    this.dropped++
    this.handlers.onOversize?.(bytes)
  }
}
