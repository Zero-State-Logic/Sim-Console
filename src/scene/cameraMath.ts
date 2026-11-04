import type { CameraPreset, Vec3Tuple, WorldConfig } from '../core/types'

/* Camera tween and follow math on plain numbers (three.js-free, unit-tested). */

export const FOLLOW_ID = 'follow'
export const TWEEN_SECONDS = 0.7
/** Follow smoothing rate, 1/s: the target closes ~63 % of the gap every 1/rate seconds. */
export const FOLLOW_RATE = 6

export function easeInOutCubic(t: number): number {
  const x = Math.min(Math.max(t, 0), 1)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

/** Frame-rate independent exponential smoothing factor. */
export function smoothingAlpha(rate: number, dt: number): number {
  if (!(dt > 0) || !(rate > 0)) return 0
  return 1 - Math.exp(-rate * dt)
}

/** Preset ids offered by the shell: the module's presets, then FOLLOW. */
export function presetIds(world: WorldConfig): string[] {
  const ids = world.cameraPresets.map((p) => p.id).filter((id) => id !== FOLLOW_ID)
  return [...ids, FOLLOW_ID]
}

export function findPreset(world: WorldConfig, id: string): CameraPreset | null {
  return world.cameraPresets.find((p) => p.id === id) ?? null
}

/**
 * A straight-down view makes the orbit camera's up vector parallel to its view direction
 * (lookAt degenerates). Nudge such a position off the vertical by a hair.
 */
export function safePresetPosition(position: Vec3Tuple, target: Vec3Tuple): Vec3Tuple {
  const dx = position[0] - target[0]
  const dz = position[2] - target[2]
  const dy = position[1] - target[1]
  const horiz = Math.hypot(dx, dz)
  if (horiz > Math.abs(dy) * 1e-3) return position
  return [position[0], position[1], target[2] + Math.max(Math.abs(dy) * 2e-3, 1e-4)]
}

/** Point on the eased tween from a to b at progress p ∈ [0, 1], written into out. */
export function tweenInto(out: Vec3Tuple, a: Vec3Tuple, b: Vec3Tuple, p: number): Vec3Tuple {
  const e = easeInOutCubic(p)
  out[0] = a[0] + (b[0] - a[0]) * e
  out[1] = a[1] + (b[1] - a[1]) * e
  out[2] = a[2] + (b[2] - a[2]) * e
  return out
}

/** Clamp a camera distance to the world zoom limits. */
export function clampDistance(d: number, world: WorldConfig): number {
  return Math.min(Math.max(d, world.minDistance), world.maxDistance)
}
