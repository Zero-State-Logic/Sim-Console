import type { ReadoutDef } from '../core/types'

/*
 * Which module readouts the viewport HUD shows (the "ROLL 0.0 PITCH 0.0" strip). Pose
 * and attitude readouts win when the module offers them; the remaining slots fill from
 * the top of the layout, and the result keeps layout order so it reads like the rail.
 */

export const HUD_READOUT_SLOTS = 4

/** Keys that describe where the robot is or how it sits, in priority order. */
export const HUD_PRIORITY_KEYS: readonly string[] = ['roll', 'pitch', 'yaw', 'hdg', 'heading', 'x', 'y', 'z', 'alt']

export function pickHudReadouts(defs: readonly ReadoutDef[], slots: number = HUD_READOUT_SLOTS): ReadoutDef[] {
  const n = Math.max(0, Math.min(Math.floor(slots), defs.length))
  if (n === 0) return []
  const chosen = new Set<number>()
  for (const key of HUD_PRIORITY_KEYS) {
    if (chosen.size >= n) break
    const i = defs.findIndex((d) => d.key === key)
    if (i >= 0) chosen.add(i)
  }
  for (let i = 0; i < defs.length && chosen.size < n; i++) chosen.add(i)
  return [...chosen].sort((a, b) => a - b).map((i) => defs[i])
}
