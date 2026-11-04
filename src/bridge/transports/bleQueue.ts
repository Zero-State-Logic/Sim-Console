/* ============================================================
   BLE WRITE QUEUE — Nordic UART RX writes, one GATT operation at
   a time (the stack rejects overlapping ones), chunked to 20 bytes
   (default ATT MTU 23 − 3). Prefers write-without-response and
   falls back to write-with-response for good if the device or
   browser refuses it. Non-critical lines are dropped whole when
   the backlog is too large, so a slow link never splits a line.
   A critical line (E-STOP, HOME) jumps the backlog: queued
   non-critical lines that have not started are discarded, so it
   goes out right after the line already on the air.
   ============================================================ */

/** Nordic UART Service. The codegen firmware uses the same UUIDs. */
export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
/** App → bot (write). */
export const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'
/** Bot → app (notify). */
export const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'

export const BLE_CHUNK = 20
/** Non-critical lines are refused beyond this many queued bytes (~0.5 s at BLE rates). */
export const BLE_MAX_BACKLOG = 1024

export interface GattWriter {
  /** write-without-response; may be missing or reject with NotSupportedError. */
  withoutResponse?: (chunk: Uint8Array) => Promise<void>
  withResponse: (chunk: Uint8Array) => Promise<void>
}

export function chunkBytes(data: Uint8Array, size = BLE_CHUNK): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, Math.min(i + size, data.length)))
  return out
}

interface QueuedLine {
  chunks: Uint8Array[]
  /** Index of the next chunk to write; > 0 = partly on the air, must be finished. */
  next: number
  critical: boolean
}

export class BleWriteQueue {
  private readonly lines: QueuedLine[] = []
  private queued = 0
  private busy = false
  private useWithout: boolean
  private closed = false
  /** Non-critical lines discarded because a critical one jumped the queue. */
  superseded = 0
  /** Called once when a write fails for a reason other than the fallback. */
  onError: ((e: unknown) => void) | null = null

  constructor(private readonly writer: GattWriter, private readonly encoder: { encode(s: string): Uint8Array } = new TextEncoder()) {
    this.useWithout = typeof writer.withoutResponse === 'function'
  }

  get backlog(): number {
    return this.queued
  }

  /** Whether the queue fell back to write-with-response. */
  get withResponse(): boolean {
    return !this.useWithout
  }

  /** Queue one line (newline appended). Returns false when dropped. */
  push(line: string, critical = false): boolean {
    if (this.closed) return false
    const data = this.encoder.encode(`${line}\n`)
    if (!critical && this.queued + data.length > BLE_MAX_BACKLOG) return false
    if (critical) this.dropUnstarted()
    this.lines.push({ chunks: chunkBytes(data), next: 0, critical })
    this.queued += data.length
    void this.drain()
    return true
  }

  close(): void {
    this.closed = true
    this.lines.length = 0
    this.queued = 0
  }

  /** Resolves when everything queued so far has been written (tests, clean shutdown). */
  async flush(): Promise<void> {
    while (this.busy || this.lines.length > 0) await new Promise((r) => setTimeout(r, 0))
  }

  /** Discard queued non-critical lines that have not started (the head line may be on the air). */
  private dropUnstarted(): void {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i]
      if (l.critical || l.next > 0 || (i === 0 && this.busy)) continue
      for (const c of l.chunks) this.queued -= c.length
      this.lines.splice(i, 1)
      this.superseded++
    }
  }

  private async drain(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      while (this.lines.length > 0 && !this.closed) {
        const l = this.lines[0]
        const c = l.chunks[l.next]
        await this.writeChunk(c)
        if (this.closed) break
        l.next++
        this.queued -= c.length
        if (l.next >= l.chunks.length) this.lines.shift()
      }
    } catch (e) {
      this.close()
      this.onError?.(e)
    } finally {
      this.busy = false
    }
  }

  private async writeChunk(c: Uint8Array): Promise<void> {
    if (this.useWithout && this.writer.withoutResponse) {
      try {
        await this.writer.withoutResponse(c)
        return
      } catch (e) {
        // NotSupportedError: the characteristic or platform lacks it; switch for good
        if (!(typeof e === 'object' && e !== null && (e as { name?: string }).name === 'NotSupportedError')) throw e
        this.useWithout = false
      }
    }
    await this.writer.withResponse(c)
  }
}
