import type { MappingSnapshot, Series } from './recorder'

/* ============================================================
   CALIBRATION FIT
   1. Latency: resample commanded and measured onto a 10 ms grid
      and pick the shift that maximizes the pooled normalized
      cross-correlation (refined with a parabola through the peak).
   2. Pairs: each measured sample is paired with the commanded
      value one latency earlier. A servo also lags (first-order),
      which shrinks moving data and would bias the gain low, so
      pairs where the command had been still for SETTLE_MS are
      "static" and preferred; moving pairs are the fallback.
   3. Per joint, least squares:  measured = a · commanded + b
   4. Convert to HardwareConfig. jointToServoDeg sends
        s = R/2 + off + d·k·q            (d = ±1 invert, k = scale)
      and the joint really sits at q_true = d·(s − R/2 − off*)/k*,
      so q_true = (k/k*)·q + d·(off − off*)/k*, i.e. a = k/k*,
      b = d·(off − off*)/k*. The mapping that cancels the error:
        k* = k / a,   off* = off − d·b·k / a
   ============================================================ */

export const GRID_MS = 10
export const MAX_LAG_MS = 400
/** Only the newest stretch is used for the latency search (bounds the cost). */
const MAX_SEARCH_MS = 60_000
/** A command still for this long (and within STILL_DEG) counts as settled. */
export const SETTLE_MS = 400
export const STILL_DEG = 0.5
/** Below this commanded range a joint gets an offset-only fit (scale needs motion). */
export const MIN_EXCITATION_DEG = 4
/** Fitted gains outside this band are almost certainly a wiring or sign problem, not calibration. */
export const SANE_GAIN: [number, number] = [0.5, 2]
const MIN_PAIRS = 20

export interface LinearFit {
  a: number
  b: number
  /** RMS of measured − (a·commanded + b), degrees. */
  rms: number
  /** RMS of measured − commanded before correction, degrees. */
  rmsRaw: number
  n: number
  /** False = too little motion: offset-only fit with a = 1. */
  excited: boolean
}

/** Least-squares line through (x, y). Offset-only when x barely moves. */
export function fitLinear(x: ArrayLike<number>, y: ArrayLike<number>, n = x.length): LinearFit | null {
  if (n < 3) return null
  let sx = 0
  let sy = 0
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < n; i++) {
    sx += x[i]
    sy += y[i]
    if (x[i] < lo) lo = x[i]
    if (x[i] > hi) hi = x[i]
  }
  const mx = sx / n
  const my = sy / n
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx
    sxx += dx * dx
    sxy += dx * (y[i] - my)
  }
  const excited = hi - lo >= MIN_EXCITATION_DEG && sxx > 0
  const a = excited ? sxy / sxx : 1
  const b = excited ? my - a * mx : my - mx
  let se = 0
  let sr = 0
  for (let i = 0; i < n; i++) {
    const e = y[i] - (a * x[i] + b)
    const r = y[i] - x[i]
    se += e * e
    sr += r * r
  }
  return { a, b, rms: Math.sqrt(se / n), rmsRaw: Math.sqrt(sr / n), n, excited }
}

/** Mapping values that cancel a fitted error (see the header). */
export function correctedMapping(a: number, b: number, scale: number, offset: number, invert: boolean): { scale: number; offset: number } {
  const d = invert ? -1 : 1
  return { scale: scale / a, offset: offset - (d * b * scale) / a }
}

/* ---------------- resampling ---------------- */

/** Linear interpolation of joint j at t with a forward-only cursor (t must not decrease between calls). */
function sampleAt(s: Series, j: number, t: number, cursor: { i: number }): number | null {
  if (s.n === 0 || t < s.t[0] || t > s.t[s.n - 1]) return null
  let i = cursor.i
  while (i < s.n - 2 && s.t[i + 1] < t) i++
  cursor.i = i
  const i1 = Math.min(i + 1, s.n - 1)
  const t0 = s.t[i]
  const t1 = s.t[i1]
  const v0 = s.v[i * s.stride + j]
  const v1 = s.v[i1 * s.stride + j]
  return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v0
}

function toGrid(s: Series, t0: number, count: number): Float64Array {
  const v = new Float64Array(count * s.stride)
  for (let j = 0; j < s.stride; j++) {
    const cur = { i: 0 }
    let last = s.n > 0 ? s.v[j] : 0
    for (let k = 0; k < count; k++) {
      const x = sampleAt(s, j, t0 + k * GRID_MS, cur)
      if (x !== null) last = x
      v[k * s.stride + j] = last
    }
  }
  return v
}

