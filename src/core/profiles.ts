import { BOARDS, defaultHardwareConfig, defaultServoPins, type HardwareConfig } from './hardware'
import type { BoardId, TransportId } from './protocol'
import type { ControlDef, ControlValue, HardwareSpec, RobotKind } from './types'

/*
 * Robot profiles: control values + module config + hardware config, saved in
 * localStorage and exchanged as JSON files. Everything read back (storage or file) is
 * untrusted: each field is rebuilt with type and range checks, never spread. Applying a
 * profile goes through an injected ProfileTarget, so this file stays free of the
 * runtime and is testable in Node.
 */

export const PROFILE_VERSION = 1
export const PROFILE_STORAGE_KEY = 'simconsole.profiles.v1'
export const PROFILE_NAME_MAX = 48
export const MAX_PROFILES = 100
/** Momentary controls a profile never captures (they would make the robot drive on load). */
export const TRANSIENT_KEYS: readonly string[] = ['dir', 'turn']
const MAX_JOINTS = 64
const MAX_CONTROLS = 200
const MAX_CONFIG_CHARS = 200_000
const ROBOT_KINDS: readonly RobotKind[] = ['walker', 'sweeper', 'swarm']
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export interface RobotProfile {
  version: 1
  name: string
  kind: RobotKind
  /** ISO 8601. */
  createdAt: string
  controls: Record<string, ControlValue>
  /** module.serializeConfig() */
  config: unknown
  hardware: HardwareConfig
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isRobotKind(v: unknown): v is RobotKind {
  return typeof v === 'string' && ROBOT_KINDS.includes(v as RobotKind)
}

/** Trim, drop control characters, collapse whitespace, cap length. */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, PROFILE_NAME_MAX)
}

/* ---------------- control values ---------------- */

function stepDecimals(step: number): number {
  const s = String(step)
  const i = s.indexOf('.')
  return i < 0 ? 0 : Math.min(s.length - i - 1, 10)
}

/** Clamp to [min, max] and snap to the slider grid anchored at min. */
export function clampSlider(v: number, min: number, max: number, step: number): number {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  let x = Math.min(Math.max(v, lo), hi)
  if (step > 0 && Number.isFinite(step)) {
    x = lo + Math.round((x - lo) / step) * step
    x = Number(x.toFixed(Math.max(stepDecimals(step), stepDecimals(lo))))
    x = Math.min(Math.max(x, lo), hi)
  }
  return x
}

/** A value checked against its live control definition, or undefined if it can't apply. */
export function sanitizeControlValue(def: ControlDef, raw: unknown): ControlValue | undefined {
  switch (def.type) {
    case 'slider':
      return typeof raw === 'number' && Number.isFinite(raw) ? clampSlider(raw, def.min, def.max, def.step) : undefined
    case 'select':
      return typeof raw === 'string' && def.options.some((o) => o.value === raw) ? raw : undefined
    case 'toggle':
      return typeof raw === 'boolean' ? raw : undefined
    case 'button':
      return undefined
  }
}

/** Primitive control values from untrusted input (no schema yet: types only). */
function sanitizeControlRecord(raw: unknown): Record<string, ControlValue> {
  const out: Record<string, ControlValue> = {}
  if (!isRecord(raw)) return out
  let n = 0
  for (const k of Object.keys(raw)) {
    const v = raw[k]
    if (UNSAFE_KEYS.has(k) || k.length > 64) continue
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string') out[k] = v.slice(0, 128)
    else continue
    if (++n >= MAX_CONTROLS) break
  }
  return out
}

/* ---------------- hardware config ---------------- */

function num(v: unknown, fallback: number, lo: number, hi: number, int = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  const x = Math.min(Math.max(v, lo), hi)
  return int ? Math.round(x) : x
}

function str(v: unknown, fallback: string, max: number, ok: (s: string) => boolean = () => true): string {
  if (typeof v !== 'string') return fallback
  const s = v.slice(0, max)
  return ok(s) ? s : fallback
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && allowed.includes(v as T) ? (v as T) : fallback
}

function arr<T>(v: unknown, n: number, fill: (i: number) => T, pick: (x: unknown, i: number) => T | undefined): T[] {
  const src = Array.isArray(v) ? v : []
  return Array.from({ length: n }, (_, i) => (i < src.length ? pick(src[i], i) : undefined) ?? fill(i))
}

/**
 * Rebuild a hardware config from untrusted input on top of defaults. Per-joint arrays are
 * fitted to `joints` (saved entries kept, the rest default).
 */
