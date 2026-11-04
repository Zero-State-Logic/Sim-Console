import type { LogDir, LogEntry } from '../types'

/* ============================================================
   SERIAL MONITOR MODEL — filtering, line styling, timestamps and
   the export file name. Pure; the React view only renders.
   ============================================================ */

/** Lines kept in the DOM at once (the ring holds 2000). */
export const MONITOR_RENDER_LIMIT = 500

export interface MonitorFilter {
  /** Case-insensitive substring; a leading '!' excludes matches instead. */
  text: string
  dirs: Record<LogDir, boolean>
}

export const ALL_DIRS: Record<LogDir, boolean> = { rx: true, tx: true, sys: true }

/** Compile a filter once per render into a fast predicate. */
export function compileFilter(f: MonitorFilter): (e: LogEntry) => boolean {
  const raw = f.text.trim()
  const negate = raw.startsWith('!')
  const needle = (negate ? raw.slice(1) : raw).toLowerCase()
  const { rx, tx, sys } = f.dirs
  return (e) => {
    if (!(e.dir === 'rx' ? rx : e.dir === 'tx' ? tx : sys)) return false
    if (needle.length === 0) return true
    const hit = e.text.toLowerCase().includes(needle)
    return negate ? !hit : hit
  }
}

/** CSS class for a line: direction, overridden by its tag (invalid / warn / err). */
export function lineClass(e: LogEntry): string {
  if (e.tag === 'err') return 'err'
  if (e.tag === 'warn') return 'warn'
  if (e.tag === 'invalid') return 'invalid'
  return e.dir
}

/** Direction marker shown before each line. */
export function dirMark(dir: LogDir): string {
  return dir === 'rx' ? '←' : dir === 'tx' ? '→' : '·'
}

/** Bridge-clock ms as seconds with millisecond resolution, padded to align: '  12.345'. */
export function formatTs(ms: number): string {
  const s = Math.max(0, ms) / 1000
  return s.toFixed(3).padStart(8, ' ')
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** simconsole-serial-20261103-134501.ndjson */
export function exportFileName(d: Date): string {
  const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  return `simconsole-serial-${date}-${time}.ndjson`
}

/** Quick-send presets for the send-line box. */
export const QUICK_LINES: readonly { label: string; line: string }[] = [
  { label: 'hello?', line: '{"t":"hello?"}' },
  { label: 'ping', line: '{"t":"ping","id":1}' },
  { label: 'home', line: '{"t":"home"}' },
]

/** A bounded send history with shell-style up/down recall. */
export class LineHistory {
  private items: string[] = []
  private cursor = 0

  constructor(private readonly cap = 50) {}

  push(line: string): void {
    if (line.length === 0) return
    this.items = this.items.filter((x) => x !== line)
    this.items.push(line)
    if (this.items.length > this.cap) this.items.shift()
    this.cursor = this.items.length
  }

  /** Older entry (ArrowUp); stays on the oldest. */
  prev(): string | null {
    if (this.items.length === 0) return null
    this.cursor = Math.max(0, this.cursor - 1)
    return this.items[this.cursor]
  }

  /** Newer entry (ArrowDown); '' past the newest. */
  next(): string | null {
    if (this.items.length === 0) return null
    this.cursor = Math.min(this.items.length, this.cursor + 1)
    return this.cursor === this.items.length ? '' : this.items[this.cursor]
  }

  get size(): number {
    return this.items.length
  }
}
