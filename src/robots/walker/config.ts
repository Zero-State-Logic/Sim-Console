import { DIM_RANGES, type WalkerDims } from './geometry'
import { ACT_RANGES, type ActuatorUi } from './controls'

/* ============================================================
   PROFILES + RECORD/REPLAY payloads, with validation.
   Profiles and recordings come from JSON files and localStorage,
   so nothing here trusts its input.
   ============================================================ */

export interface WalkerConfig {
  v: 1
  dims: WalkerDims
  actuator: ActuatorUi
}

export interface WalkerSnapshot {
  v: 1
  /** Body world pose: x, y, z, roll, pitch, yaw (m, rad). */
  body: number[]
  /** Joint angles shown, radians. */
  q: number[]
  /** Contact flags, 0/1 per leg. */
  c: number[]
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function inRange(v: unknown, r: readonly [number, number]): number | null {
  const n = num(v)
  return n === null ? null : Math.min(Math.max(n, r[0]), r[1])
}

function numArray(v: unknown, len: number): number[] | null {
  if (!Array.isArray(v) || v.length !== len) return null
  const out: number[] = []
  for (const x of v) {
    const n = num(x)
    if (n === null) return null
    out.push(n)
  }
  return out
}

export function serializeWalkerConfig(dims: WalkerDims, actuator: ActuatorUi): WalkerConfig {
  return { v: 1, dims: { ...dims }, actuator: { ...actuator } }
}

/**
 * Validate a profile. Missing or non-numeric fields fall back to `fallback`; numbers
 * are clamped into the slider ranges. Returns null if `c` is not a walker config at all.
 */
export function parseWalkerConfig(c: unknown, fallback: WalkerConfig): WalkerConfig | null {
  if (!isObj(c) || c.v !== 1) return null
  const d = isObj(c.dims) ? c.dims : {}
  const a = isObj(c.actuator) ? c.actuator : {}
  const dim = (k: keyof WalkerDims) => inRange(d[k], DIM_RANGES[k]) ?? fallback.dims[k]
  const act = (k: keyof ActuatorUi) => inRange(a[k], ACT_RANGES[k]) ?? fallback.actuator[k]
  return {
    v: 1,
    dims: { coxa: dim('coxa'), femur: dim('femur'), tibia: dim('tibia'), bodyRadius: dim('bodyRadius') },
    actuator: {
      tauMs: act('tauMs'),
      speedDeg: act('speedDeg'),
      stallNm: act('stallNm'),
      deadbandDeg: act('deadbandDeg'),
      backlashDeg: act('backlashDeg'),
    },
  }
}

/** Validate a snapshot for an n-leg robot; null if it does not fit (e.g. recorded with another leg count). */
export function parseWalkerSnapshot(s: unknown, n: number): WalkerSnapshot | null {
  if (!isObj(s) || s.v !== 1) return null
  const body = numArray(s.body, 6)
  const q = numArray(s.q, n * 3)
  const c = numArray(s.c, n)
  if (!body || !q || !c) return null
  return { v: 1, body, q, c: c.map((x) => (x ? 1 : 0)) }
}
