import type { RobotKind, TelemetryFrame } from '../../core/types'

/*
 * Recording file format, CSV export and import validation. Pure: no DOM, no three.js.
 * Imported files are untrusted, so every field is rebuilt from scratch with type checks
 * (never spread), and the opaque module snapshot is handed to module.restore(), which
 * must validate it.
 */

export const RECORDING_FORMAT = 'simconsole.recording'
export const RECORDING_VERSION = 1
/** Caps for untrusted input. */
const MAX_KEYS_PER_RECORD = 256
const MAX_KEY_LENGTH = 64
const MAX_STRING_LENGTH = 256
const MAX_BARS = 64
const ROBOT_KINDS: readonly RobotKind[] = ['walker', 'sweeper', 'swarm']
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export interface RecordingFrame {
  /** Sim time, seconds. */
  t: number
  /** module.snapshot() at that instant. */
  snap: unknown
  tel: TelemetryFrame
}

export interface RecordingFile {
  format: typeof RECORDING_FORMAT
  version: typeof RECORDING_VERSION
  kind: RobotKind
  label: string
  createdAt: string
  hz: number
  frames: RecordingFrame[]
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

/* ---------------- cloning (capture side) ---------------- */

/** Copy a telemetry frame so later in-place mutation by the module can't alter history. */
export function cloneTelemetry(tel: TelemetryFrame, t: number): TelemetryFrame {
  return {
    t,
    gauges: { ...tel.gauges },
    channels: { ...tel.channels },
    bars: tel.bars.slice(),
    readouts: { ...tel.readouts },
  }
}

/** Deep copy of a snapshot. Falls back to the original if it isn't structured-clonable. */
export function cloneSnapshot(snap: unknown): unknown {
  if (snap === null || typeof snap !== 'object') return snap
  try {
    return structuredClone(snap)
  } catch {
    return snap
  }
}

/* ---------------- CSV ---------------- */

interface CsvColumns {
  gauges: string[]
  channels: string[]
  bars: number
  readouts: string[]
}

function collectColumns(frames: readonly RecordingFrame[]): CsvColumns {
  const gauges = new Set<string>()
  const channels = new Set<string>()
  const readouts = new Set<string>()
  let bars = 0
  for (const f of frames) {
    for (const k of Object.keys(f.tel.gauges)) gauges.add(k)
    for (const k of Object.keys(f.tel.channels)) channels.add(k)
    for (const k of Object.keys(f.tel.readouts)) readouts.add(k)
    bars = Math.max(bars, f.tel.bars.length)
  }
  return { gauges: [...gauges], channels: [...channels], bars, readouts: [...readouts] }
}

/** Number → compact decimal (max 6 places, no exponent for normal telemetry ranges). */
export function formatCsvNumber(v: number): string {
  if (!Number.isFinite(v)) return ''
  const r = Math.round(v * 1e6) / 1e6
  return Object.is(r, -0) ? '0' : String(r)
}

/**
 * Quote a CSV text cell. Cells that a spreadsheet would run as a formula (=, +, -, @,
 * tab, CR) get a leading apostrophe so an imported recording can't smuggle formulas.
 */
export function escapeCsvText(s: string): string {
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(guarded) || guarded !== s ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

function cell(v: number | string | undefined): string {
  if (v === undefined) return ''
  return typeof v === 'number' ? formatCsvNumber(v) : escapeCsvText(v)
}

/** t + gauges.* + channels.* + bars[i] + readouts.*, one row per frame. */
export function buildCsv(frames: readonly RecordingFrame[]): string {
  const cols = collectColumns(frames)
  const header = [
    't',
    ...cols.gauges.map((k) => `gauges.${k}`),
    ...cols.channels.map((k) => `channels.${k}`),
    ...Array.from({ length: cols.bars }, (_, i) => `bars[${i}]`),
    ...cols.readouts.map((k) => `readouts.${k}`),
  ]
  const lines = [header.map(escapeCsvText).join(',')]
  for (const f of frames) {
    const row: string[] = [formatCsvNumber(f.t)]
    for (const k of cols.gauges) row.push(cell(f.tel.gauges[k]))
    for (const k of cols.channels) row.push(cell(f.tel.channels[k]))
    for (let i = 0; i < cols.bars; i++) row.push(cell(f.tel.bars[i]))
    for (const k of cols.readouts) row.push(cell(f.tel.readouts[k]))
    lines.push(row.join(','))
  }
  return lines.join('\n') + '\n'
}

/* ---------------- JSON ---------------- */

export function buildRecordingFile(
  kind: RobotKind,
  label: string,
  hz: number,
  frames: readonly RecordingFrame[],
  now: Date = new Date(),
): RecordingFile {
  return {
    format: RECORDING_FORMAT,
    version: RECORDING_VERSION,
    kind,
    label,
    createdAt: now.toISOString(),
    hz,
    frames: frames.slice(),
  }
}

export function serializeRecording(file: RecordingFile): string {
  return JSON.stringify(file)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function safeKey(k: string): boolean {
  return k.length > 0 && k.length <= MAX_KEY_LENGTH && !UNSAFE_KEYS.has(k)
}

function numberRecord(v: unknown): Record<string, number> | null {
  if (!isRecord(v)) return null
  const out: Record<string, number> = {}
  let n = 0
  for (const k of Object.keys(v)) {
    const x = v[k]
    if (!safeKey(k) || typeof x !== 'number' || !Number.isFinite(x)) continue
    out[k] = x
    if (++n >= MAX_KEYS_PER_RECORD) break
  }
  return out
}

function readoutRecord(v: unknown): Record<string, number | string> | null {
  if (!isRecord(v)) return null
  const out: Record<string, number | string> = {}
  let n = 0
  for (const k of Object.keys(v)) {
    const x = v[k]
    if (!safeKey(k)) continue
    if (typeof x === 'number' && Number.isFinite(x)) out[k] = x
    else if (typeof x === 'string') out[k] = x.slice(0, MAX_STRING_LENGTH)
    else continue
    if (++n >= MAX_KEYS_PER_RECORD) break
  }
  return out
}

/** Rebuild a telemetry frame from untrusted input. Returns null if the shape is wrong. */
export function sanitizeTelemetry(v: unknown, t: number): TelemetryFrame | null {
  if (!isRecord(v)) return null
  const gauges = numberRecord(v.gauges)
  const channels = numberRecord(v.channels)
  const readouts = readoutRecord(v.readouts)
  if (!gauges || !channels || !readouts || !Array.isArray(v.bars)) return null
  const bars: number[] = []
  for (const b of v.bars.slice(0, MAX_BARS)) bars.push(typeof b === 'number' && Number.isFinite(b) ? b : 0)
  return { t, gauges, channels, bars, readouts }
}

function kindLabel(k: RobotKind): string {
  return k.toUpperCase()
}

/**
 * Parse and validate a recording file. `expectedKind` is the active robot; other kinds
 * are rejected with a message telling the user which robot to switch to.
 */
export function parseRecording(text: string, expectedKind: RobotKind, maxFrames: number): ParseResult<RecordingFile> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'Not a valid JSON file.' }
  }
  if (!isRecord(raw) || raw.format !== RECORDING_FORMAT) return { ok: false, error: 'Not a SIM CONSOLE recording.' }
  if (raw.version !== RECORDING_VERSION) return { ok: false, error: `Unsupported recording version ${String(raw.version)}.` }
  const kind = raw.kind
  if (typeof kind !== 'string' || !ROBOT_KINDS.includes(kind as RobotKind)) return { ok: false, error: 'Recording names an unknown robot.' }
  if (kind !== expectedKind) {
    return { ok: false, error: `This recording is for ${kindLabel(kind as RobotKind)}. Switch to ${kindLabel(kind as RobotKind)} and import it again.` }
  }
  if (!Array.isArray(raw.frames) || raw.frames.length === 0) return { ok: false, error: 'Recording has no frames.' }

