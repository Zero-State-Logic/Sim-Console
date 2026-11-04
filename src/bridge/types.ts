import type { HelloMsg, TelMsg, TransportId } from '../core/protocol'
import type { CommandLevel, RobotKind } from '../core/types'

/* ============================================================
   BRIDGE TYPES — shared by the link core, the transports, the
   store and the UI. No DOM, no three.js.
   ============================================================ */

/**
 * Connection state machine.
 *  idle → connecting → handshake → verify → (ready | homing) → live
 *  live → estopped (needs HOME) · any → error · link drop → disconnected
 * 'ready' = verified and idle while the drive source is not HARDWARE.
 */
export type LinkState =
  | 'idle'
  | 'connecting'
  | 'handshake'
  | 'verify'
  | 'ready'
  | 'homing'
  | 'live'
  | 'estopped'
  | 'error'
  | 'disconnected'

export type LinkErrorCode =
  | 'unsupported'
  | 'connect-failed'
  | 'hello-timeout'
  | 'proto'
  | 'mismatch'
  | 'home-timeout'
  | 'home-failed'
  | 'transport-lost'

/** What the board announced when it does not match the active module. */
export interface RobotSuggestion {
  robot: RobotKind
  joints: number
  legs?: number
  wheels?: number
  drones?: number
}

export interface LinkError {
  code: LinkErrorCode
  /** One-line headline. */
  message: string
  /** Longer guidance, shown under the headline. */
  detail?: string
  /** For 'mismatch': what the board is, so the UI can offer to switch robot. */
  suggest?: RobotSuggestion
}

export type LogDir = 'rx' | 'tx' | 'sys'
/** Optional styling tag: rx lines that were not JSON, warnings, errors. */
export type LogTag = 'invalid' | 'warn' | 'err'

export interface LogEntry {
  /** Monotonic sequence number (stable React key). */
  id: number
  /** Milliseconds, the bridge clock (performance.now based). */
  ts: number
  dir: LogDir
  text: string
  tag?: LogTag
}

/** Snapshot of the link that the store mirrors and the UI renders. */
export interface LinkStatus {
  state: LinkState
  /** A transport is open or opening (an error can leave it open: RETRY then makes sense). */
  attached: boolean
  /** Transport of the current (or last) connection, null when never connected. */
  transport: TransportId | null
  hello: HelloMsg | null
  error: LinkError | null
  /** Smoothed ping round-trip time, ms. */
  rttMs: number | null
  rxLinesPerSec: number
  txLinesPerSec: number
  rxBytesPerSec: number
  txBytesPerSec: number
  /** Average serialized size of the commands actually sent, bytes (0 before the first). */
  cmdBytes: number
  /** Commands sent since LIVE. */
  cmdCount: number
  latestTel: TelMsg | null
  /** True when verified and no tel arrived for STALE_MS. */
  stale: boolean
  /** Effective command level (override or the spec default for the transport class). */
  level: CommandLevel
  levelOverride: CommandLevel | null
  /** True while the drive source is HARDWARE. */
  sourceActive: boolean
  /** Lines dropped by the framer (too long) or the validator (bad schema). */
  droppedLines: number
}

export type TransportEventState = 'open' | 'closed' | 'error'

/**
 * Common transport interface. Transports do the NDJSON framing themselves and emit
 * complete lines (no trailing newline). write() appends the newline.
 */
export interface Transport {
  readonly id: TransportId
  isSupported(): boolean
  connect(): Promise<void>
  disconnect(): Promise<void>
  /**
   * Queue one line. `critical` lines (estop, home) are never dropped by backpressure.
   * Returns false when the line was dropped.
   */
  write(line: string, critical?: boolean): boolean
  onLine(fn: (line: string) => void): () => void
  onState(fn: (state: TransportEventState, detail?: string) => void): () => void
  /** The framer discarded a line over MAX_LINE_BYTES (`bytes` = its size). */
  onDrop?(fn: (bytes: number) => void): () => void
  /** Loopback only: re-flash the virtual board for a new robot (it re-sends hello). */
  reflash?(): void
}
