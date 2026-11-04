import type { TransportId } from '../../core/protocol'
import type { CommandLevel, ControlDef, HardwareSpec, RobotKind } from '../../core/types'
import { BANDWIDTH_WARN, estimateBandwidth, estimateCmdBytes } from '../link/bandwidth'
import type { RobotSuggestion } from '../types'

/* ============================================================
   LINK PANEL MODEL — the bandwidth note under the level toggle,
   the "switch robot to match the board" plan, and small number
   formatters. Pure.
   ============================================================ */

export interface BandwidthNoteInput {
  spec: HardwareSpec | null
  level: CommandLevel
  transport: TransportId
  baud: number
  commandHz: number
  /** Average serialized size of the commands actually sent (0 before streaming). */
  measuredCmdBytes: number
  rxBytesPerSec: number
}

export interface BandwidthNote {
  bytesPerCmd: number
  /** True when bytesPerCmd comes from the live stream, false for the worst-case estimate. */
  measured: boolean
  utilPct: number
  rxPct: number
  warn: boolean
  text: string
  advice: string | null
}

function capacityLabel(transport: TransportId, baud: number): string {
  if (transport === 'ble') return 'BLE (~2 kB/s)'
  if (transport === 'ws') return 'WiFi (~60 kB/s)'
  return `${baud} baud`
}

export function formatBytesPerSec(bps: number): string {
  if (bps >= 10_000) return `${(bps / 1000).toFixed(0)} kB/s`
  if (bps >= 1000) return `${(bps / 1000).toFixed(1)} kB/s`
  return `${Math.round(bps)} B/s`
}

export function formatRate(perSec: number): string {
  return perSec >= 100 ? perSec.toFixed(0) : perSec.toFixed(1)
}

export function bandwidthNote(inp: BandwidthNoteInput): BandwidthNote | null {
  if (!inp.spec) return null
  const measured = inp.measuredCmdBytes > 0
  const bytesPerCmd = measured ? Math.round(inp.measuredCmdBytes) : estimateCmdBytes(inp.spec, inp.level)
  const est = estimateBandwidth({ bytesPerCmd, commandHz: inp.commandHz, transport: inp.transport, baud: inp.baud, rxBytesPerSec: inp.rxBytesPerSec })
  const utilPct = est.txUtil * 100
  const rxPct = est.rxUtil * 100
  const text = `${measured ? '' : '≤ '}${bytesPerCmd} B × ${inp.commandHz} Hz = ${formatBytesPerSec(est.txBytesPerSec)} · ${utilPct.toFixed(utilPct < 10 ? 1 : 0)} % of ${capacityLabel(inp.transport, inp.baud)}`
  let advice: string | null = null
  if (est.txUtil > BANDWIDTH_WARN) {
    const fixes = [`lower the command rate to ≤ ${Math.max(1, est.maxSafeHz)} Hz`]
    if (inp.transport === 'serial' || inp.transport === 'loopback') fixes.push('raise the baud rate')
    if (inp.level === 'joint') fixes.push('use HIGH level')
    advice = `Over ${Math.round(BANDWIDTH_WARN * 100)} % of the link: ${fixes.join(', ')}.`
  } else if (est.rxUtil > BANDWIDTH_WARN) {
    advice = `Telemetry uses ${rxPct.toFixed(0)} % of the link: lower the firmware telemetry rate.`
  }
  return { bytesPerCmd, measured, utilPct, rxPct, warn: est.warn, text, advice }
}

/* ---------------- robot mismatch → switch ---------------- */

export interface SwitchPlan {
  kind: RobotKind
  /** The module control that reshapes it (leg / drone count), when needed. */
  control: { key: string; value: string } | null
  label: string
}

const COUNT_KEY: Partial<Record<RobotKind, 'legs' | 'drones'>> = { walker: 'legs', swarm: 'drones' }

export function switchPlan(s: RobotSuggestion): SwitchPlan {
  const key = COUNT_KEY[s.robot]
  const count = key === 'legs' ? s.legs : key === 'drones' ? s.drones : undefined
  const control = key && count !== undefined ? { key, value: String(count) } : null
  const unit = key === 'legs' ? 'LEGS' : 'DRONES'
  const label = `SWITCH TO ${s.robot.toUpperCase()}${control ? ` · ${control.value} ${unit}` : ''}`
  return { kind: s.robot, control, label }
}

/** True when the module's schema can take the plan's control value (e.g. legs '4'). */
export function canApplyControl(schema: readonly ControlDef[], control: { key: string; value: string }): boolean {
  const def = schema.find((d) => d.key === control.key)
  return !!def && def.type === 'select' && def.options.some((o) => o.value === control.value)
}