  const frames: RecordingFrame[] = []
  const src = raw.frames.length > maxFrames ? raw.frames.slice(raw.frames.length - maxFrames) : raw.frames
  for (const f of src) {
    if (!isRecord(f) || typeof f.t !== 'number' || !Number.isFinite(f.t)) return { ok: false, error: 'Recording has a malformed frame.' }
    const tel = sanitizeTelemetry(f.tel, f.t)
    if (!tel) return { ok: false, error: `Frame at t=${formatCsvNumber(f.t)} s has malformed telemetry.` }
    frames.push({ t: f.t, snap: f.snap ?? null, tel })
  }
  frames.sort((a, b) => a.t - b.t)

  const hz = typeof raw.hz === 'number' && Number.isFinite(raw.hz) && raw.hz > 0 ? raw.hz : 30
  const label = typeof raw.label === 'string' ? raw.label.slice(0, MAX_KEY_LENGTH) : kindLabel(kind as RobotKind)
  const createdAt = typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt)) ? raw.createdAt : new Date(0).toISOString()
  return {
    ok: true,
    value: { format: RECORDING_FORMAT, version: RECORDING_VERSION, kind: kind as RobotKind, label, createdAt, hz, frames },
  }
}

/** File name like simconsole-walker-2026-11-03T12-30-05.csv */
export function recordingFileName(kind: RobotKind, ext: 'csv' | 'json', now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-')
  return `simconsole-${kind}-${stamp}.${ext}`
}
