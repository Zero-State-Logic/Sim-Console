import { LineFramer } from '../link/framing'
import type { Transport, TransportEventState } from '../types'
import { TransportEvents, errorText } from './emitter'

/* ============================================================
   WEB SERIAL (USB) — Chrome / Edge desktop over HTTPS or localhost.
   Read loop through a TextDecoderStream into the line framer;
   writes are tracked so a stalled board cannot grow an unbounded
   queue (non-critical lines are dropped past MAX_PENDING_BYTES).
   ============================================================ */

export const SERIAL_BUFFER = 8192
/**
 * Bytes in flight before non-critical lines are dropped: about PENDING_AIR_S of wire time
 * at the baud rate (UART = 10 bits per byte), within these bounds. A critical line (E-STOP)
 * queues behind whatever is in flight, so this bounds its delay: 4096 B is 45 ms at 921600
 * baud but 355 ms at 115200, hence the scaling.
 */
const PENDING_AIR_S = 0.05
const MIN_PENDING_BYTES = 512
const MAX_PENDING_BYTES = 4096

/** Non-critical write backlog for a baud rate, bytes. */
export function serialPendingCap(baud: number): number {
  const air = (Math.max(baud, 0) / 10) * PENDING_AIR_S
  return Math.round(Math.min(Math.max(air, MIN_PENDING_BYTES), MAX_PENDING_BYTES))
}

export class SerialTransport implements Transport {
  readonly id = 'serial' as const
  private readonly ev = new TransportEvents()
  private readonly framer = new LineFramer({ onLine: (l) => this.ev.line(l), onOversize: (b) => this.ev.drop(b) })
  private readonly encoder = new TextEncoder()
  private port: SerialPort | null = null
  private reader: ReadableStreamDefaultReader<string> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private pipeDone: Promise<void> | null = null
  private pending = 0
  private closing = false
  private readonly maxPending: number

  constructor(private readonly baudRate: number) {
    this.maxPending = serialPendingCap(baudRate)
  }

  isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator
  }

  async connect(): Promise<void> {
    const port = await navigator.serial.requestPort()
    await port.open({ baudRate: this.baudRate, bufferSize: SERIAL_BUFFER })
    if (!port.readable || !port.writable) {
      await port.close().catch(() => undefined)
      throw new Error('the serial port opened without streams')
    }
    this.port = port
    this.closing = false
    this.framer.reset()
    const decoder = new TextDecoderStream()
    this.pipeDone = port.readable.pipeTo(decoder.writable as WritableStream<Uint8Array>).catch(() => undefined)
    this.reader = decoder.readable.getReader()
    this.writer = port.writable.getWriter()
    navigator.serial.addEventListener('disconnect', this.onUsbDisconnect)
    void this.readLoop(this.reader)
  }

  async disconnect(): Promise<void> {
    this.closing = true
    navigator.serial?.removeEventListener('disconnect', this.onUsbDisconnect)
    const { reader, writer, port, pipeDone } = this
    this.reader = null
    this.writer = null
    this.port = null
    try {
      await reader?.cancel()
    } catch {
      /* already errored */
    }
    await pipeDone
    try {
      writer?.releaseLock()
    } catch {
      /* pending writes reject on release; nothing to do */
    }
    try {
      await port?.close()
    } catch {
      /* unplugged ports throw on close */
    }
    this.pending = 0
  }

  write(line: string, critical = false): boolean {
    const w = this.writer
    if (!w) return false
    const data = this.encoder.encode(`${line}\n`)
    if (!critical && this.pending + data.length > this.maxPending) return false
    this.pending += data.length
    w.write(data).then(
      () => void (this.pending -= data.length),
      (e: unknown) => {
        this.pending -= data.length
        this.fail(`write failed: ${errorText(e)}`)
      },
    )
    return true
  }

  onLine(fn: (line: string) => void): () => void {
    return this.ev.onLine(fn)
  }

  onState(fn: (s: TransportEventState, detail?: string) => void): () => void {
    return this.ev.onState(fn)
  }

  onDrop(fn: (bytes: number) => void): () => void {
    return this.ev.onDrop(fn)
  }

  private async readLoop(reader: ReadableStreamDefaultReader<string>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) this.framer.push(value)
      }
      if (!this.closing) this.fail('the serial stream ended')
    } catch (e) {
      // a BreakError / FramingError / unplug lands here
      if (!this.closing) this.fail(errorText(e))
    }
  }

  private readonly onUsbDisconnect = (e: Event): void => {
    if (e.target === this.port && !this.closing) this.fail('USB device unplugged')
  }

  private fail(detail: string): void {
    if (this.closing) return
    this.closing = true
    this.ev.state('closed', detail)
    void this.disconnect()
  }
}
