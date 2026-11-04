import type { ChannelDef, InstrumentLayout, TelemetryFrame } from '../../core/types'
import { bodyName, legLabel, type LegCount } from './geometry'
import type { WalkerSim } from './sim'
import { IK_JOINT_LIMIT, IK_OK } from './kinematics'

/* ============================================================
   INSTRUMENTS — layout and the per-frame telemetry frame.
   Chart colors are literal hex (canvas strokeStyle can't read CSS
   vars); gauges and bars use the frozen theme tokens. One frame
   object is reused every tick (the recorder clones what it keeps).
   ============================================================ */

const LEG_HEX = ['#FF5A1F', '#0C8F9B', '#6C4CF0', '#1F9D57', '#E8A200', '#2D7DD2', '#D6337C', '#5A6570']
const JOINT_NAMES = ['COXA', 'FEMUR', 'TIBIA']
/** Foot-height chart shows the first legs of each side (front right, middle/rear right, front left). */
const FOOT_LEGS = 3
/** Channel keys of the foot-height chart (built once, no per-frame string work). */
const FOOT_KEYS = Array.from({ length: FOOT_LEGS }, (_, i) => `foot${i}`)
const NO_SUPPORT = '—'

export interface LayoutContext {
  n: LegCount
  gaitLabel: string
  /** Stall torque of the active servo, N·m (Infinity = IDEAL). */
  stall: number
  /** Robot weight, newtons. */
  weight: number
}

/** Chart ceiling for a stall torque: room above stall, a sane range for IDEAL. */
export function torqueChartMax(stall: number): number {
  if (!Number.isFinite(stall)) return 1
  return Math.max(0.2, Math.round(stall * 1.4 * 20) / 20)
}

/** Legs plotted on the foot-height chart: front-right, the next right leg, front-left. */
export function footLeg(n: number, i: number): number {
  return i === 2 ? n / 2 : i
}

function torqueChannels(stall: number): ChannelDef[] {
  const ch: ChannelDef[] = [
    { key: 'tqFemur', label: 'femur (most loaded leg)', color: '#FF5A1F' },
    { key: 'tqTibia', label: 'tibia (most loaded leg)', color: '#0C8F9B' },
    { key: 'tqMax', label: 'max |τ|', color: '#6C4CF0' },
  ]
  if (Number.isFinite(stall)) ch.push({ key: 'tqStall', label: 'stall', color: '#D11F2D' })
  return ch
}

export function buildInstrumentLayout(c: LayoutContext): InstrumentLayout {
  const labels = Array.from({ length: c.n }, (_, i) => legLabel(i))
  return {
    title: 'LOCOMOTION',
    subtitle: `${bodyName(c.n)} · ${c.gaitLabel}`,
    gauges: [
      { key: 'drive', label: 'DRIVE %', color: 'var(--accent)', min: 0, max: 100, unit: '%' },
      { key: 'stability', label: 'STABILITY', color: 'var(--sim)', min: 0, max: 100, unit: '%' },
    ],
    charts: [
      { key: 'torque', title: 'JOINT TORQUE', unit: 'Nm', min: 0, max: torqueChartMax(c.stall), windowSec: 6, channels: torqueChannels(c.stall) },
      {
        key: 'foot', title: 'FOOT HEIGHT', unit: 'm', min: -0.005, max: 0.07, windowSec: 6,
        channels: Array.from({ length: Math.min(FOOT_LEGS, c.n) }, (_, i) => {
          const leg = footLeg(c.n, i)
          return { key: FOOT_KEYS[i], label: legLabel(leg), color: LEG_HEX[leg] }
        }),
      },
    ],
    bars: {
      title: 'LEG LOAD', unit: 'N', labels, max: Math.round(((2 * c.weight) / c.n) * 10) / 10,
      colors: labels.map((_, i) => `var(--l${i + 1})`),
    },
    readouts: [
      { key: 'margin', label: 'SUPPORT MARGIN', unit: 'mm', digits: 1 },
      { key: 'comH', label: 'COM HEIGHT', unit: 'mm', digits: 1 },
      { key: 'speed', label: 'BODY SPEED', unit: 'm/s', digits: 3 },
      { key: 'current', label: 'EST. CURRENT', unit: 'A', digits: 2 },
      { key: 'power', label: 'EST. POWER', unit: 'W', digits: 1 },
      { key: 'stance', label: 'STANCE LEGS', digits: 0 },
      { key: 'servo', label: 'SERVOS' },
      { key: 'ik', label: 'IK' },
      { key: 'physics', label: 'PHYSICS' },
      { key: 'pose', label: 'POSE SOURCE' },
    ],
  }
}