export function sanitizeHardwareConfig(raw: unknown, joints: number): HardwareConfig {
  const r = isRecord(raw) ? raw : {}
  const n = Math.min(Math.max(Math.round(joints) || 1, 1), MAX_JOINTS)
  const board = oneOf<BoardId>(r.board, Object.keys(BOARDS) as BoardId[], 'esp32')
  const base = defaultHardwareConfig(board, n)
  const info = BOARDS[board]
  // a Linux board (Pi) has no servo GPIO in the generated daemon: always PCA9685
  const servoDriver = info.kind === 'linux' ? 'pca9685' : oneOf(r.servoDriver, ['gpio', 'pca9685'] as const, base.servoDriver)
  const transports: readonly TransportId[] = [...info.transports, 'loopback']
  const defaultPins = defaultServoPins(board, servoDriver, n)
  const servoMinUs = num(r.servoMinUs, base.servoMinUs, 300, 2900, true)
  return {
    board,
    transport: oneOf(r.transport, transports, base.transport),
    baud: num(r.baud, base.baud, 300, 4_000_000, true),
    bleName: str(r.bleName, base.bleName, 29, (s) => /^[\x20-\x7e]+$/.test(s)),
    wsUrl: str(r.wsUrl, base.wsUrl, 200, (s) => /^wss?:\/\/[^\s]+$/.test(s)),
    wifiMode: oneOf(r.wifiMode, ['sta', 'ap'] as const, base.wifiMode),
    wifiSsid: str(r.wifiSsid, base.wifiSsid, 32, (s) => /^[\x20-\x7e]*$/.test(s)),
    servoDriver,
    servoPins: arr(r.servoPins, n, (i) => defaultPins[i], (x) =>
      typeof x === 'number' && Number.isInteger(x) && x >= -1 && x < 64 ? x : undefined),
    servoMinUs,
    servoMaxUs: num(r.servoMaxUs, Math.max(base.servoMaxUs, servoMinUs + 100), servoMinUs + 100, 3000, true),
    servoRangeDeg: num(r.servoRangeDeg, base.servoRangeDeg, 60, 360),
    jointInvert: arr(r.jointInvert, n, () => false, (x) => (typeof x === 'boolean' ? x : undefined)),
    jointOffsetDeg: arr(r.jointOffsetDeg, n, () => 0, (x) =>
      typeof x === 'number' && Number.isFinite(x) ? Math.min(Math.max(x, -90), 90) : undefined),
    jointScale: arr(r.jointScale, n, () => 1, (x) =>
      typeof x === 'number' && Number.isFinite(x) ? Math.min(Math.max(x, 0.25), 4) : undefined),
    commandHz: num(r.commandHz, base.commandHz, 1, 200),
    telemetryHz: num(r.telemetryHz, base.telemetryHz, 1, 200),
    watchdogMs: num(r.watchdogMs, base.watchdogMs, 50, 10_000, true),
    watchdogAction: oneOf(r.watchdogAction, ['hold', 'relax'] as const, base.watchdogAction),
  }
}

/* ---------------- whole profile ---------------- */

/** JSON round-trip: a plain, serializable, size-capped copy of module config. */
export function sanitizeConfig(raw: unknown): unknown {
  if (raw === undefined) return null
  try {
    const text = JSON.stringify(raw)
    if (text === undefined || text.length > MAX_CONFIG_CHARS) return null
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export function validateProfile(raw: unknown): Result<RobotProfile> {
  if (!isRecord(raw)) return { ok: false, error: 'Profile is not an object.' }
  if (raw.version !== PROFILE_VERSION) return { ok: false, error: `Unsupported profile version ${String(raw.version)}.` }
  if (!isRobotKind(raw.kind)) return { ok: false, error: 'Profile names an unknown robot.' }
  const name = sanitizeName(raw.name)
  if (!name) return { ok: false, error: 'Profile has no name.' }
  const hw = isRecord(raw.hardware) ? raw.hardware : {}
  const joints = Array.isArray(hw.servoPins) ? hw.servoPins.length : 1
  const createdAt = typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt)) ? raw.createdAt : new Date(0).toISOString()
  return {
    ok: true,
    value: {
      version: PROFILE_VERSION,
      name,
      kind: raw.kind,
      createdAt,
      controls: sanitizeControlRecord(raw.controls),
      config: sanitizeConfig(raw.config),
      hardware: sanitizeHardwareConfig(raw.hardware, joints),
    },
  }
}

/** What capture needs from a module. */
export interface ProfileSource {
  readonly kind: RobotKind
  getControlSchema(): ControlDef[]
  getControlValues(): Record<string, ControlValue>
  serializeConfig(): unknown
}

export function captureProfile(name: string, source: ProfileSource, hardware: HardwareConfig, now: Date = new Date()): RobotProfile {
  const values = source.getControlValues()
  const controls: Record<string, ControlValue> = {}
  for (const def of source.getControlSchema()) {
    if (def.type === 'button' || TRANSIENT_KEYS.includes(def.key)) continue
    const v = values[def.key]
    if (v !== undefined) controls[def.key] = v
  }
  return {
    version: PROFILE_VERSION,
    name: sanitizeName(name) || 'Untitled',
    kind: source.kind,
    createdAt: now.toISOString(),
    controls,
    config: sanitizeConfig(source.serializeConfig()),
    hardware: sanitizeHardwareConfig(hardware, hardware.servoPins.length),
  }
}

