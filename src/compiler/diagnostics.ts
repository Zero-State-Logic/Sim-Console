/* ============================================================
   DIAGNOSTICS — collected across every compiler stage, 1-based
   line/col ranges, plus "did you mean" suggestions by edit distance.
   ============================================================ */

import type { Diagnostic } from './api'

export interface Span {
  line: number
  col: number
  endLine: number
  endCol: number
}

/** Hard cap so a pathological file cannot flood the editor. */
const MAX_DIAGNOSTICS = 100

export class DiagBag {
  readonly items: Diagnostic[] = []
  private errorCount = 0

  error(span: Span, message: string): void {
    this.errorCount++
    this.push('error', span, message)
  }

  warning(span: Span, message: string): void {
    this.push('warning', span, message)
  }

  get hasErrors(): boolean {
    return this.errorCount > 0
  }

  get full(): boolean {
    return this.items.length >= MAX_DIAGNOSTICS
  }

  /** Diagnostics ordered by position (stages report in their own order). */
  sorted(): Diagnostic[] {
    return [...this.items].sort((a, b) => a.line - b.line || a.col - b.col)
  }

  private push(severity: Diagnostic['severity'], s: Span, message: string): void {
    // the same message at the same place twice is noise (e.g. a macro expanded twice)
    const dup = this.items.some((d) => d.line === s.line && d.col === s.col && d.message === message)
    if (dup) return
    if (this.items.length >= MAX_DIAGNOSTICS) {
      // a failed compile must always show an error: it takes the place of the last warning
      const w = severity === 'error' ? this.lastWarning() : -1
      if (w < 0) return
      this.items.splice(w, 1)
    }
    this.items.push({ severity, message, line: s.line, col: s.col, endLine: s.endLine, endCol: s.endCol })
  }

  private lastWarning(): number {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].severity === 'warning') return i
    return -1
  }
}

export function spanOf(a: Span, b: Span = a): Span {
  return { line: a.line, col: a.col, endLine: b.endLine, endCol: b.endCol }
}

/** Edit distance with adjacent transpositions ("cuont" → "count" is 1); a case slip costs 0.5. */
export function editDistance(a: string, b: string): number {
  const la = a.length
  const lb = b.length
  if (la === 0) return lb
  if (lb === 0) return la
  const d: number[][] = []
  for (let i = 0; i <= la; i++) d.push(new Array<number>(lb + 1).fill(0))
  for (let i = 0; i <= la; i++) d[i][0] = i
  for (let j = 0; j <= lb; j++) d[0][j] = j
  for (let i = 1; i <= la; i++) {
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= lb; j++) {
      const cb = b.charCodeAt(j - 1)
      const cost = ca === cb ? 0 : (ca | 32) === (cb | 32) && isLetter(ca) ? 0.5 : 1
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb) v = Math.min(v, d[i - 2][j - 2] + 1)
      d[i][j] = v
    }
  }
  return d[la][lb]
}

function isLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
}

/** Closest candidate within a length-scaled threshold, or null. */
export function suggest(name: string, candidates: Iterable<string>): string | null {
  const limit = Math.max(1, Math.floor(name.length / 3))
  let best: string | null = null
  let bestD = Infinity
  for (const c of candidates) {
    if (c === name || c.startsWith('__')) continue
    if (Math.abs(c.length - name.length) > limit) continue
    const d = editDistance(name, c)
    if (d <= limit && d < bestD) {
      best = c
      bestD = d
    }
  }
  return best
}

export function didYouMean(name: string, candidates: Iterable<string>): string {
  const s = suggest(name, candidates)
  return s ? ` Did you mean '${s}'?` : ''
}