export interface FrameExtras {
  t: number
  /** Body ground speed, m/s. */
  speed: number
  driveUtil: number
  physics: string
}

const IK_TEXT = {
  reach: Array.from({ length: 8 }, (_, i) => `OUT OF REACH ${legLabel(i)}`),
  limit: Array.from({ length: 8 }, (_, i) => `JOINT LIMIT ${legLabel(i)}`),
}

/** Overload warning, e.g. 'OVERLOAD L2 FEMUR 0.27/0.18 Nm', or 'OK'. */
export function overloadText(sim: WalkerSim): string {
  const s = sim.state
  if (s.overload < 0) return 'OK'
  const j = s.overload
  return `OVERLOAD ${legLabel(Math.floor(j / 3))} ${JOINT_NAMES[j % 3]} ${s.maxTorque.toFixed(2)}/${sim.actuator.stall.toFixed(2)} Nm`
}

/** First leg whose IK target was clamped: unreachable foot or a joint at its limit. */
export function ikText(sim: WalkerSim): string {
  for (let i = 0; i < sim.n; i++) {
    const st = sim.ikStatus[i]
    if (st === IK_OK) continue
    return st & IK_JOINT_LIMIT && !(st & ~IK_JOINT_LIMIT) ? IK_TEXT.limit[i] : IK_TEXT.reach[i]
  }
  return 'OK'
}

function poseText(sim: WalkerSim): string {
  const src = sim.poseSource === 'sim' ? 'SIM' : sim.poseSource === 'measured' ? 'MEASURED' : 'PHYSICS'
  return sim.state.belly ? `${src} · ON BELLY` : src
}

/** Reuses one TelemetryFrame; call resize() after a leg-count change. */
export class TelemetryWriter {
  readonly frame: TelemetryFrame = { t: 0, gauges: { drive: 0, stability: 0 }, channels: {}, bars: [], readouts: {} }

  constructor(n: number) {
    this.resize(n)
  }

  resize(n: number): void {
    this.frame.bars = new Array<number>(n).fill(0)
    const ch: Record<string, number> = { tqFemur: 0, tqTibia: 0, tqMax: 0, tqStall: 0 }
    for (let i = 0; i < Math.min(FOOT_LEGS, n); i++) ch[FOOT_KEYS[i]] = 0
    this.frame.channels = ch
  }

  write(sim: WalkerSim, x: FrameExtras): TelemetryFrame {
    const f = this.frame
    const s = sim.state
    const n = sim.n
    let heavy = 0
    let stance = 0
    for (let i = 0; i < n; i++) {
      if (s.load[i] > s.load[heavy]) heavy = i
      stance += s.contact[i]
      f.bars[i] = s.load[i]
    }
    const supported = s.hullCount > 0 && Number.isFinite(s.margin)
    f.t = x.t
    f.gauges.drive = Math.min(100, Math.max(0, x.driveUtil * 100))
    f.gauges.stability = supported ? Math.min(100, Math.max(0, (s.margin / sim.marginRef) * 100)) : 0
    const ch = f.channels
    ch.tqFemur = Math.abs(s.torque[heavy * 3 + 1])
    ch.tqTibia = Math.abs(s.torque[heavy * 3 + 2])
    ch.tqMax = s.maxTorque
    ch.tqStall = Number.isFinite(sim.actuator.stall) ? sim.actuator.stall : 0
    for (let i = 0; i < Math.min(FOOT_LEGS, n); i++) ch[FOOT_KEYS[i]] = s.feet[footLeg(n, i) * 3 + 2]
    const r = f.readouts
    r.margin = supported ? s.margin * 1000 : NO_SUPPORT
    r.comH = s.com[2] * 1000
    r.speed = x.speed
    r.current = s.totalCurrent
    r.power = s.power
    r.stance = stance
    r.servo = overloadText(sim)
    r.ik = ikText(sim)
    r.physics = x.physics
    r.pose = poseText(sim)
    return f
  }
}