/* ---------------- latency ---------------- */

/** Pooled correlation of c shifted by k steps against m over i in [from, count). Single pass. */
function pooledCorr(c: Float64Array, m: Float64Array, J: number, count: number, k: number, from: number): number {
  const len = count - from
  let cov = 0
  let vc = 0
  let vm = 0
  for (let j = 0; j < J; j++) {
    let sc = 0
    let sm = 0
    let scc = 0
    let smm = 0
    let scm = 0
    for (let i = from; i < count; i++) {
      const x = c[(i - k) * J + j]
      const y = m[i * J + j]
      sc += x
      sm += y
      scc += x * x
      smm += y * y
      scm += x * y
    }
    cov += scm - (sc * sm) / len
    vc += scc - (sc * sc) / len
    vm += smm - (sm * sm) / len
  }
  return vc > 1e-9 && vm > 1e-9 ? cov / Math.sqrt(vc * vm) : NaN
}

export interface LatencyEstimate {
  /** How far measured trails commanded (link + servo response), ms. */
  lagMs: number
  /** Pooled normalized correlation at the peak, −1..1 (NaN when nothing moved). */
  score: number
}

export function estimateLatency(cmd: Series, meas: Series, maxLagMs = MAX_LAG_MS): LatencyEstimate {
  const none: LatencyEstimate = { lagMs: 0, score: NaN }
  if (cmd.n < 2 || meas.n < 2 || cmd.stride !== meas.stride || cmd.stride === 0) return none
  const tEnd = Math.min(cmd.t[cmd.n - 1], meas.t[meas.n - 1])
  const tStart = Math.max(cmd.t[0], tEnd - MAX_SEARCH_MS - maxLagMs)
  const count = Math.floor((tEnd - tStart) / GRID_MS) + 1
  const maxK = Math.min(Math.round(maxLagMs / GRID_MS), Math.floor(count / 3))
  const from = Math.max(maxK, Math.ceil((meas.t[0] - tStart) / GRID_MS))
  if (count < 10 || maxK < 1 || count - from < 10) return none
  const c = toGrid(cmd, tStart, count)
  const m = toGrid(meas, tStart, count)
  const scores = new Float64Array(maxK + 1)
  let best = -1
  for (let k = 0; k <= maxK; k++) {
    scores[k] = pooledCorr(c, m, cmd.stride, count, k, from)
    if (Number.isFinite(scores[k]) && (best < 0 || scores[k] > scores[best])) best = k
  }
  if (best < 0) return none
  let frac = 0
  if (best > 0 && best < maxK) {
    // parabola through the three samples around the peak
    const den = scores[best - 1] - 2 * scores[best] + scores[best + 1]
    if (den < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (scores[best - 1] - scores[best + 1])) / den))
  }
  return { lagMs: (best + frac) * GRID_MS, score: scores[best] }
}

/* ---------------- pairing + fit ---------------- */

/**
 * True when joint j of the command stayed within STILL_DEG over [from, t]. The window must
 * reach the measurement time itself: a step after (t − lag) could already show in the reading.
 */
function settled(cmd: Series, j: number, from: number, t: number, cursor: { i: number }): boolean {
  if (from < cmd.t[0] || t > cmd.t[cmd.n - 1]) return false
  let i = cursor.i
  while (i < cmd.n - 1 && cmd.t[i] < from) i++
  cursor.i = i
  let lo = Infinity
  let hi = -Infinity
  for (let k = Math.max(0, i - 1); k < cmd.n && cmd.t[k] <= t; k++) {
    const v = cmd.v[k * cmd.stride + j]
    if (v < lo) lo = v
    if (v > hi) hi = v
    if (hi - lo > STILL_DEG) return false
  }
  return hi >= lo
}

export interface JointCalibration {
  index: number
  name: string
  fit: LinearFit | null
  /** static = settled pairs only (unbiased); dynamic = moving pairs (servo lag biases the gain low). */
  source: 'static' | 'dynamic' | 'none'
  /** a outside SANE_GAIN, or no fit: left out of APPLY. */
  suspect: boolean
  /** Proposed absolute config values (current values when suspect). */
  scale: number
  offset: number
}

export type CalibrationResult =
  | { ok: true; latency: LatencyEstimate; pairs: number; joints: JointCalibration[] }
  | { ok: false; reason: string }

interface PairBuffers {
  xs: Float64Array
  ys: Float64Array
  sx: Float64Array
  sy: Float64Array
}

