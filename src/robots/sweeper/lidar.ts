import type { LidarScan } from '../../core/protocol'
import {
  LIDAR_MAX_RANGE,
  LIDAR_MIN_RANGE,
  LIDAR_OFFSET_X,
  LIDAR_RATE_HZ,
  LIDAR_SAMPLES,
  LIDAR_SIGMA_ABS,
  LIDAR_SIGMA_REL,
} from './constants'
import type { RayScene } from './raycast'
import type { Rng } from './rng'

/*
 * LD06 model: 360 deg at 10 Hz, 450 samples per revolution, 0.02-12 m, Gaussian range
 * noise sigma = max(10 mm, 1 % of range) x noise. The head turns continuously, so each
 * physics substep casts only the samples its rotation swept (a moving robot smears its
 * scan exactly like the real sensor). Angles are body frame, CCW from forward (REP-103);
 * the physical LD06 reports clockwise, which the firmware converts.
 */

/** Receives every new sample: sensor origin, end point (world) and whether it returned. */
export type ScanSink = (ox: number, oy: number, ex: number, ey: number, hit: boolean) => void

const N = LIDAR_SAMPLES
const MAX_INGEST = 2048
/** Ring spacing, degrees (0.8 at 450 samples). */
const STEP_DEG = 360 / N
/**
 * Widest angle one real sample may stand for. The generated firmware sends 90 bins of
 * 4 deg; a bin fills every ring sample (and degree bin) of its span, so none of them keep
 * an older range. Coarser scans leave gaps rather than smearing one range over them.
 */
const MAX_SPAN_DEG = 12

export class Ld06 {
  readonly samples = N
  /** Range per sample, meters; 0 = no return. */
  readonly ranges = new Float32Array(N)
  /** Sensor origin and end point of each sample at capture time, world frame. */
  readonly ox = new Float32Array(N)
  readonly oy = new Float32Array(N)
  readonly ex = new Float32Array(N)
  readonly ey = new Float32Array(N)
  /** Latest range per whole degree, body frame (what readLidar(angleDeg) returns). */
  readonly bins = new Float32Array(360)
  /** Noise multiplier (the LIDAR NOISE control). */
  noise = 1
  /** Total samples cast since reset; (cursor % N) is the head position. */
  cursor = 0
  private phase = 0
  private readonly cosA = new Float64Array(N)
  private readonly sinA = new Float64Array(N)

  constructor() {
    for (let i = 0; i < N; i++) {
      const a = (i / N) * 2 * Math.PI
      this.cosA[i] = Math.cos(a)
      this.sinA[i] = Math.sin(a)
    }
  }

  /** Head angle, radians (body frame). */
  get headAngle(): number {
    return ((this.cursor % N) / N) * 2 * Math.PI
  }

  reset(): void {
    this.ranges.fill(0)
    this.bins.fill(0)
    this.cursor = 0
    this.phase = 0
  }

  /** Advance the rotation by dt with the robot at (x, y, th) and cast the swept samples. */
  step(dt: number, x: number, y: number, th: number, scene: RayScene, rng: Rng, sink: ScanSink | null): number {
    this.phase += dt * LIDAR_RATE_HZ * N
    const target = Math.floor(this.phase)
    // a long stall would cast more than a revolution: skip to the last full turn
    if (target - this.cursor > N) this.cursor = target - N
    const ct = Math.cos(th), st = Math.sin(th)
    const sx = x + LIDAR_OFFSET_X * ct
    const sy = y + LIDAR_OFFSET_X * st
    let cast = 0
    while (this.cursor < target) {
      const i = this.cursor % N
      const dx = ct * this.cosA[i] - st * this.sinA[i]
      const dy = st * this.cosA[i] + ct * this.sinA[i]
      const truth = scene.cast(sx, sy, dx, dy)
      let r = 0
      if (truth <= LIDAR_MAX_RANGE) {
        const sigma = this.noise * Math.max(LIDAR_SIGMA_ABS, LIDAR_SIGMA_REL * truth)
        r = truth + sigma * rng.gauss()
        if (r < LIDAR_MIN_RANGE || r > LIDAR_MAX_RANGE) r = 0
      }
      this.store(i, sx, sy, dx, dy, r, sink)
      this.cursor++
      cast++
    }
    return cast
  }

  /**
   * Feed a real LD06 scan (HARDWARE telemetry) captured with the robot at (x, y, th). Each
   * sample at angle a stands for [a - da/2, a + da/2): every ring sample in that span is
   * set (drawn as an arc at the measured range), and the map gets one ray per sample.
   */
  ingest(scan: LidarScan, x: number, y: number, th: number, sink: ScanSink | null): number {
    const ct = Math.cos(th), st = Math.sin(th)
    const sx = x + LIDAR_OFFSET_X * ct
    const sy = y + LIDAR_OFFSET_X * st
    const count = Math.min(scan.r.length, MAX_INGEST)
    const span = Math.min(Math.abs(scan.da), MAX_SPAN_DEG)
    let used = 0
    for (let j = 0; j < count; j++) {
      const deg = scan.a0 + j * scan.da
      const raw = scan.r[j]
      if (!Number.isFinite(deg) || Math.abs(deg) > 1e6 || typeof raw !== 'number' || !Number.isFinite(raw)) continue
      const r = raw >= LIDAR_MIN_RANGE && raw <= LIDAR_MAX_RANGE ? raw : 0
      const i0 = Math.round((deg - span / 2) / STEP_DEG)
      const i1 = Math.max(i0, Math.round((deg + span / 2) / STEP_DEG) - 1)
      for (let i = i0; i <= i1; i++) {
        const k = ((i % N) + N) % N
        const wa = th + (k / N) * 2 * Math.PI
        this.store(k, sx, sy, Math.cos(wa), Math.sin(wa), r, null)
      }
      if (sink && r > 0) {
        const wa = th + (deg * Math.PI) / 180
        sink(sx, sy, sx + Math.cos(wa) * r, sy + Math.sin(wa) * r, true)
      }
      used++
    }
    return used
  }

  private store(i: number, sx: number, sy: number, dx: number, dy: number, r: number, sink: ScanSink | null): void {
    this.ranges[i] = r
    this.ox[i] = sx
    this.oy[i] = sy
    this.ex[i] = sx + dx * r
    this.ey[i] = sy + dy * r
    // nearest whole degree: a bin is never more than half a degree from its sample
    this.bins[Math.round(i * STEP_DEG) % 360] = r
    if (sink && r > 0) sink(sx, sy, this.ex[i], this.ey[i], true)
  }

  /** Smallest valid range over all bins, or the max range when nothing returned. */
  minRange(): number {
    let m = Infinity
    for (let b = 0; b < 360; b++) {
      const r = this.bins[b]
      if (r > 0 && r < m) m = r
    }
    return m === Infinity ? LIDAR_MAX_RANGE : m
  }

  /** Smallest valid range within +-halfDeg of a body angle (degrees). */
  rangeAround(deg: number, halfDeg: number): number {
    let m = Infinity
    for (let d = -halfDeg; d <= halfDeg; d++) {
      const r = this.bins[(((Math.round(deg) + d) % 360) + 360) % 360]
      if (r > 0 && r < m) m = r
    }
    return m === Infinity ? LIDAR_MAX_RANGE : m
  }
}
