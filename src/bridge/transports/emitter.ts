import type { TransportEventState } from '../types'

/** Line, state and dropped-line listeners shared by every transport. */
export class TransportEvents {
  private readonly lineFns = new Set<(line: string) => void>()
  private readonly stateFns = new Set<(s: TransportEventState, detail?: string) => void>()
  private readonly dropFns = new Set<(bytes: number) => void>()

  onLine(fn: (line: string) => void): () => void {
    this.lineFns.add(fn)
    return () => this.lineFns.delete(fn)
  }

  onState(fn: (s: TransportEventState, detail?: string) => void): () => void {
    this.stateFns.add(fn)
    return () => this.stateFns.delete(fn)
  }

  /** The framer discarded a line longer than MAX_LINE_BYTES. */
  onDrop(fn: (bytes: number) => void): () => void {
    this.dropFns.add(fn)
    return () => this.dropFns.delete(fn)
  }

  line(l: string): void {
    for (const fn of this.lineFns) fn(l)
  }

  drop(bytes: number): void {
    for (const fn of this.dropFns) fn(bytes)
  }

  state(s: TransportEventState, detail?: string): void {
    for (const fn of this.stateFns) fn(s, detail)
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error'
}
