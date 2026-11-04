/* Pure layout and formatting helpers for the shell chrome. */

export const DRAWER_MIN_PX = 180
export const DRAWER_MAX_VH = 0.75
export const DRAWER_DEFAULT_PX = 300

/** Tallest the drawer may get: 75 % of the viewport, never below the minimum. */
export function drawerMaxPx(viewportH: number): number {
  return Math.max(DRAWER_MIN_PX, Math.floor(viewportH * DRAWER_MAX_VH))
}

/** Drawer height clamped to [180 px, 75 % of the viewport]. */
export function clampDrawerHeight(px: number, viewportH: number): number {
  const max = drawerMaxPx(viewportH)
  if (!Number.isFinite(px)) return Math.min(DRAWER_DEFAULT_PX, max)
  return Math.round(Math.min(Math.max(px, DRAWER_MIN_PX), max))
}

/** Sim clock: MM:SS.d, or H:MM:SS.d past an hour. */
export function formatClock(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? sec : 0
  const tenths = Math.floor(s * 10)
  const d = tenths % 10
  const whole = Math.floor(tenths / 10)
  const ss = String(whole % 60).padStart(2, '0')
  const totalMin = Math.floor(whole / 60)
  if (totalMin < 60) return `${String(totalMin).padStart(2, '0')}:${ss}.${d}`
  return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}:${ss}.${d}`
}

/** Short duration for the timeline, e.g. 4.2 s or 1:05. */
export function formatDuration(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? sec : 0
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

export const SPEED_STEPS: readonly number[] = [0.25, 0.5, 1, 2]

export function formatSpeed(s: number): string {
  return `${s === 0.25 ? '¼' : s === 0.5 ? '½' : String(s)}×`
}
