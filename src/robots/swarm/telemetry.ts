import type { TelemetryFrame } from '../../core/types'
import type { FormationShape } from './sim/formation'
import { RAD } from './sim/frames'
import { SAT_RP, SAT_THRUST } from './sim/mixer'
import { maxMotorThrust } from './sim/params'
import { quatToEuler } from './sim/quat'
import type { Phase, SwarmSim } from './sim/swarmSim'

/*
 * Fills the swarm's TelemetryFrame from the sim. The frame and its maps are allocated
 * once per fleet size and refreshed in place every frame (the recorder clones what it
 * keeps). Text readouts are cached and re-formatted only when the value they show
 * changes, so a steady frame allocates nothing.
 */

/** RMS slot error at which the FORMATION gauge reads 0 %, m. */
export const FORMATION_ZERO_M = 2

/** FORMATION gauge: 100 % on the slots, falling linearly to 0 % at FORMATION_ZERO_M RMS. */
export function formationScore(rms: number, autoFlying: number): number {
  if (autoFlying <= 0 || !Number.isFinite(rms)) return 0
  return Math.min(100, Math.max(0, 100 * (1 - rms / FORMATION_ZERO_M)))
}

const PHASE_LABEL: Readonly<Record<Phase, string>> = { idle: 'IDLE', takeoff: 'TAKEOFF', mission: 'MISSION', landing: 'LANDING' }
const PHASE_HW: Readonly<Record<Phase, string>> = { idle: 'IDLE · HW', takeoff: 'TAKEOFF · HW', mission: 'MISSION · HW', landing: 'LANDING · HW' }
const SHAPE_LABEL: Readonly<Record<FormationShape, string>> = {
  line: 'LINE', wedge: 'WEDGE', triangle: 'TRIANGLE', circle: 'CIRCLE', column: 'COLUMN',
}