/* ---------------- apply ---------------- */

export interface ProfileTargetModule {
  readonly kind: RobotKind
  getControlSchema(): ControlDef[]
  getHardwareSpec(): HardwareSpec
  loadConfig(c: unknown): void
}

/** The side-effecting operations applyProfile needs (wired to the runtime by the UI). */
export interface ProfileTarget {
  currentKind(): RobotKind
  setRobot(kind: RobotKind): void
  module(): ProfileTargetModule
  setControl(key: string, value: ControlValue): void
  setHardware(cfg: HardwareConfig): void
}

export interface ApplyReport {
  applied: string[]
  /** Saved keys the live schema did not accept (unknown key, invalid option, ...). */
  rejected: string[]
  configError: string | null
}

/** Max passes over pending keys: a control set early (legs = 8) can unlock options of a later one (gait). */
const APPLY_PASSES = 3

export interface ControlsReport {
  applied: string[]
  rejected: string[]
}

/**
 * Write saved control values through the live schema: sliders clamped, unknown keys and
 * options rejected, momentary keys skipped. Shared by profiles and built-in presets.
 */
export function applyControlValues(controls: Readonly<Record<string, ControlValue>>, target: Pick<ProfileTarget, 'module' | 'setControl'>): ControlsReport {
  const pending = new Set(Object.keys(controls).filter((k) => !TRANSIENT_KEYS.includes(k) && !UNSAFE_KEYS.has(k)))
  const applied: string[] = []
  for (let pass = 0; pass < APPLY_PASSES && pending.size > 0; pass++) {
    let progressed = false
    // schema order, re-read after every set because a control can reshape the schema
    for (const key of target.module().getControlSchema().map((d) => d.key)) {
      if (!pending.has(key)) continue
      const def = target.module().getControlSchema().find((d) => d.key === key)
      const v = def ? sanitizeControlValue(def, controls[key]) : undefined
      if (v === undefined) continue
      target.setControl(key, v)
      pending.delete(key)
      applied.push(key)
      progressed = true
    }
    if (!progressed) break
  }
  return { applied, rejected: [...pending] }
}

export function applyProfile(profile: RobotProfile, target: ProfileTarget): ApplyReport {
  if (target.currentKind() !== profile.kind) target.setRobot(profile.kind)
  const { applied, rejected } = applyControlValues(profile.controls, target)
  let configError: string | null = null
  try {
    target.module().loadConfig(sanitizeConfig(profile.config))
  } catch (e) {
    configError = e instanceof Error ? e.message : 'Module rejected the saved config.'
  }
  const joints = target.module().getHardwareSpec().joints
  target.setHardware(sanitizeHardwareConfig(profile.hardware, joints))
  return { applied, rejected, configError }
}

/* ---------------- list + storage ---------------- */

/** Replace a profile with the same name and kind, else append (newest last, capped). */
export function upsertProfile(list: readonly RobotProfile[], p: RobotProfile): RobotProfile[] {
  const key = p.name.toLowerCase()
  const rest = list.filter((x) => !(x.kind === p.kind && x.name.toLowerCase() === key))
  const next = [...rest, p]
  return next.length > MAX_PROFILES ? next.slice(next.length - MAX_PROFILES) : next
}

export function removeProfile(list: readonly RobotProfile[], kind: RobotKind, name: string): RobotProfile[] {
  const key = name.toLowerCase()
  return list.filter((x) => !(x.kind === kind && x.name.toLowerCase() === key))
}

export function safeLocalStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readProfiles(storage: StorageLike | null = safeLocalStorage()): RobotProfile[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(PROFILE_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: RobotProfile[] = []
    for (const item of parsed.slice(0, MAX_PROFILES)) {
      const res = validateProfile(item)
      if (res.ok) out.push(res.value)
    }
    return out
  } catch {
    return []
  }
}

export function writeProfiles(list: readonly RobotProfile[], storage: StorageLike | null = safeLocalStorage()): boolean {
  if (!storage) return false
  try {
    storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(list))
    return true
  } catch {
    return false
  }
}

/* ---------------- files ---------------- */

export function serializeProfile(p: RobotProfile): string {
  return JSON.stringify(p, null, 2)
}

export function profileFileName(p: RobotProfile): string {
  const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profile'
  return `simconsole-${p.kind}-${slug}.json`
}

/** Accepts one profile, an array of profiles, or { profiles: [...] }. */
export function parseProfileFile(text: string): Result<RobotProfile[]> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'Not a valid JSON file.' }
  }
  const items: unknown[] = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.profiles) ? raw.profiles : [raw]
  if (items.length === 0) return { ok: false, error: 'The file holds no profiles.' }
  const out: RobotProfile[] = []
  for (const item of items.slice(0, MAX_PROFILES)) {
    const res = validateProfile(item)
    if (!res.ok) return { ok: false, error: items.length > 1 ? `Profile ${out.length + 1}: ${res.error}` : res.error }
    out.push(res.value)
  }
  return { ok: true, value: out }
}
