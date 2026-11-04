import { BOARDS } from '../../core/hardware'
import type { BoardId, TransportId } from '../../core/protocol'
import { transportSupport, type BrowserEnv } from '../link/env'

/* ============================================================
   TRANSPORT PICKER MODEL — which links the selected board offers
   (BOARDS[board].transports) plus the always-available VIRTUAL
   DEVICE, each with browser support and a reason when it is off.
   ============================================================ */

export interface TransportOption {
  id: TransportId
  label: string
  /** Glyph-free short tag for the narrow picker. */
  sub: string
  /** The board firmware supports it. */
  onBoard: boolean
  /** The browser supports it. */
  supported: boolean
  reason?: string
}

const META: Record<TransportId, { label: string; sub: string }> = {
  serial: { label: 'USB SERIAL', sub: 'web serial' },
  ble: { label: 'BLUETOOTH', sub: 'nordic uart' },
  ws: { label: 'WIFI', sub: 'websocket' },
  loopback: { label: 'VIRTUAL DEVICE', sub: 'no board' },
}

export const TRANSPORT_ORDER: readonly TransportId[] = ['serial', 'ble', 'ws', 'loopback']

export function transportLabel(id: TransportId): string {
  return META[id].label
}

/** Every transport in picker order; ones the board lacks are kept but flagged. */
export function transportOptions(board: BoardId, env: BrowserEnv): TransportOption[] {
  const offered = BOARDS[board].transports as readonly TransportId[]
  return TRANSPORT_ORDER.map((id) => {
    const onBoard = id === 'loopback' || offered.includes(id)
    const s = transportSupport(id, env)
    const reason = !onBoard ? `${BOARDS[board].label} firmware has no ${META[id].label.toLowerCase()} link.` : s.reason
    return { id, label: META[id].label, sub: META[id].sub, onBoard, supported: s.supported, reason }
  })
}

/** The picker only shows what the board can do (plus the virtual device). */
export function visibleTransports(options: readonly TransportOption[]): TransportOption[] {
  return options.filter((o) => o.onBoard)
}

/** Notices for the panel footer: APIs this browser lacks, once each. */
export function supportNotices(options: readonly TransportOption[]): string[] {
  const out: string[] = []
  for (const o of options) if (o.onBoard && !o.supported && o.reason && !out.includes(o.reason)) out.push(o.reason)
  return out
}

/**
 * Transport to keep after a board change. useHardware.setBoard resets to the board's
 * first link when the old one is not offered, which would also drop VIRTUAL DEVICE.
 */
export function transportAfterBoardChange(prev: TransportId, board: BoardId): TransportId {
  if (prev === 'loopback') return 'loopback'
  const offered = BOARDS[board].transports as readonly TransportId[]
  return offered.includes(prev) ? prev : offered[0]
}

export const BAUD_RATES: readonly number[] = [115200, 230400, 460800, 921600, 1000000, 2000000]
export const COMMAND_RATES: readonly number[] = [10, 25, 50, 100]
