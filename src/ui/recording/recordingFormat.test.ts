import { describe, expect, it } from 'vitest'
import type { TelemetryFrame } from '../../core/types'
import {
  RECORDING_FORMAT,
  buildCsv,
  buildRecordingFile,
  cloneSnapshot,
  cloneTelemetry,
  escapeCsvText,
  formatCsvNumber,
  parseRecording,
  recordingFileName,
  sanitizeTelemetry,
  serializeRecording,
  type RecordingFrame,
} from './recordingFormat'

function tel(over: Partial<TelemetryFrame> = {}): TelemetryFrame {
  return { t: 0, gauges: { speed: 1 }, channels: { a: 0.5 }, bars: [0.1, 0.2], readouts: { gait: 'TRIPOD' }, ...over }
}

function frame(t: number, over: Partial<TelemetryFrame> = {}): RecordingFrame {
  return { t, snap: { x: t }, tel: { ...tel(over), t } }
}

describe('cloneTelemetry', () => {
  it('copies records and bars so later mutation of the source does not leak', () => {
    // Arrange
    const src = tel()
    // Act
    const copy = cloneTelemetry(src, 2.5)
    src.gauges.speed = 99
    src.bars[0] = 99
    // Assert
    expect(copy.t).toBe(2.5)
    expect(copy.gauges.speed).toBe(1)
    expect(copy.bars[0]).toBe(0.1)
  })
})

describe('cloneSnapshot', () => {
  it('deep-copies plain data and passes primitives through', () => {
    const src = { pose: [1, 2, 3] }
    const copy = cloneSnapshot(src) as { pose: number[] }
    src.pose[0] = 9
    expect(copy.pose[0]).toBe(1)
    expect(cloneSnapshot(5)).toBe(5)
    expect(cloneSnapshot(null)).toBeNull()
  })

  it('falls back to the original when the value is not clonable', () => {
    const src = { fn: () => 1 }
    expect(cloneSnapshot(src)).toBe(src)
  })
})

describe('CSV', () => {
  it('formats numbers compactly and drops non-finite values', () => {
    expect(formatCsvNumber(1.23456789)).toBe('1.234568')
    expect(formatCsvNumber(-0)).toBe('0')
    expect(formatCsvNumber(Number.NaN)).toBe('')
  })

  it('quotes text with separators and guards spreadsheet formulas', () => {
    expect(escapeCsvText('plain')).toBe('plain')
    expect(escapeCsvText('a,b')).toBe('"a,b"')
    expect(escapeCsvText('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCsvText('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(escapeCsvText('@cmd')).toBe(`"'@cmd"`)
  })

  it('writes t plus flattened gauges, channels, bars and readouts', () => {
    // Arrange
    const frames = [frame(0), frame(1 / 30, { bars: [0.3, 0.4, 0.5] })]
    // Act
    const lines = buildCsv(frames).trim().split('\n')
    // Assert
    expect(lines[0]).toBe('t,gauges.speed,channels.a,bars[0],bars[1],bars[2],readouts.gait')
    expect(lines[1]).toBe('0,1,0.5,0.1,0.2,,TRIPOD')
    expect(lines[2]).toBe('0.033333,1,0.5,0.3,0.4,0.5,TRIPOD')
  })

  it('unions keys across frames and leaves missing cells empty', () => {
    const frames = [frame(0, { gauges: { a: 1 } }), frame(1, { gauges: { b: 2 } })]
    const lines = buildCsv(frames).trim().split('\n')
    expect(lines[0].startsWith('t,gauges.a,gauges.b,')).toBe(true)
    expect(lines[1].startsWith('0,1,,')).toBe(true)
    expect(lines[2].startsWith('1,,2,')).toBe(true)
  })

  it('writes only a header for an empty recording', () => {
    expect(buildCsv([])).toBe('t\n')
  })
})

describe('parseRecording', () => {
  const now = new Date('2026-11-03T12:00:00.000Z')
  const good = (): string => serializeRecording(buildRecordingFile('walker', 'WALKER', 30, [frame(0), frame(0.5)], now))

  it('round-trips a recording built by the exporter', () => {
    // Act
    const res = parseRecording(good(), 'walker', 3600)
    // Assert
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.format).toBe(RECORDING_FORMAT)
    expect(res.value.frames).toHaveLength(2)
    expect(res.value.frames[1].snap).toEqual({ x: 0.5 })
    expect(res.value.frames[1].tel.readouts.gait).toBe('TRIPOD')
    expect(res.value.createdAt).toBe(now.toISOString())
  })

  it('rejects invalid JSON, foreign files and unknown versions', () => {
    expect(parseRecording('{oops', 'walker', 10)).toEqual({ ok: false, error: 'Not a valid JSON file.' })
    expect(parseRecording('{"format":"other"}', 'walker', 10).ok).toBe(false)
    const v2 = good().replace('"version":1', '"version":2')
    const res = parseRecording(v2, 'walker', 10)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('version 2')
  })

  it('rejects another robot kind with a message naming the robot to switch to', () => {
    const res = parseRecording(good(), 'sweeper', 3600)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('This recording is for WALKER. Switch to WALKER and import it again.')
  })

  it('rejects an unknown kind, empty frames and malformed frames', () => {
    const base = JSON.parse(good()) as Record<string, unknown>
    expect(parseRecording(JSON.stringify({ ...base, kind: 'tank' }), 'walker', 10).ok).toBe(false)
    expect(parseRecording(JSON.stringify({ ...base, frames: [] }), 'walker', 10).ok).toBe(false)
    expect(parseRecording(JSON.stringify({ ...base, frames: [{ t: 'x' }] }), 'walker', 10).ok).toBe(false)
    expect(parseRecording(JSON.stringify({ ...base, frames: [{ t: 0, tel: { gauges: {} } }] }), 'walker', 10).ok).toBe(false)
  })

  it('keeps only the newest maxFrames and sorts frames by time', () => {
    const file = buildRecordingFile('walker', 'W', 30, [frame(3), frame(1), frame(2), frame(0)], now)
    const res = parseRecording(serializeRecording(file), 'walker', 3)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.frames.map((f) => f.t)).toEqual([0, 1, 2])
  })
})

describe('sanitizeTelemetry', () => {
  it('drops non-finite numbers, unsafe keys and wrong types', () => {
    // Arrange
    const raw = JSON.parse(
      '{"gauges":{"a":1,"b":"x","__proto__":{"polluted":1}},"channels":{"c":null},"bars":[1,"y",null],"readouts":{"m":"ok","n":{}}}',
    ) as unknown
    // Act
    const out = sanitizeTelemetry(raw, 4)
    // Assert
    expect(out).toEqual({ t: 4, gauges: { a: 1 }, channels: {}, bars: [1, 0, 0], readouts: { m: 'ok' } })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('returns null when a record is missing', () => {
    expect(sanitizeTelemetry({ gauges: {}, channels: {}, readouts: {} }, 0)).toBeNull()
    expect(sanitizeTelemetry('nope', 0)).toBeNull()
  })
})

describe('recordingFileName', () => {
  it('builds a filesystem-safe name from kind and time', () => {
    expect(recordingFileName('swarm', 'csv', new Date('2026-11-03T12:30:05.000Z'))).toBe('simconsole-swarm-2026-11-03T12-30-05.csv')
  })
})
