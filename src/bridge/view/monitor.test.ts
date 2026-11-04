import { describe, expect, it } from 'vitest'
import type { LogEntry } from '../types'
import { ALL_DIRS, LineHistory, QUICK_LINES, compileFilter, dirMark, exportFileName, formatTs, lineClass } from './monitor'

function entry(dir: LogEntry['dir'], text: string, tag?: LogEntry['tag']): LogEntry {
  return { id: 1, ts: 0, dir, text, tag }
}

describe('compileFilter', () => {
  it('matches a case-insensitive substring and excludes with a leading !', () => {
    // Arrange
    const has = compileFilter({ text: 'TEL', dirs: ALL_DIRS })
    const not = compileFilter({ text: '!tel', dirs: ALL_DIRS })
    // Act / Assert
    expect(has(entry('rx', '{"t":"tel","ms":1}'))).toBe(true)
    expect(has(entry('rx', '{"t":"pong","id":1}'))).toBe(false)
    expect(not(entry('rx', '{"t":"tel","ms":1}'))).toBe(false)
    expect(not(entry('rx', '{"t":"pong","id":1}'))).toBe(true)
  })

  it('hides directions that are switched off and passes everything with an empty filter', () => {
    // Arrange
    const f = compileFilter({ text: '  ', dirs: { rx: true, tx: false, sys: true } })
    // Act / Assert
    expect(f(entry('rx', 'a'))).toBe(true)
    expect(f(entry('tx', 'a'))).toBe(false)
    expect(f(entry('sys', 'a'))).toBe(true)
  })
})

describe('line presentation', () => {
  it('styles by tag first, then by direction', () => {
    expect(lineClass(entry('rx', 'x', 'err'))).toBe('err')
    expect(lineClass(entry('rx', 'x', 'warn'))).toBe('warn')
    expect(lineClass(entry('rx', 'x', 'invalid'))).toBe('invalid')
    expect(lineClass(entry('tx', 'x'))).toBe('tx')
    expect(dirMark('rx')).toBe('←')
    expect(dirMark('tx')).toBe('→')
    expect(dirMark('sys')).toBe('·')
  })

  it('formats timestamps as aligned seconds with millisecond resolution', () => {
    expect(formatTs(12345.6)).toBe('  12.346')
    expect(formatTs(-5)).toBe('   0.000')
  })

  it('names exports with the local date and time', () => {
    expect(exportFileName(new Date(2026, 10, 3, 9, 5, 7))).toBe('simconsole-serial-20261103-090507.ndjson')
  })

  it('ships quick lines that are valid protocol JSON', () => {
    for (const q of QUICK_LINES) expect(typeof (JSON.parse(q.line) as { t: unknown }).t).toBe('string')
  })
})

describe('LineHistory', () => {
  it('recalls older lines with prev, newer with next, and blanks past the newest', () => {
    // Arrange
    const h = new LineHistory()
    h.push('a')
    h.push('b')
    h.push('c')
    // Act / Assert
    expect(h.prev()).toBe('c')
    expect(h.prev()).toBe('b')
    expect(h.prev()).toBe('a')
    expect(h.prev()).toBe('a')
    expect(h.next()).toBe('b')
    expect(h.next()).toBe('c')
    expect(h.next()).toBe('')
  })

  it('moves a repeated line to the end, ignores empty lines and caps its size', () => {
    // Arrange
    const h = new LineHistory(3)
    // Act
    h.push('a')
    h.push('b')
    h.push('a')
    h.push('')
    h.push('c')
    h.push('d')
    // Assert
    expect(h.size).toBe(3)
    expect(h.prev()).toBe('d')
    expect(h.prev()).toBe('c')
    expect(h.prev()).toBe('a')
    expect(h.prev()).toBe('a')
  })

  it('returns null when empty', () => {
    const h = new LineHistory()
    expect(h.prev()).toBeNull()
    expect(h.next()).toBeNull()
  })
})
