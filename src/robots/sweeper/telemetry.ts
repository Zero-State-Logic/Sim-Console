import type { TelemetryFrame } from '../../core/types'
import { DEG } from './constants'
import { minClearance } from './safety'
import type { SweeperSim } from './sim'

/*
 * One TelemetryFrame per frame, built in place (the recorder deep-copies what it keeps).
 * Keys match LAYOUT in schema.ts. MAP KNOWN scans the whole grid, so it is refreshed at
 * 4 Hz of sim time and only when the map changed.
 */

/** CLEARANCE gauge full scale, cm. */
export const CLEARANCE_MAX_CM = 200
const KNOWN_PERIOD = 0.25

export class TelemetryBuilder {
  readonly frame: TelemetryFrame = {
    t: 0,
    gauges: { coverage: 0, clearance: 0 },
    channels: { wFL: 0, wFR: 0, wRL: 0, wRR: 0, minRange: 0, frontRange: 0 },
    bars: [0, 0, 0, 0],
    readouts: { x: 0, y: 0, hdg: 0, speed: 0, drift: 0, path: 0, replans: 0, bumps: 0, known: 0, status: '' },
  }
  private knownAt = -Infinity
  private knownVersion = -1
  private known = 0

  /** Forget the cached MAP KNOWN value (after a reset or a new arena). */
  invalidate(): void {
    this.knownAt = -Infinity
    this.knownVersion = -1
  }

  /** Fill the frame from the sim. `coverageOverride` replaces the live coverage (replay). */
  update(sim: SweeperSim, status: string, coverageOverride: number | null = null): TelemetryFrame {
    const f = this.frame
    const w = sim.wheel
    f.t = sim.t
    f.gauges.coverage = coverageOverride ?? sim.coverage.percent()
    f.gauges.clearance = clearanceCm(minClearance(sim.lidar.bins))
    f.channels.wFL = w[0]
    f.channels.wFR = w[1]
    f.channels.wRL = w[2]
    f.channels.wRR = w[3]
    f.channels.minRange = sim.lidar.minRange()
    f.channels.frontRange = sim.lidar.rangeAround(0, 5)
    for (let i = 0; i < 4; i++) f.bars[i] = Math.abs(w[i])
    const r = f.readouts
    r.x = sim.pose.x
    r.y = sim.pose.y
    r.hdg = sim.pose.th / DEG
    r.speed = sim.speed
    r.drift = sim.odomError
    r.path = sim.nav.pathRemaining
    r.replans = sim.nav.replans
    r.bumps = sim.bumps
    r.known = this.knownPercent(sim)
    r.status = status
    return f
  }

  private knownPercent(sim: SweeperSim): number {
    const stale = sim.t < this.knownAt || sim.t - this.knownAt >= KNOWN_PERIOD
    if (stale && sim.grid.version !== this.knownVersion) {
      this.known = 100 * sim.grid.knownFraction(sim.half)
      this.knownVersion = sim.grid.version
      this.knownAt = sim.t
    }
    return this.known
  }
}

/** Footprint clearance (m, Infinity = nothing seen) -> gauge value in cm, clamped. */
export function clearanceCm(clearance: number): number {
  if (!Number.isFinite(clearance)) return CLEARANCE_MAX_CM
  return Math.max(0, Math.min(CLEARANCE_MAX_CM, clearance * 100))
}
