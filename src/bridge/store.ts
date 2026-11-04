import { create } from 'zustand'
import type { CalibrationResult } from './calib/fit'
import { LogRing } from './link/logRing'
import type { LinkStatus } from './types'

/* ============================================================
   BRIDGE STORE — what the UI renders. The controller publishes a
   LinkStatus snapshot (state changes at once, the rest ≤ 10 Hz).
   The serial log is a mutable ring outside React state; `logRev`
   tells readers it changed (also ≤ 10 Hz), so a 100 line/s link
   never re-renders React 100 times a second.
   ============================================================ */

export interface CalibUi {
  recording: boolean
  /** Buffers filled and recording stopped by itself. */
  full: boolean
  cmdSamples: number
  telSamples: number
  durationSec: number
  sweeping: boolean
  /** 0..1 while sweeping. */
  sweepProgress: number
  result: CalibrationResult | null
  message: string | null
}

export interface BridgeState extends LinkStatus {
  logRev: number
  canRetry: boolean
  /** Virtual device option: hidden servo mounting error for the calibration demo. */
  miscalibrate: boolean
  calib: CalibUi
}

export const CALIB_IDLE: CalibUi = {
  recording: false,
  full: false,
  cmdSamples: 0,
  telSamples: 0,
  durationSec: 0,
  sweeping: false,
  sweepProgress: 0,
  result: null,
  message: null,
}

export const INITIAL_STATUS: LinkStatus = {
  state: 'idle',
  attached: false,
  transport: null,
  hello: null,
  error: null,
  rttMs: null,
  rxLinesPerSec: 0,
  txLinesPerSec: 0,
  rxBytesPerSec: 0,
  txBytesPerSec: 0,
  cmdBytes: 0,
  cmdCount: 0,
  latestTel: null,
  stale: false,
  level: 'joint',
  levelOverride: null,
  sourceActive: false,
  droppedLines: 0,
}

/** Serial monitor history (2000 entries, oldest overwritten). */
export const bridgeLog = new LogRing()

export const useBridge = create<BridgeState>(() => ({
  ...INITIAL_STATUS,
  logRev: 0,
  canRetry: false,
  miscalibrate: true,
  calib: CALIB_IDLE,
}))
