import type { SandboxFnDef } from '../../core/types'
import type { Dialect } from '../protocol'
import type { Param, ShimFn } from '../shim/reference'
import type { ProgramState, SandboxStats } from '../store'

/* Pure text helpers for the sandbox UI (no React, unit-tested). */

export const DIALECT_LABEL: Record<Dialect, string> = { cpp: 'ARDUINO C++', js: 'JAVASCRIPT' }
export const FILE_EXT: Record<Dialect, string> = { cpp: 'ino', js: 'js' }

export interface StatusView {
  label: string
  /** Pill tone: 'live' pulses orange, 'err' is red, 'idle' is quiet. */
  tone: 'idle' | 'busy' | 'live' | 'hold' | 'err'
}

export function statusView(state: ProgramState): StatusView {
  switch (state) {
    case 'idle':
      return { label: 'PROGRAM IDLE', tone: 'idle' }
    case 'compiling':
      return { label: 'COMPILING', tone: 'busy' }
    case 'running':
      return { label: 'PROGRAM RUNNING', tone: 'live' }
    case 'sleeping':
      return { label: 'RUNNING · IN delay()', tone: 'live' }
    case 'paused':
      return { label: 'PAUSED', tone: 'hold' }
    case 'error':
      return { label: 'ERROR', tone: 'err' }
    case 'stopped':
      return { label: 'STOPPED', tone: 'idle' }
  }
}

/** Second line under the status pill. */
export function statusDetail(state: ProgramState, wakeAtMs: number | null, dirty: boolean): string {
  if (state === 'idle') return 'press RUN to compile and start'
  if (state === 'compiling') return 'checking and building the program'
  if (state === 'sleeping' && wakeAtMs !== null) return `wakes at ${(wakeAtMs / 1000).toFixed(2)} s sim time`
  if ((state === 'running' || state === 'sleeping' || state === 'paused') && dirty) return 'editor changed: RUN reloads'
  if (state === 'paused') return 'STEP runs one frame'
  if (state === 'error') return 'see CONSOLE for details'
  if (state === 'stopped') return 'robot handed back to the sim'
  return 'one frame of latency, like a real loop'
}

export function fmtMs(ms: number | null): string {
  if (ms === null) return '—'
  return ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : ms.toFixed(0)
}

export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`
  return n.toLocaleString('en-US')
}

export interface StatCell {
  label: string
  value: string
  unit: string
}

export function statCells(stats: SandboxStats, dialect: Dialect, line: number): StatCell[] {
  return [
    { label: dialect === 'cpp' ? 'COMPILE' : 'LOAD', value: fmtMs(stats.compileMs), unit: 'ms' },
    { label: 'INSTR / TICK', value: dialect === 'cpp' && stats.ticks > 0 ? fmtCount(stats.instrPerTick) : '—', unit: '' },
    { label: 'LOOP RATE', value: stats.ticks > 0 ? stats.loopHz.toFixed(1) : '—', unit: 'Hz' },
    { label: 'LINE', value: line > 0 ? String(line) : '—', unit: '' },
  ]
}

/* ---------------- API reference ---------------- */

function cppType(t: Param[1]): string {
  return t === 'string' ? 'String' : t === 'any' ? 'auto' : t === 'unsigned' ? 'unsigned long' : t
}

export function robotSignature(f: SandboxFnDef, dialect: Dialect): string {
  const params = f.params.join(', ')
  if (dialect === 'js') return `${f.name}(${params})${f.kind === 'query' ? ' → number' : ''}`
  return `${f.kind === 'query' ? 'float' : 'void'} ${f.name}(${params})`
}

export function shimSignature(f: ShimFn, dialect: Dialect, owner?: string): string {
  const name = owner ? `${owner}.${f.name}` : f.name
  const req = f.params.length - (f.optional ?? 0)
  const parts = f.params.map((p, i) => {
    const txt = dialect === 'cpp' ? `${cppType(p[1])} ${p[0]}` : p[0]
    return i >= req ? `[${txt}]` : txt
  })
  const ret = f.returns === 'void' ? '' : f.returns
  if (dialect === 'js') return `${name}(${parts.join(', ')})${ret ? ' → ' + (ret === 'string' ? 'string' : ret === 'bool' ? 'boolean' : 'number') : ''}`
  return `${cppType(f.returns)} ${name}(${parts.join(', ')})`
}

/** Text inserted into the editor when an API entry is clicked. */
export function robotSnippet(f: SandboxFnDef, dialect: Dialect): string {
  const call = `${f.name}(${f.params.map(() => '0').join(', ')})`
  return f.kind === 'command' && dialect === 'cpp' ? `${call};` : call
}

/** Diagnostic counts for the editor header, e.g. "2 errors · 1 warning". */
export function diagSummary(diags: readonly { severity: 'error' | 'warning' }[]): string {
  const e = diags.filter((d) => d.severity === 'error').length
  const w = diags.length - e
  const parts: string[] = []
  if (e > 0) parts.push(`${e} error${e === 1 ? '' : 's'}`)
  if (w > 0) parts.push(`${w} warning${w === 1 ? '' : 's'}`)
  return parts.length > 0 ? parts.join(' · ') : 'no problems'
}
