import type { HardwareConfig } from '../../core/hardware'

/* ============================================================
   CALIBRATION RECORDER — commanded q (at send time) and measured
   ang (at arrival time) as two time series in preallocated typed
   arrays. Stops itself when full rather than overwriting, so a
   fit always sees one continuous take.
   ============================================================ */

export const CALIB_MAX_CMD = 8000
export const CALIB_MAX_TEL = 4000

/** A time series of `stride` values per sample: v[i * stride + j]. */
export interface Series {
  t: Float64Array
  v: Float64Array
  n: number
  stride: number
}

/** The mapping in force while recording; the fit converts relative to it. */
export interface MappingSnapshot {
  jointScale: number[]
  jointOffsetDeg: number[]
  jointInvert: boolean[]
}

export function snapshotMapping(cfg: HardwareConfig, joints: number): MappingSnapshot {
  return {
    jointScale: Array.from({ length: joints }, (_, j) => cfg.jointScale[j] ?? 1),
    jointOffsetDeg: Array.from({ length: joints }, (_, j) => cfg.jointOffsetDeg[j] ?? 0),
    jointInvert: Array.from({ length: joints }, (_, j) => cfg.jointInvert[j] ?? false),
  }
}

function makeSeries(cap: number, stride: number): Series {
  return { t: new Float64Array(cap), v: new Float64Array(cap * stride), n: 0, stride }
}

export class CalibrationRecorder {
  private cmd: Series = makeSeries(0, 0)
  private tel: Series = makeSeries(0, 0)
  recording = false
  /** Set when the buffers filled up and recording stopped on its own. */
  full = false
  mapping: MappingSnapshot | null = null

  constructor(private readonly maxCmd = CALIB_MAX_CMD, private readonly maxTel = CALIB_MAX_TEL) {}

  get joints(): number {
    return this.cmd.stride
  }

  get cmdSamples(): number {
    return this.cmd.n
  }

  get telSamples(): number {
    return this.tel.n
  }

  /** Seconds spanned by the commanded series. */
  get durationSec(): number {
    return this.cmd.n > 1 ? (this.cmd.t[this.cmd.n - 1] - this.cmd.t[0]) / 1000 : 0
  }

  start(joints: number, cfg: HardwareConfig): void {
    this.cmd = makeSeries(this.maxCmd, joints)
    this.tel = makeSeries(this.maxTel, joints)
    this.mapping = snapshotMapping(cfg, joints)
    this.recording = true
    this.full = false
  }

  stop(): void {
    this.recording = false
  }

  clear(): void {
    this.recording = false
    this.full = false
    this.cmd = makeSeries(0, 0)
    this.tel = makeSeries(0, 0)
    this.mapping = null
  }

  addCommand(tMs: number, q: readonly number[] | undefined): void {
    this.push(this.cmd, tMs, q)
  }

  addMeasured(tMs: number, ang: readonly number[] | undefined): void {
    this.push(this.tel, tMs, ang)
  }

  /** Read-only views of the recorded data. */
  data(): { cmd: Series; tel: Series } {
    return { cmd: this.cmd, tel: this.tel }
  }

  private push(s: Series, tMs: number, vals: readonly number[] | undefined): void {
    if (!this.recording || !vals || vals.length !== s.stride || s.stride === 0) return
    // keep times strictly increasing (interpolation relies on it)
    if (s.n > 0 && tMs <= s.t[s.n - 1]) return
    if (s.n >= s.t.length) {
      this.recording = false
      this.full = true
      return
    }
    s.t[s.n] = tMs
    const base = s.n * s.stride
    for (let j = 0; j < s.stride; j++) s.v[base + j] = vals[j]
    s.n++
  }
}