/** m:ss.s */
export function formatFlightTime(sec: number): string {
  const tenths = Math.max(0, Math.floor(sec * 10 + 1e-6))
  const m = Math.floor(tenths / 600)
  const s = (tenths % 600) / 10
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`
}

/** 'i/n' for the waypoint being flown to, 'DONE' after a ONCE route, '—' without a route. */
export function waypointLabel(target: number, count: number, done: boolean): string {
  if (count <= 0) return '—'
  if (done) return 'DONE'
  return `${Math.min(target, count - 1) + 1}/${count}`
}

const ALERT_CRASH = 1
const ALERT_LOWBAT = 2
const ALERT_SAT = 3

/** Most important alert as a code (kind·16 + drone id): crash > low battery > motor saturation. 0 = none. */
export function alertCode(sim: SwarmSim): number {
  let code = 0
  for (const d of sim.drones) {
    const kind = d.mode === 'crashed' ? ALERT_CRASH
      : d.lowBattery ? ALERT_LOWBAT
      : d.mode === 'flying' && (d.ctrl.satFlags & (SAT_RP | SAT_THRUST)) !== 0 ? ALERT_SAT
      : 0
    if (kind === 0) continue
    const c = kind * 16 + d.id
    if (code === 0 || c < code) code = c
  }
  return code
}

export function alertLabel(code: number, mirror: boolean): string {
  if (code === 0) return mirror ? 'MIRRORING HW' : 'NOMINAL'
  const id = `D${(code % 16) + 1}`
  const kind = Math.floor(code / 16)
  if (kind === ALERT_CRASH) return `${id} CRASHED`
  if (kind === ALERT_LOWBAT) return `${id} LOW BATTERY`
  return `${id} MOTOR SAT`
}

/** A string readout that is rebuilt only when its integer key changes (no per-frame allocation). */
class CachedText {
  key = Number.NaN
  text = ''

  stale(key: number): boolean {
    return key !== this.key
  }

  set(key: number, text: string): string {
    this.key = key
    this.text = text
    return text
  }
}

export class SwarmTelemetry {
  frame: TelemetryFrame = { t: 0, gauges: {}, channels: {}, bars: [], readouts: {} }
  private altKeys: string[] = []
  private errKeys: string[] = []
  private readonly eul = new Float64Array(3)
  private readonly cache = { flight: new CachedText(), wp: new CachedText(), alert: new CachedText(), air: new CachedText() }

  constructor(n: number) {
    this.resize(n)
  }

  /** New frame shape for an n-drone fleet. */
  resize(n: number): void {
    this.altKeys = Array.from({ length: n }, (_, i) => `alt${i + 1}`)
    this.errKeys = Array.from({ length: n }, (_, i) => `err${i + 1}`)
    const channels: Record<string, number> = { roll: 0, pitch: 0 }
    for (let i = 0; i < n; i++) {
      channels[this.altKeys[i]] = 0
      channels[this.errKeys[i]] = 0
    }
    this.frame = { t: 0, gauges: { formation: 0, battery: 100 }, channels, bars: new Array<number>(n).fill(0), readouts: {} }
  }

  /** Refresh the frame in place. costMs = measured sim step cost; mirror = HARDWARE source. */
  fill(sim: SwarmSim, costMs: number, mirror: boolean): TelemetryFrame {
    const f = this.frame
    const n = Math.min(sim.count, this.altKeys.length)
    const tMax = 4 * maxMotorThrust(sim.params)
    let minBat = 100
    let airborne = 0
    for (let i = 0; i < n; i++) {
      const d = sim.drones[i]
      f.channels[this.altKeys[i]] = d.s[2]
      f.channels[this.errKeys[i]] = d.trackErr
      f.bars[i] = Math.min(1, d.totalThrust / tMax)
      if (d.battery.percent < minBat) minBat = d.battery.percent
      if (d.airborne) airborne++
    }
    const ref = sim.leader ?? sim.drones[0]
    quatToEuler(this.eul, ref.s, 6)
    f.t = sim.t
    f.channels.roll = this.eul[0] * RAD
    f.channels.pitch = this.eul[1] * RAD
    f.gauges.formation = formationScore(sim.formationRms, sim.autoFlying)
    f.gauges.battery = minBat
    this.fillReadouts(sim, airborne, n, costMs, mirror)
    return f
  }

  private fillReadouts(sim: SwarmSim, airborne: number, n: number, costMs: number, mirror: boolean): void {
    const r = this.frame.readouts
    const route = sim.route
    const ref = sim.leader ?? sim.drones[0]
    const wpKey = sim.wpCount === 0 ? -1 : route.done ? -2 : route.target * 64 + sim.wpCount
    const alertKey = alertCode(sim) * 2 + (mirror ? 1 : 0)
    const flightKey = Math.floor(sim.flightTime * 10)
    const airKey = airborne * 8 + n
    const c = this.cache
    r.phase = mirror ? PHASE_HW[sim.phase] : PHASE_LABEL[sim.phase]
    r.status = c.alert.stale(alertKey) ? c.alert.set(alertKey, alertLabel(alertKey >> 1, mirror)) : c.alert.text
    r.shape = SHAPE_LABEL[sim.settings.shape]
    r.wp = c.wp.stale(wpKey) ? c.wp.set(wpKey, waypointLabel(route.target, sim.wpCount, route.done)) : c.wp.text
    r.minSep = Number.isFinite(sim.minSeparation) ? sim.minSeparation : 0
    r.leaderSpeed = sim.leader ? sim.leader.speed : 0
    r.wind = Math.hypot(ref.wind[0], ref.wind[1], ref.wind[2])
    r.flight = c.flight.stale(flightKey) ? c.flight.set(flightKey, formatFlightTime(flightKey / 10)) : c.flight.text
    r.airborne = c.air.stale(airKey) ? c.air.set(airKey, `${airborne}/${n}`) : c.air.text
    r.loopHz = sim.loopHz
    r.cost = costMs
  }
}
