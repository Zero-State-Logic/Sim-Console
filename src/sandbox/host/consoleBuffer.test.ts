import { describe, expect, it } from 'vitest'
import { CONSOLE_CAP, ConsoleBuffer } from './consoleBuffer'
import { RateMeter } from './rate'

const texts = (b: ConsoleBuffer): string[] => b.lines.map((l) => l.text)

describe('ConsoleBuffer', () => {
  it('joins serial chunks into lines on \\r\\n', () => {
    // Arrange
    const b = new ConsoleBuffer()
    // Act
    b.appendSerial('hel', 0)
    b.appendSerial('lo\r\nwor', 10)
    b.appendSerial('ld\r\n', 20)
    // Assert
    expect(texts(b)).toEqual(['hello', 'world'])
    expect(b.lines[1].tMs).toBe(10)
  })

  it('keeps empty lines and drops lone carriage returns', () => {
    const b = new ConsoleBuffer()
    b.appendSerial('a\r\n\r\nb\rc', 0)
    expect(texts(b)).toEqual(['a', '', 'bc'])
  })

  it('closes an open serial line when a note is pushed', () => {
    const b = new ConsoleBuffer()
    b.appendSerial('partial', 0)
    b.push('warn', 'careful', 0)
    b.appendSerial(' more', 0)
    expect(texts(b)).toEqual(['partial', 'careful', ' more'])
    expect(b.lines.map((l) => l.kind)).toEqual(['out', 'warn', 'out'])
  })

  it('keeps only the newest 1000 lines', () => {
    const b = new ConsoleBuffer()
    for (let i = 0; i < CONSOLE_CAP + 25; i++) b.push('out', `line ${i}`, 0)
    expect(b.lines).toHaveLength(CONSOLE_CAP)
    expect(b.lines[0].text).toBe('line 25')
  })

  it('bumps rev on change and empties on clear', () => {
    const b = new ConsoleBuffer()
    const r0 = b.rev
    b.push('sys', 'x', 0)
    expect(b.rev).toBeGreaterThan(r0)
    b.clear()
    expect(b.lines).toHaveLength(0)
  })
})

describe('RateMeter', () => {
  it('measures events per second of sim time over the window', () => {
    const m = new RateMeter(1)
    for (let i = 0; i <= 120; i++) m.add(i / 60, 1)
    expect(m.rate()).toBeCloseTo(60, 6)
  })

  it('counts loops that only complete every other tick', () => {
    const m = new RateMeter(1)
    for (let i = 0; i <= 120; i++) m.add(i / 60, i % 2)
    expect(m.rate()).toBeCloseTo(30, 0)
  })

  it('is zero without enough samples and after reset', () => {
    const m = new RateMeter(1)
    expect(m.rate()).toBe(0)
    m.add(0, 1)
    expect(m.rate()).toBe(0)
    m.add(0.5, 1)
    m.reset()
    expect(m.rate()).toBe(0)
  })
})
