/* ============================================================
   CONSOLE RING BUFFER — the last 1000 lines of serial output,
   runtime errors and sandbox notes. Serial text arrives in chunks
   that need not end on a newline, so the last line can stay open.
   ============================================================ */

export const CONSOLE_CAP = 1000
const MAX_LINE_CHARS = 2000

export type ConsoleKind = 'out' | 'in' | 'info' | 'warn' | 'error' | 'sys'

export interface ConsoleLine {
  id: number
  kind: ConsoleKind
  text: string
  /** Virtual time the line started, ms. */
  tMs: number
}

export class ConsoleBuffer {
  private items: ConsoleLine[] = []
  /** The serial line still waiting for its newline, if it is the last line. */
  private open: ConsoleLine | null = null
  private nextId = 1
  /** Bumped on every change, for cheap UI subscriptions. */
  rev = 0

  get lines(): readonly ConsoleLine[] {
    return this.items
  }

  private add(kind: ConsoleKind, text: string, tMs: number): ConsoleLine {
    const line: ConsoleLine = { id: this.nextId++, kind, text: text.slice(0, MAX_LINE_CHARS), tMs }
    this.items.push(line)
    if (this.items.length > CONSOLE_CAP) this.items.splice(0, this.items.length - CONSOLE_CAP)
    return line
  }

  /** A whole line of non-serial output (closes any open serial line). */
  push(kind: ConsoleKind, text: string, tMs: number): void {
    this.open = null
    for (const part of text.split('\n')) this.add(kind, part, tMs)
    this.rev++
  }

  /** Serial text: "\r\n" and "\n" end lines; "\r" alone is dropped. */
  appendSerial(chunk: string, tMs: number): void {
    if (chunk.length === 0) return
    const parts = chunk.split('\n')
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i].replace(/\r/g, '')
      const last = i === parts.length - 1
      const open = this.open
      if (open && open === this.items[this.items.length - 1] && open.text.length + text.length <= MAX_LINE_CHARS) {
        const merged: ConsoleLine = { ...open, text: open.text + text }
        this.items[this.items.length - 1] = merged
        this.open = merged
      } else if (text.length > 0 || !last) {
        this.open = this.add('out', text, tMs)
      }
      if (!last) this.open = null
    }
    this.rev++
  }

  clear(): void {
    this.items = []
    this.open = null
    this.rev++
  }
}