/** Fill aligned pairs for joint j; returns [all, static] counts. */
function collectPairs(cmd: Series, meas: Series, j: number, lag: number, b: PairBuffers): [number, number] {
  const cur = { i: 0 }
  const still = { i: 0 }
  let k = 0
  let s = 0
  for (let i = 0; i < meas.n; i++) {
    const tc = meas.t[i] - lag
    const c = sampleAt(cmd, j, tc, cur)
    if (c === null) continue
    const y = meas.v[i * meas.stride + j]
    b.xs[k] = c
    b.ys[k] = y
    k++
    if (settled(cmd, j, tc - SETTLE_MS, meas.t[i], still)) {
      b.sx[s] = c
      b.sy[s] = y
      s++
    }
  }
  return [k, s]
}

function pickFit(b: PairBuffers, all: number, still: number): { fit: LinearFit | null; source: JointCalibration['source'] } {
  const fs = still >= MIN_PAIRS ? fitLinear(b.sx, b.sy, still) : null
  if (fs && fs.excited) return { fit: fs, source: 'static' }
  const fd = all >= MIN_PAIRS ? fitLinear(b.xs, b.ys, all) : null
  if (fd && fd.excited) return { fit: fd, source: 'dynamic' }
  // neither moved enough: an offset-only fit, settled data preferred
  if (fs) return { fit: fs, source: 'static' }
  return fd ? { fit: fd, source: 'dynamic' } : { fit: null, source: 'none' }
}

/** Fit every joint from a recording. */
export function calibrate(cmd: Series, meas: Series, mapping: MappingSnapshot, names: readonly string[]): CalibrationResult {
  if (cmd.stride === 0 || cmd.stride !== meas.stride) return { ok: false, reason: 'no joint-level samples recorded' }
  if (cmd.n < MIN_PAIRS || meas.n < MIN_PAIRS) return { ok: false, reason: `need at least ${MIN_PAIRS} commanded and measured samples` }
  const latency = estimateLatency(cmd, meas)
  const lag = Number.isFinite(latency.score) ? latency.lagMs : 0
  const b: PairBuffers = { xs: new Float64Array(meas.n), ys: new Float64Array(meas.n), sx: new Float64Array(meas.n), sy: new Float64Array(meas.n) }
  const joints: JointCalibration[] = []
  let pairs = 0
  for (let j = 0; j < cmd.stride; j++) {
    const [all, still] = collectPairs(cmd, meas, j, lag, b)
    pairs = Math.max(pairs, all)
    const { fit, source } = pickFit(b, all, still)
    const scale = mapping.jointScale[j]
    const offset = mapping.jointOffsetDeg[j]
    const suspect = !fit || !(fit.a >= SANE_GAIN[0] && fit.a <= SANE_GAIN[1])
    const corr = fit && !suspect ? correctedMapping(fit.a, fit.b, scale, offset, mapping.jointInvert[j]) : { scale, offset }
    joints.push({ index: j, name: names[j] ?? `J${j}`, fit, source, suspect, scale: corr.scale, offset: corr.offset })
  }
  if (pairs < MIN_PAIRS) return { ok: false, reason: 'commanded and measured samples do not overlap in time' }
  return { ok: true, latency, pairs, joints }
}

/** Config patch for APPLY: fitted joints replaced, the rest kept as they are now. */
export function calibrationPatch(
  current: { jointScale: number[]; jointOffsetDeg: number[] },
  result: Extract<CalibrationResult, { ok: true }>,
  joints: number,
): { jointScale: number[]; jointOffsetDeg: number[] } {
  const jointScale = Array.from({ length: joints }, (_, j) => current.jointScale[j] ?? 1)
  const jointOffsetDeg = Array.from({ length: joints }, (_, j) => current.jointOffsetDeg[j] ?? 0)
  for (const jc of result.joints) {
    if (jc.suspect || jc.index >= joints) continue
    jointScale[jc.index] = round(jc.scale, 5)
    jointOffsetDeg[jc.index] = round(jc.offset, 3)
  }
  return { jointScale, jointOffsetDeg }
}

/** RESET CALIBRATION: identity mapping. */
export function identityCalibration(joints: number): { jointScale: number[]; jointOffsetDeg: number[] } {
  return { jointScale: new Array(joints).fill(1), jointOffsetDeg: new Array(joints).fill(0) }
}

function round(x: number, d: number): number {
  const p = 10 ** d
  return Math.round(x * p) / p
}
