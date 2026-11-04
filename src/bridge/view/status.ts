import type { LinkState } from '../types'

/* ============================================================
   LINK STATE PRESENTATION — pill label, tone and a one-line hint
   for every state of the connection state machine. Pure, so the
   mapping is tested and the panel stays declarative.
   ============================================================ */

/**
 * idle/off = grey · busy = amber (in progress) · ready = HARDWARE green ·
 * live = orange (the accent is reserved for live) · stop/error = red.
 */
export type PillTone = 'off' | 'busy' | 'ready' | 'live' | 'stop' | 'error'

export interface PillView {
  label: string
  tone: PillTone
  /** Animated dot while something is in flight. */
  pulse: boolean
  hint: string
}

const VIEWS: Record<LinkState, PillView> = {
  idle: { label: 'NO DEVICE', tone: 'off', pulse: false, hint: 'Pick a transport and CONNECT.' },
  connecting: { label: 'CONNECTING', tone: 'busy', pulse: true, hint: 'Opening the port. Choose the device in the browser dialog.' },
  handshake: { label: 'HANDSHAKE', tone: 'busy', pulse: true, hint: 'Waiting for the board to say hello (3 s).' },
  verify: { label: 'VERIFYING', tone: 'busy', pulse: true, hint: 'Checking the robot kind and joint count.' },
  ready: { label: 'READY', tone: 'ready', pulse: false, hint: 'Board verified. Drive source HARDWARE homes it, then streams.' },
  homing: { label: 'HOMING', tone: 'busy', pulse: true, hint: 'Moving to the safe pose. Waiting for the ack (5 s).' },
  live: { label: 'LIVE', tone: 'live', pulse: true, hint: 'Streaming commands. E-STOP is one click (or ESC) away.' },
  estopped: { label: 'E-STOPPED', tone: 'stop', pulse: false, hint: 'Outputs stopped. HOME to re-arm.' },
  error: { label: 'ERROR', tone: 'error', pulse: false, hint: 'See the message below.' },
  disconnected: { label: 'LINK LOST', tone: 'error', pulse: false, hint: 'The board dropped off. Its watchdog holds or relaxes the servos.' },
}

export function pillView(state: LinkState, stale: boolean): PillView {
  const v = VIEWS[state]
  if (stale && (state === 'live' || state === 'ready' || state === 'homing')) {
    return { ...v, label: `${v.label} · STALE`, tone: state === 'live' ? 'live' : 'busy', hint: 'No telemetry for 500 ms: the board may be stuck or the link congested.' }
  }
  return v
}

/** States in which a transport is open and the user can disconnect. */
export function isOpen(state: LinkState): boolean {
  return state !== 'idle' && state !== 'disconnected' && state !== 'connecting'
}

/**
 * E-STOP is offered whenever a port is open: also from an error (a home that timed out may
 * still be moving) and while latched (pressing again re-sends it in case a line was lost).
 */
export function canEstop(state: LinkState): boolean {
  return isOpen(state)
}

/**
 * ESC fires E-STOP while the robot is (or may be) moving. Not in the calmer states, where ESC
 * mostly closes a dialog and an E-STOP would wipe guidance such as a mismatch explanation.
 */
export function escEstops(state: LinkState, errorCode: string | null): boolean {
  if (state === 'live' || state === 'homing') return true
  return state === 'error' && (errorCode === 'home-timeout' || errorCode === 'home-failed')
}

/** HOME is offered once the board is verified (also to re-arm or retry a failed home). */
export function canHome(state: LinkState, errorCode: string | null): boolean {
  if (state === 'ready' || state === 'estopped' || state === 'live') return true
  return state === 'error' && (errorCode === 'home-timeout' || errorCode === 'home-failed')
}
