import type { HardwareSpec } from '../../core/types'

/* ============================================================
   CALIBRATION STEP SWEEP — a staircase of joint targets around
   the home pose, each held long enough for the servo to settle,
   so the fit gets static (unbiased) pairs. Every joint visits
   every level. Only for a robot on a stand: it moves all joints.
   ============================================================ */

/** Level sequence as a fraction of the amplitude; every value is visited once per cycle. */
export const SWEEP_LEVELS = [0, 1, -1, 0.5, -0.5, 0.75, -0.25, 0.25, -0.75]
export const SWEEP_DEFAULT = { amplitudeDeg: 15, holdMs: 900, cycles: 2 }

export interface SweepPlan {
  amplitudeDeg: number
  holdMs: number
  cycles: number
}

export function sweepDurationMs(plan: SweepPlan): number {
  return plan.holdMs * SWEEP_LEVELS.length * plan.cycles
}

/**
 * Joint targets (degrees) at `elapsedMs` into the sweep, written into `out`.
 * Joints are phase-shifted so they do not all jump together. Returns false when done.
 */
export function sweepTargets(spec: HardwareSpec, plan: SweepPlan, elapsedMs: number, out: number[]): boolean {
  if (elapsedMs < 0 || elapsedMs >= sweepDurationMs(plan)) return false
  const step = Math.floor(elapsedMs / plan.holdMs)
  const L = SWEEP_LEVELS.length
  for (let j = 0; j < spec.joints; j++) {
    const lim = spec.jointLimits[j] ?? [-180, 180]
    const q = (spec.homePose[j] ?? 0) + SWEEP_LEVELS[(step + j) % L] * plan.amplitudeDeg
    out[j] = Math.min(Math.max(q, lim[0]), lim[1])
  }
  out.length = spec.joints
  return true
}
