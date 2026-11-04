import { MAX_INPUT_CHARS, MAX_SERIAL_PER_TICK } from '../protocol'

/* ============================================================
   VIRTUAL SERIAL PORT — output chunks for the console (capped per
   tick, like a real UART can only move so many bytes per frame)
   and an input buffer the console feeds for Serial.read().
   ============================================================ */

const TRUNCATED = '\r\n[serial output cut: over 8192 characters in one frame]\r\n'

export class SerialPort {
  private out: string[] = []
  private outChars = 0
  private cut = false
  private input = ''
  baud = 0

  /** Raw write (print / println / write all land here). Returns characters accepted. */
  write(text: string): number {
    if (text.length === 0) return 0
    if (this.cut) return 0
    const room = MAX_SERIAL_PER_TICK - this.outChars
    if (text.length > room) {
      if (room > 0) this.out.push(text.slice(0, room))
      this.out.push(TRUNCATED)
      this.outChars = MAX_SERIAL_PER_TICK
      this.cut = true
      return Math.max(room, 0)
    }
    this.out.push(text)
    this.outChars += text.length
    return text.length
  }

  /** Output since the last call; resets the per-tick cap. */
  take(): string[] {
    const chunks = this.out
    this.out = []
    this.outChars = 0
    this.cut = false
    return chunks
  }

  feed(text: string): void {
    this.input = (this.input + text).slice(-MAX_INPUT_CHARS)
  }

  available(): number {
    return this.input.length
  }

  /** Next byte, or -1 when the buffer is empty. */
  read(): number {
    if (this.input.length === 0) return -1
    const c = this.input.charCodeAt(0) & 0xff
    this.input = this.input.slice(1)
    return c
  }

  peek(): number {
    return this.input.length === 0 ? -1 : this.input.charCodeAt(0) & 0xff
  }

  readString(): string {
    const s = this.input
    this.input = ''
    return s
  }

  /** Up to (not including) the terminator, which is consumed. */
  readStringUntil(term: string): string {
    const i = term.length > 0 ? this.input.indexOf(term[0]) : -1
    if (i < 0) return this.readString()
    const s = this.input.slice(0, i)
    this.input = this.input.slice(i + 1)
    return s
  }

  /** Stream::parseInt without the timeout: skip to the first digit or '-', read digits. */
  parseInt(): number {
    const m = /-?\d+/.exec(this.input)
    if (!m) {
      this.input = ''
      return 0
    }
    this.input = this.input.slice(m.index + m[0].length)
    return Number(m[0]) | 0
  }

  parseFloat(): number {
    const m = /-?(?:\d+\.?\d*|\.\d+)/.exec(this.input)
    if (!m) {
      this.input = ''
      return 0
    }
    this.input = this.input.slice(m.index + m[0].length)
    return Number(m[0])
  }

  reset(): void {
    this.out = []
    this.outChars = 0
    this.cut = false
    this.input = ''
    this.baud = 0
  }
}
