import type { HardwareConfig } from '../core/hardware'

/* ============================================================
   SERVO MAP — the per-joint constants the firmware uses so its
   output is identical to jointToServoDeg / servoDegToUs in
   src/core/hardware.ts:
     servoDeg = center + gain * jointDeg      (center = range/2 + offset, gain = dir * scale)
     us       = round(minUs + clamp01(servoDeg / range) * (maxUs - minUs))
   ============================================================ */

export interface ServoTable {
  center: number[]
  gain: number[]
  rangeDeg: number
  minUs: number
  maxUs: number
}

export function servoTable(hw: HardwareConfig, joints: number): ServoTable {
  const center: number[] = []
  const gain: number[] = []
  for (let j = 0; j < joints; j++) {
    const dir = hw.jointInvert[j] ? -1 : 1
    center.push(hw.servoRangeDeg / 2 + (hw.jointOffsetDeg[j] ?? 0))
    gain.push(dir * (hw.jointScale[j] ?? 1))
  }
  return { center, gain, rangeDeg: hw.servoRangeDeg, minUs: hw.servoMinUs, maxUs: hw.servoMaxUs }
}

/** What the generated firmware computes for one joint (reference model for tests and docs). */
export function tableToUs(t: ServoTable, joint: number, jointDeg: number): number {
  const servoDeg = t.center[joint] + t.gain[joint] * jointDeg
  const f = Math.min(Math.max(servoDeg / t.rangeDeg, 0), 1)
  return Math.round(t.minUs + f * (t.maxUs - t.minUs))
}

/** PCA9685 at 50 Hz: integer form of usToPcaTicks, exactly what the firmware does. */
export function pcaTicksInt(us: number): number {
  return Math.floor((Math.round(us) * 2048 + 5000) / 10000)
}

/** PCA9685 board address for a channel (0-15 → 0x40, 16-31 → 0x41). */
export function pcaAddress(channel: number): number {
  return channel >= 16 ? 0x41 : 0x40
}

export function hex2(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(2, '0')}`
}
